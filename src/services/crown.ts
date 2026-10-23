// Crown of the week (SPEC §6). Awarded right after the week's first reshuffle to
// the top member of the new VIP list, once per week (a JobRun keyed by the week's
// Monday). Losing VIP takes the Crown and the custom role with it; the Crown isn't
// given to anyone else until next week. Custom role settings are kept, so the
// role is recreated if they win again.
import { GuildPremiumTier, type Client, type Guild, type Role } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { checkCustomRole, MAX_CUSTOM_ROLE_EDITS, pickCrown, type CustomRoleCheck, type CustomRoleInput } from '../core/crown.js';
import type { ReshuffleResult } from '../core/reshuffle.js';
import { serverDayAt, weekStartOf } from '../core/serverDay.js';
import { parseHexColour } from '../core/vipRules.js';
import type { Db } from '../db/prisma.js';
import type { CrownHolder, CustomRole } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import { claimJob, completeJob, failJob } from './jobs.js';
import type { ModLog } from './modLog.js';
import { explainRoleError, placeNextTo, type RoleQueue } from './roleQueue.js';
import { findExistingRole } from './reuse.js';

export const CROWN_JOB = 'crown';
const DRAFT_MINUTES = 15;

export interface FormPrefill {
  name: string;
  hex: string;
  emoji: string;
}

export type FormAccess = { ok: true; prefill: FormPrefill | null } | { ok: false; message: string };

/** Runs after a new Crown is saved; `previous` is last week's holder, if any. */
export type CrownAwardedHook = (holder: CrownHolder, previous: CrownHolder | null) => Promise<void>;
/** Runs after a Crown ends. `continuing`: the same member holds the new week's Crown. */
export type CrownEndedHook = (holder: CrownHolder, why: string, continuing: boolean) => Promise<void>;

export class CrownService {
  /** Crown powers: titles, nickname (crownPowers.ts). */
  readonly onAwarded: CrownAwardedHook[] = [];
  readonly onEnded: CrownEndedHook[] = [];

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly roles: RoleQueue,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  #guild(): Guild | undefined {
    return this.client.guilds.cache.get(this.guildId);
  }

  #week(now = this.clock.now()): string {
    return weekStartOf(serverDayAt(now, this.config.current.boundary).key);
  }

  /** The current Crown holder, if anyone holds it. */
  current(): Promise<CrownHolder | null> {
    return this.db.crownHolder.findFirst({ where: { endedAt: null }, orderBy: { awardedAt: 'desc' } });
  }

  /** Reshuffle hook: the week's first reshuffle awards the Crown. Returns the winner. */
  async afterReshuffle(today: string, result: ReshuffleResult): Promise<string | null> {
    const week = weekStartOf(today);
    const now = this.clock.now();
    if (!(await claimJob(this.db, CROWN_JOB, week, now))) return null;
    const winner = pickCrown(result);
    let prev: CrownHolder | null = null;
    try {
      const previous = (prev = await this.current());
      await this.db.$transaction(async (tx) => {
        if (previous) await tx.crownHolder.update({ where: { id: previous.id }, data: { endedAt: now, endReason: 'week ended' } });
        if (winner) {
          await tx.crownHolder.create({ data: { userId: winner, weekStart: week, awardedAt: now } });
          await tx.auditLog.create({ data: { action: 'crown.award', targetId: winner, data: { week } } });
        }
        await completeJob(tx, CROWN_JOB, week, { winner, previous: previous?.userId ?? null }, now);
      });
    } catch (err) {
      await failJob(this.db, CROWN_JOB, week, err instanceof Error ? err.message : String(err), this.clock.now()).catch(() => undefined);
      throw err;
    }
    // Saved: from here on, failures are logged and fixed by reconcile, never retried.
    try {
      if (prev && prev.userId !== winner) await this.#takeAway(prev.userId, 'the week ended');
      const ended = prev;
      if (ended) await this.#runHooks(this.onEnded.map((h) => () => h(ended, 'the week ended', ended.userId === winner)));
      if (winner) {
        await this.#give(winner);
        const holder = await this.current();
        if (holder) await this.#runHooks(this.onAwarded.map((h) => () => h(holder, prev)));
        await this.modLog.post(`👑 Crown of the week (from ${week}): <@${winner}>`);
      } else {
        await this.modLog.post(`👑 No Crown this week (from ${week}): no VIPs.`);
      }
    } catch (err) {
      this.log.error({ err }, 'applying the new Crown failed; reconcile fixes roles on the next startup');
    }
    return winner;
  }

  async #runHooks(hooks: (() => Promise<void>)[]): Promise<void> {
    for (const hook of hooks) await hook().catch((err: unknown) => this.log.error({ err }, 'Crown hook failed'));
  }

  /** VIP removal hook: the Crown goes with VIP, and isn't reassigned until next week. */
  async onVipRemoved(userId: string, reason: string): Promise<void> {
    const cur = await this.current();
    if (cur?.userId !== userId) return;
    await this.db.$transaction([
      this.db.crownHolder.update({ where: { id: cur.id }, data: { endedAt: this.clock.now(), endReason: `lost VIP: ${reason}` } }),
      this.db.auditLog.create({ data: { action: 'crown.lost', targetId: userId, reason } }),
    ]);
    await this.#takeAway(userId, `lost VIP (${reason})`);
    await this.#runHooks(this.onEnded.map((h) => () => h(cur, `lost VIP (${reason})`, false)));
  }

  /**
   * /vip crown-give: an admin gives this week's Crown to a VIP (for testing, or to
   * fix a mistake). The current holder loses it the usual way; the new holder gets
   * everything a weekly winner gets. It lasts until the next week's award.
   */
  async giveManually(userId: string, actorId: string): Promise<string> {
    const cur = await this.current();
    if (cur?.userId === userId) return `<@${userId}> already holds the Crown.`;
    const now = this.clock.now();
    const week = this.#week(now);
    if (cur) {
      await this.db.$transaction([
        this.db.crownHolder.update({ where: { id: cur.id }, data: { endedAt: now, endReason: `replaced by <@${actorId}>` } }),
        this.db.auditLog.create({ data: { action: 'crown.lost', actorId, targetId: cur.userId, reason: 'replaced by an admin' } }),
      ]);
      await this.#takeAway(cur.userId, 'an admin gave the Crown to someone else');
      await this.#runHooks(this.onEnded.map((h) => () => h(cur, 'was given to someone else', false)));
    }
    // One row per week: reuse this week's row if the Crown was already awarded.
    const holder = await this.db.$transaction(async (tx) => {
      const row = await tx.crownHolder.upsert({
        where: { weekStart: week },
        create: { userId, weekStart: week, awardedAt: now },
        update: { userId, awardedAt: now, endedAt: null, endReason: null, decreeAt: null, nickApplied: false, nickBefore: null },
      });
      await tx.auditLog.create({ data: { action: 'crown.give', actorId, targetId: userId, data: { week } } });
      return row;
    });
    // If this week's award hasn't run yet, mark it done so a reshuffle doesn't replace this.
    if (await claimJob(this.db, CROWN_JOB, week, now)) {
      await this.db.$transaction((tx) => completeJob(tx, CROWN_JOB, week, { winner: userId, previous: cur?.userId ?? null, manual: true }, now));
    }
    await this.#give(userId);
    await this.#runHooks(this.onAwarded.map((h) => () => h(holder, null)));
    await this.modLog.post(`👑 <@${actorId}> gave the Crown (week of ${week}) to <@${userId}>`);
    return `👑 <@${userId}> now holds the Crown until next week's award.`;
  }

  async #give(userId: string): Promise<void> {
    const crownRoleId = this.config.current.guild.crownRoleId;
    if (crownRoleId) {
      const res = await this.roles.run({ userId, roleId: crownRoleId, action: 'add', reason: 'Crown of the week' });
      if (!res.ok) await this.modLog.post(`⚠️ Crown role not given to <@${userId}>: ${res.error}`);
    }
    const custom = await this.db.customRole.findUnique({ where: { userId } });
    if (custom?.name && !custom.locked && !custom.roleId) {
      const err = await this.#applyCustomRole(userId, custom);
      await this.modLog.post(err ? `⚠️ Couldn't recreate <@${userId}>'s custom role: ${err}` : `👑 Recreated <@${userId}>'s custom role "${custom.name}"`);
    }
  }

  async #takeAway(userId: string, why: string): Promise<void> {
    const crownRoleId = this.config.current.guild.crownRoleId;
    if (crownRoleId) await this.roles.run({ userId, roleId: crownRoleId, action: 'remove', reason: `Crown ended: ${why}` });
    const deleted = await this.#deleteCustomRole(userId, `Crown ended: ${why}`);
    await this.modLog.post(`👑 Crown removed from <@${userId}>: ${why}${deleted ? ' (custom role deleted, settings saved)' : ''}`);
  }

  /** Deletes the Discord role, keeps the settings. Returns whether there was a role. */
  async #deleteCustomRole(userId: string, reason: string): Promise<boolean> {
    const custom = await this.db.customRole.findUnique({ where: { userId } });
    if (!custom?.roleId) return false;
    const role = this.#guild()?.roles.cache.get(custom.roleId);
    await role?.delete(reason).catch((err: unknown) => this.log.warn({ err }, "couldn't delete custom role"));
    await this.db.customRole.update({ where: { userId }, data: { roleId: null } });
    return true;
  }

  /** Creates or updates the member's custom role from saved settings, directly above the Crown role. */
  async #applyCustomRole(userId: string, custom: Pick<CustomRole, 'name' | 'hex' | 'emoji' | 'roleId'>): Promise<string | null> {
    const guild = this.#guild();
    if (!guild) return 'the bot is not in the server';
    const crownRole = this.config.current.guild.crownRoleId ? guild.roles.cache.get(this.config.current.guild.crownRoleId) : undefined;
    const colour = parseHexColour(custom.hex) ?? 0xffffff;
    const icon = custom.emoji && guild.premiumTier >= GuildPremiumTier.Tier2 ? { unicodeEmoji: custom.emoji } : {};
    try {
      let role: Role | undefined = custom.roleId ? guild.roles.cache.get(custom.roleId) : undefined;
      if (role) await role.edit({ name: custom.name, colors: { primaryColor: colour }, ...icon, reason: 'Crown custom role edited' });
      else {
        role = await guild.roles.create({ name: custom.name, colors: { primaryColor: colour }, hoist: false, mentionable: false, permissions: [], ...icon, reason: 'Crown custom role' });
        await this.db.customRole.update({ where: { userId }, data: { roleId: role.id } });
      }
      if (crownRole) {
        await placeNextTo(guild, role.id, crownRole.id, 'above').catch((err: unknown) => this.log.warn({ err }, "couldn't move the custom role"));
      }
      const res = await this.roles.run({ userId, roleId: role.id, action: 'add', reason: 'Crown custom role' });
      return res.ok ? null : res.error;
    } catch (err) {
      return explainRoleError(err);
    }
  }

  /** Who may open the custom role form, with what filled in. */
  async formAccess(userId: string): Promise<FormAccess> {
    const cur = await this.current();
    if (cur?.userId !== userId) return { ok: false, message: '👑 Only this week’s Crown holder can create a custom role.' };
    const custom = await this.db.customRole.findUnique({ where: { userId } });
    if (custom?.locked) return { ok: false, message: 'Custom roles are locked for you by the admins.' };
    const now = this.clock.now();
    await this.db.modalDraft.deleteMany({ where: { expiresAt: { lte: now } } });
    const draft = await this.db.modalDraft.findUnique({ where: { userId } });
    const prefill = (draft?.data as FormPrefill | undefined) ?? (custom ? { name: custom.name, hex: custom.hex, emoji: custom.emoji ?? '' } : null);
    return { ok: true, prefill };
  }

  /** Form submitted. Errors are saved as a draft for "Try again". */
  async submit(userId: string, input: CustomRoleInput): Promise<{ ok: true; message: string } | { ok: false; errors: string[] }> {
    const access = await this.formAccess(userId);
    if (!access.ok) return { ok: false, errors: [access.message] };
    const guild = this.#guild();
    if (!guild) return { ok: false, errors: ['The bot is not in the server.'] };

    const week = this.#week();
    const custom = await this.db.customRole.findUnique({ where: { userId } });
    const staffIds = new Set((await this.db.staffRole.findMany()).map((s) => s.roleId));
    const blocked = (await this.db.blockedWord.findMany()).map((w) => w.word);
    const isEdit = !!custom?.roleId;
    const editsUsed = custom?.editsWeek === week ? custom.editsCount : 0;

    const check: CustomRoleCheck = checkCustomRole(input, {
      otherRoleNames: guild.roles.cache.filter((r) => r.id !== custom?.roleId && r.id !== guild.id).map((r) => r.name),
      staffRoleNames: guild.roles.cache.filter((r) => staffIds.has(r.id)).map((r) => r.name),
      blockedWords: blocked,
      roleIconsAllowed: guild.premiumTier >= GuildPremiumTier.Tier2,
      isEdit,
      editsUsedThisWeek: editsUsed,
      maxEditsPerWeek: MAX_CUSTOM_ROLE_EDITS,
    });
    if (!check.ok) {
      const expiresAt = new Date(this.clock.now().getTime() + DRAFT_MINUTES * 60_000);
      const data = { name: input.name, hex: input.hex, emoji: input.emoji } satisfies FormPrefill;
      await this.db.modalDraft.upsert({ where: { userId }, create: { userId, data, expiresAt }, update: { data, expiresAt } });
      return { ok: false, errors: check.errors };
    }

    const v = check.value;
    const editsCount = isEdit ? editsUsed + 1 : editsUsed;
    await this.db.$transaction([
      this.db.customRole.upsert({
        where: { userId },
        create: { userId, name: v.name, hex: v.hex, emoji: v.emoji, editsWeek: week, editsCount },
        update: { name: v.name, hex: v.hex, emoji: v.emoji, editsWeek: week, editsCount },
      }),
      this.db.modalDraft.deleteMany({ where: { userId } }),
      this.db.auditLog.create({ data: { action: isEdit ? 'crown.role.edit' : 'crown.role.create', actorId: userId, targetId: userId, data: { ...v } } }),
    ]);
    const err = await this.#applyCustomRole(userId, { name: v.name, hex: v.hex, emoji: v.emoji, roleId: custom?.roleId ?? null });
    await this.modLog.post(`👑 <@${userId}> ${isEdit ? 'edited' : 'created'} their custom role: "${v.name}" ${v.hex}${v.emoji ? ` ${v.emoji}` : ''}${err ? `\n⚠️ ${err}` : ''}`);
    if (err) return { ok: false, errors: [`Saved, but the role couldn't be made: ${err}`] };
    const left = MAX_CUSTOM_ROLE_EDITS - editsCount;
    return {
      ok: true,
      message: [
        `✅ Your role **${v.name}** is ${isEdit ? 'updated' : 'ready'}!`,
        v.emojiIgnored ? 'ℹ️ The emoji icon needs Server Boost Level 2, so it was left off.' : '',
        `Edits left this week: ${left}.`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  /** /vip crown-reset: delete the role and its saved settings. */
  async resetRole(userId: string, actorId: string): Promise<boolean> {
    const deleted = await this.#deleteCustomRole(userId, `Reset by ${actorId}`);
    const { count } = await this.db.customRole.deleteMany({ where: { userId } });
    await this.db.auditLog.create({ data: { action: 'crown.role.reset', actorId, targetId: userId } });
    if (deleted || count) await this.modLog.post(`👑 <@${actorId}> reset <@${userId}>'s custom role`);
    return deleted || count > 0;
  }

  /** /vip crown-lock: block or allow custom role creation and edits. */
  async setLocked(userId: string, locked: boolean, actorId: string): Promise<void> {
    await this.db.$transaction([
      this.db.customRole.upsert({
        where: { userId },
        create: { userId, name: '', hex: '#FFFFFF', locked },
        update: { locked },
      }),
      this.db.auditLog.create({ data: { action: locked ? 'crown.lock' : 'crown.unlock', actorId, targetId: userId } }),
    ]);
    await this.modLog.post(`👑 <@${actorId}> ${locked ? 'locked' : 'unlocked'} custom roles for <@${userId}>`);
  }

  /** Startup: only the current holder has the Crown role and a custom role. */
  async reconcile(): Promise<void> {
    const guild = this.#guild();
    const crownRoleId = this.config.current.guild.crownRoleId;
    if (!guild) return;
    const cur = await this.current();
    if (cur && !guild.members.cache.has(cur.userId)) {
      await this.onVipRemoved(cur.userId, 'left the server');
      return this.reconcile();
    }
    if (crownRoleId) {
      const role = guild.roles.cache.get(crownRoleId);
      for (const id of role?.members.keys() ?? []) {
        if (id !== cur?.userId) await this.roles.run({ userId: id, roleId: crownRoleId, action: 'remove', reason: 'Not the Crown holder' });
      }
      if (cur && role && !role.members.has(cur.userId)) await this.roles.run({ userId: cur.userId, roleId: crownRoleId, action: 'add', reason: 'Crown holder' });
    }
    for (const custom of await this.db.customRole.findMany({ where: { roleId: { not: null } } })) {
      if (custom.userId !== cur?.userId) await this.#deleteCustomRole(custom.userId, 'Not the Crown holder');
    }
    await this.db.modalDraft.deleteMany({ where: { expiresAt: { lte: this.clock.now() } } });
  }

  /** /bot setup: the Crown role, above the colour roles (SPEC §12). */
  async setup(guild: Guild, vipRole: Role, report: string[]): Promise<void> {
    const cfg = this.config.current.guild;
    const colour = parseHexColour(cfg.crownColour) ?? 0xff00c8;
    let role = cfg.crownRoleId ? guild.roles.cache.get(cfg.crownRoleId) : undefined;
    try {
      if (!role) {
        // Take over an existing Crown role rather than making a second one.
        role = await findExistingRole(guild, this.db, cfg, ['👑 Crown', 'Crown']);
        if (role) {
          await this.db.guildConfig.update({ where: { guildId: guild.id }, data: { crownRoleId: role.id } });
          await this.config.load();
          report.push(`♻️ Using the existing ${role.toString()} role for the Crown`);
        }
      }
      if (role) await role.edit({ colors: { primaryColor: colour }, hoist: true, mentionable: false, reason: '/bot setup' });
      else {
        role = await guild.roles.create({ name: '👑 Crown', colors: { primaryColor: colour }, hoist: true, mentionable: false, permissions: [], reason: '/bot setup' });
        await this.db.guildConfig.update({ where: { guildId: guild.id }, data: { crownRoleId: role.id } });
        await this.config.load();
      }
      const colourRoleIds = (await this.db.colourOption.findMany()).map((o) => o.roleId).filter((id): id is string => !!id);
      await guild.roles.fetch();
      const highest = [vipRole.id, ...colourRoleIds]
        .map((id) => guild.roles.cache.get(id))
        .filter((r): r is Role => !!r)
        .reduce((a, b) => (b.position > a.position ? b : a));
      await placeNextTo(guild, role.id, highest.id, 'above');
      report.push(`✅ Crown role ${role.toString()} ready`);
    } catch (err) {
      report.push(`❌ Crown role: ${explainRoleError(err)}`);
    }
    await this.reconcile();
  }
}
