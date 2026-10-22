// VIP history badges (SPEC §7): permanent, colourless, not hoisted roles for
// reaching 4, 12 and 26 weeks of (unpinned) VIP time. Checked at every reshuffle;
// new ones are mentioned in that day's VIP update post.
import type { Client, Guild, Role } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { DEFAULT_BADGES, newBadges, unpinnedWeeks } from '../core/badges.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { ModLog } from './modLog.js';
import { explainRoleError, type RoleQueue } from './roleQueue.js';

export interface BadgeAward {
  userId: string;
  badgeId: number;
  name: string;
  roleId: string | null;
}

export class BadgeService {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly roles: RoleQueue,
    private readonly modLog: ModLog,
    private readonly log: Logger,
  ) {}

  /** Badges people have reached by `now` and don't have yet. */
  async pending(now: Date): Promise<BadgeAward[]> {
    const [milestones, stints, owned] = await Promise.all([
      this.db.badge.findMany(),
      this.db.vipStint.findMany({ select: { userId: true, startedAt: true, endedAt: true, pinned: true } }),
      this.db.userBadge.findMany({ select: { userId: true, badgeId: true } }),
    ]);
    if (!milestones.length) return [];
    const byUser = new Map<string, typeof stints>();
    for (const s of stints) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
    const ownedBy = new Map<string, Set<number>>();
    for (const o of owned) ownedBy.set(o.userId, (ownedBy.get(o.userId) ?? new Set()).add(o.badgeId));

    const awards: BadgeAward[] = [];
    for (const [userId, list] of [...byUser].sort(([a], [b]) => (a < b ? -1 : 1))) {
      for (const m of newBadges(unpinnedWeeks(list, now), milestones, ownedBy.get(userId) ?? new Set())) {
        awards.push({ userId, badgeId: m.id, name: m.name, roleId: milestones.find((x) => x.id === m.id)?.roleId ?? null });
      }
    }
    return awards;
  }

  /** After the awards are saved: give the roles and log them. */
  async applyRoles(awards: readonly BadgeAward[]): Promise<void> {
    for (const a of awards) {
      const res = a.roleId ? await this.roles.run({ userId: a.userId, roleId: a.roleId, action: 'add', reason: `Badge: ${a.name}` }) : { ok: true as const };
      await this.modLog.post(`🏅 <@${a.userId}> earned **${a.name}**${res.ok ? '' : `\n⚠️ Role not given: ${res.error}`}`);
    }
  }

  async weeksHeld(userId: string, now: Date): Promise<number> {
    return unpinnedWeeks(await this.db.vipStint.findMany({ where: { userId } }), now);
  }

  /** /setup run: add the default milestones once, then create or repair the badge roles. */
  async setup(guild: Guild, _vipRole: Role, report: string[]): Promise<void> {
    if (!this.config.current.guild.badgesSeeded) {
      if ((await this.db.badge.count()) === 0) await this.db.badge.createMany({ data: [...DEFAULT_BADGES] });
      await this.db.guildConfig.update({ where: { guildId: guild.id }, data: { badgesSeeded: true } });
      await this.config.load();
    }
    let ready = 0;
    for (const badge of await this.db.badge.findMany({ orderBy: { weeks: 'asc' } })) {
      try {
        let role = badge.roleId ? guild.roles.cache.get(badge.roleId) : undefined;
        if (role) {
          if (role.name !== badge.name || role.hoist || role.colors.primaryColor !== 0) {
            await role.edit({ name: badge.name, hoist: false, colors: { primaryColor: 0 }, reason: 'VIP badge' });
          }
        } else {
          role = await guild.roles.create({ name: badge.name, hoist: false, mentionable: false, permissions: [], reason: 'VIP badge' });
          await this.db.badge.update({ where: { id: badge.id }, data: { roleId: role.id } });
        }
        // Just above @everyone, below the level roles (SPEC §12).
        if (role.position !== 1) await role.setPosition(1, { reason: 'Badges go below the level roles' });
        ready++;
      } catch (err) {
        report.push(`❌ Badge role ${badge.name}: ${explainRoleError(err)}`);
      }
    }
    report.push(`✅ ${ready} badge roles ready`);
    await this.reconcile();
  }

  /** Badge roles match saved badges (badges are permanent, so only missing roles are given). */
  async reconcile(): Promise<void> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) return;
    const earned = await this.db.userBadge.findMany({ include: { badge: true } });
    for (const e of earned) {
      const member = guild.members.cache.get(e.userId);
      if (member && e.badge.roleId && !member.roles.cache.has(e.badge.roleId)) {
        await this.roles.run({ userId: e.userId, roleId: e.badge.roleId, action: 'add', reason: `Badge: ${e.badge.name}` });
      }
    }
  }

  async set(weeks: number, name: string, actorId: string): Promise<string> {
    const clash = await this.db.badge.findUnique({ where: { name } });
    if (clash && clash.weeks !== weeks) return `❌ The ${clash.weeks}-week badge is already called ${name}.`;
    const existing = await this.db.badge.findUnique({ where: { weeks } });
    await this.db.badge.upsert({ where: { weeks }, create: { weeks, name }, update: { name } });
    await this.db.auditLog.create({ data: { action: 'badge.set', actorId, data: { weeks, name } } });
    return existing ? `✅ The ${weeks}-week badge is now **${name}**.` : `✅ New badge: **${name}** at ${weeks} weeks. Members who already qualify get it at the next reshuffle.`;
  }

  async remove(weeks: number, actorId: string): Promise<string> {
    const badge = await this.db.badge.findUnique({ where: { weeks } });
    if (!badge) return `❌ No badge at ${weeks} weeks.`;
    if (badge.roleId) {
      await this.client.guilds.cache
        .get(this.guildId)
        ?.roles.cache.get(badge.roleId)
        ?.delete('Badge removed')
        .catch((err: unknown) => this.log.warn({ err }, "couldn't delete badge role"));
    }
    await this.db.badge.delete({ where: { id: badge.id } });
    await this.db.auditLog.create({ data: { action: 'badge.remove', actorId, data: { weeks, name: badge.name } } });
    await this.modLog.post(`🏅 Badge **${badge.name}** (${weeks} weeks) removed by <@${actorId}>`);
    return `✅ Removed **${badge.name}**. Its role was deleted and nobody has it anymore.`;
  }
}
