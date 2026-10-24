// Runs VIP for real (SPEC §3, §4, §11): the daily reshuffle, the one shared VIP
// removal routine, pinning, and keeping Discord roles matched to the database.
//
// Order for every change: the database is updated first (in one transaction),
// then roles are applied through the queue, then the mod-log and announcement are
// posted. If the bot dies in between, reconciliation fixes the roles and pending
// announcements are posted on the next startup.
import type { Client, Guild, GuildMember, PartialGuildMember } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { formatVipUpdate, type Announcement } from '../core/announcement.js';
import {
  computeReshuffle,
  describeAdd,
  describeRemove,
  pairAnnouncements,
  type Candidate,
  type ReshuffleInput,
  type ReshuffleResult,
  warmupDaysLeft,
} from '../core/reshuffle.js';
import { serverDayAt, serverDaysBetween } from '../core/serverDay.js';
import { eligibilityOf, roleDrift } from '../core/vipRules.js';
import { loadStandings, namesFor } from '../db/activityRepo.js';
import type { Db } from '../db/prisma.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';
import type { ActivityBuffer } from './activityBuffer.js';
import type { BadgeService } from './badges.js';
import type { Clock } from './clock.js';
import { claimJob, completeJob, failJob } from './jobs.js';
import type { ModLog } from './modLog.js';
import type { RoleQueue } from './roleQueue.js';

type Tx = Prisma.TransactionClient;

export interface VipState {
  since: string;
  pinned: boolean;
}

/** Later phases add cleanup here (colour, Crown, custom role, temp voice). */
export type VipRemovedHook = (userId: string, reason: string) => Promise<void>;
/** Runs after someone gets VIP (e.g. restore their saved colour). */
export type VipAddedHook = (userId: string) => Promise<void>;
/** Runs after a reshuffle is saved and applied (e.g. the weekly Crown). */
export type ReshuffledHook = (today: string, result: ReshuffleResult) => Promise<void>;

export interface ReshuffleRun {
  status: 'done' | 'skipped';
  message: string;
  result?: ReshuffleResult;
}

interface StoredDetail {
  added: { userId: string; reason: string }[];
  removed: { userId: string; reason: string }[];
  badges?: { userId: string; badgeId: number; name: string }[];
  announcement: Announcement | null;
  posted: boolean;
  /** Set when a scheduled run was skipped during warm-up. */
  warmupDaysLeft?: number;
}

export const RESHUFFLE_JOB = 'reshuffle';
export const MANUAL_RESHUFFLE_JOB = 'reshuffle-manual';

export class VipService {
  #vips = new Map<string, VipState>();
  readonly onRemoved: VipRemovedHook[] = [];
  readonly onAdded: VipAddedHook[] = [];
  readonly onReshuffled: ReshuffledHook[] = [];
  /** Set when history badges are enabled (Phase 7); new badges are saved with each reshuffle. */
  badges: BadgeService | null = null;
  /** Set when AI chat is enabled (Phase 9): one hype line for the top of the VIP update. Numbers stay code-written. */
  hype: ((summary: string) => Promise<string | null>) | null = null;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly buffer: ActivityBuffer,
    private readonly roles: RoleQueue,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    const rows = await this.db.vipMember.findMany();
    this.#vips = new Map(rows.map((r) => [r.userId, { since: r.since, pinned: r.pinned }]));
  }

  get vips(): ReadonlyMap<string, VipState> {
    return this.#vips;
  }

  #guild(): Guild {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error('the bot is not in the server');
    return guild;
  }

  #today(now: Date): string {
    return serverDayAt(now, this.config.current.boundary).key;
  }

  /** Everything the reshuffle needs, read fresh from the database and Discord. */
  async buildInput(now: Date): Promise<{ input: ReshuffleInput; standingsWindow: string[] }> {
    const cfg = this.config.current;
    const guild = this.#guild();
    const { window, ranked } = await loadStandings(this.db, cfg, now);
    const scores = new Map(ranked.map((s) => [s.userId, s]));
    const ids = [...new Set([...scores.keys(), ...this.#vips.keys()])];

    const since = new Date(now.getTime() - cfg.guild.timeoutBlockDays * 86_400_000);
    const [lastActive, staff, blocks, timeouts] = await Promise.all([
      this.db.activityDay.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, OR: [{ weightedMessages: { gt: 0 } }, { voiceMinutes: { gt: 0 } }] },
        _max: { serverDay: true },
      }),
      this.db.staffRole.findMany(),
      this.db.vipBlock.findMany({ where: { userId: { in: ids }, until: { gt: now } } }),
      this.db.timeoutEvent.findMany({
        where: { userId: { in: ids }, endedAt: { gt: since }, startedAt: { lte: now } },
        select: { userId: true },
      }),
    ]);
    const lastActiveDay = new Map(lastActive.map((r) => [r.userId, r._max.serverDay]));
    const staffRoleIds = new Set(staff.map((s) => s.roleId));
    const blocked = new Set(blocks.map((b) => b.userId));
    const timedOut = new Set(timeouts.map((t) => t.userId));

    const candidates: Candidate[] = ids.map((userId) => {
      const s = scores.get(userId);
      const member = guild.members.cache.get(userId);
      return {
        userId,
        score: s?.score ?? 0,
        activeDays: s?.activeDays ?? 0,
        lastDayScore: s?.lastDayScore ?? 0,
        lastActiveDay: lastActiveDay.get(userId) ?? null,
        eligibility: eligibilityOf({
          inGuild: !!member,
          isBot: member?.user.bot ?? false,
          roleIds: member ? [...member.roles.cache.keys()] : [],
          staffRoleIds,
          timedOutRecently: (member?.isCommunicationDisabled() ?? false) || timedOut.has(userId),
          blocked: blocked.has(userId),
        }),
      };
    });

    return {
      standingsWindow: window,
      input: {
        today: this.#today(now),
        candidates,
        currentVips: [...this.#vips].map(([userId, v]) => ({ userId, since: v.since })),
        pinned: new Set([...this.#vips].filter(([, v]) => v.pinned).map(([id]) => id)),
        config: cfg.reshuffle,
      },
    };
  }

  /** What a reshuffle would do right now, without changing anything. */
  async preview(now = this.clock.now()): Promise<ReshuffleResult> {
    return computeReshuffle((await this.buildInput(now)).input);
  }

  /**
   * Runs a reshuffle for `period`. The scheduled one runs at the day boundary with
   * period = the server-day it closes; `/vip reshuffle` uses its own job name.
   */
  async runReshuffle(job: string, period: string, actorId: string | null = null): Promise<ReshuffleRun> {
    const vipRoleId = this.config.current.guild.vipRoleId;
    if (!vipRoleId) return { status: 'skipped', message: 'VIP role not set up yet: run /bot setup first.' };
    const now = this.clock.now();
    if (!(await claimJob(this.db, job, period, now))) return { status: 'skipped', message: 'already ran (or is running) for this period.' };

    let committed = false;
    try {
      // Count everything up to the boundary before scoring.
      await this.buffer.flush(this.db);
      if (job === RESHUFFLE_JOB) {
        const today = this.#today(now);
        const first = await this.db.activityDay.findFirst({ orderBy: { serverDay: 'asc' }, select: { serverDay: true } });
        const left = warmupDaysLeft(first?.serverDay ?? null, today, this.config.current.guild.windowDays, serverDaysBetween);
        if (left > 0) {
          // Nothing changes until there's a full window of activity; the run still counts as done.
          const detail: StoredDetail = { added: [], removed: [], announcement: null, posted: true, warmupDaysLeft: left };
          await this.db.$transaction((tx) => completeJob(tx, job, period, detail as unknown as Prisma.InputJsonValue, now));
          committed = true;
          const message = `warming up: VIP starts changing in ${left} day${left === 1 ? '' : 's'}, once there's a full week of activity.`;
          this.log.info({ left }, 'reshuffle skipped: warming up');
          return { status: 'skipped', message };
        }
      }
      const result = computeReshuffle((await this.buildInput(now)).input);
      const today = this.#today(now);

      const awards = this.badges ? await this.badges.pending(now) : [];
      const names = await namesFor(this.db, [...result.added, ...result.removed].map((c) => c.userId));
      const announcement = formatVipUpdate(pairAnnouncements(result.added, result.removed), names, awards);
      const detail: StoredDetail = {
        added: result.added.map((a) => ({ userId: a.userId, reason: describeAdd(a.reason) })),
        removed: result.removed.map((r) => ({ userId: r.userId, reason: describeRemove(r.reason) })),
        badges: awards.map(({ userId, badgeId, name }) => ({ userId, badgeId, name })),
        announcement,
        posted: announcement === null,
      };

      await this.db.$transaction(async (tx) => {
        for (const r of detail.removed) await this.#removalWrites(tx, r.userId, r.reason, actorId, now);
        for (const [i, a] of detail.added.entries()) {
          await this.#additionWrites(tx, a.userId, today, result.added[i]!.reason.kind === 'pinned', a.reason, actorId, now);
        }
        if (awards.length) {
          await tx.userBadge.createMany({ data: awards.map((a) => ({ userId: a.userId, badgeId: a.badgeId, awardedAt: now })), skipDuplicates: true });
        }
        await completeJob(tx, job, period, detail as unknown as Prisma.InputJsonValue, now);
      });
      committed = true;

      for (const r of detail.removed) this.#vips.delete(r.userId);
      for (const [i, a] of detail.added.entries()) this.#vips.set(a.userId, { since: today, pinned: result.added[i]!.reason.kind === 'pinned' });

      for (const r of detail.removed) await this.#removalEffects(r.userId, r.reason);
      for (const a of detail.added) await this.#additionEffects(a.userId, a.reason);
      if (awards.length) await this.badges?.applyRoles(awards);
      await this.#postAnnouncement(job, period, detail);
      await this.reconcile();
      for (const hook of this.onReshuffled) {
        await hook(today, result).catch((err: unknown) => this.log.error({ err }, 'after-reshuffle step failed'));
      }

      const message = detail.added.length || detail.removed.length ? `${detail.added.length} added, ${detail.removed.length} removed.` : 'no changes.';
      this.log.info({ job, period, added: detail.added.length, removed: detail.removed.length }, 'reshuffle done');
      return { status: 'done', message, result };
    } catch (err) {
      this.log.error({ err, job, period, committed }, 'reshuffle failed');
      // Once saved, the reshuffle counts as done; startup reconciliation and the
      // pending-announcement check finish anything left over.
      if (!committed) await failJob(this.db, job, period, err instanceof Error ? err.message : String(err), this.clock.now()).catch(() => undefined);
      throw err;
    }
  }

  async #removalWrites(tx: Tx, userId: string, reason: string, actorId: string | null, now: Date): Promise<void> {
    await tx.vipMember.deleteMany({ where: { userId } });
    await tx.vipStint.updateMany({ where: { userId, endedAt: null }, data: { endedAt: now, endReason: reason } });
    await tx.auditLog.create({ data: { action: 'vip.remove', actorId, targetId: userId, reason } });
  }

  async #additionWrites(tx: Tx, userId: string, today: string, pinned: boolean, reason: string, actorId: string | null, now: Date) {
    await tx.vipMember.upsert({ where: { userId }, create: { userId, since: today, sinceAt: now, pinned }, update: { pinned } });
    await tx.vipStint.create({ data: { userId, startedAt: now, pinned } });
    await tx.auditLog.create({ data: { action: 'vip.add', actorId, targetId: userId, reason } });
  }

  async #removalEffects(userId: string, reason: string): Promise<void> {
    const roleId = this.config.current.guild.vipRoleId;
    const res = roleId ? await this.roles.run({ userId, roleId, action: 'remove', reason: `VIP removed: ${reason}` }) : { ok: true as const };
    for (const hook of this.onRemoved) await hook(userId, reason).catch((err: unknown) => this.log.warn({ err, userId }, 'VIP removal cleanup failed'));
    await this.modLog.post(`🔻 VIP removed from <@${userId}>: ${reason}${res.ok ? '' : `\n⚠️ Role not removed: ${res.error}`}`);
  }

  async #additionEffects(userId: string, reason: string): Promise<void> {
    const roleId = this.config.current.guild.vipRoleId;
    const res = roleId ? await this.roles.run({ userId, roleId, action: 'add', reason: `VIP: ${reason}` }) : { ok: false as const, error: 'VIP role not set up' };
    for (const hook of this.onAdded) await hook(userId).catch((err: unknown) => this.log.warn({ err, userId }, 'VIP addition step failed'));
    await this.modLog.post(`⭐ VIP given to <@${userId}>: ${reason}${res.ok ? '' : `\n⚠️ Role not given: ${res.error}`}`);
  }

  /**
   * The one VIP removal routine (SPEC §3 "Losing VIP"), used by `/vip remove` and
   * mid-day events; the reshuffle uses the same writes and effects. The freed slot
   * is filled at the next reshuffle. Returns false if they weren't VIP.
   */
  async removeVip(userId: string, reason: string, actorId: string | null = null): Promise<boolean> {
    if (!this.#vips.has(userId)) return false;
    const now = this.clock.now();
    await this.db.$transaction((tx) => this.#removalWrites(tx, userId, reason, actorId, now));
    this.#vips.delete(userId);
    await this.#removalEffects(userId, reason);
    return true;
  }

  /** Gives VIP now (used by /vip pin for non-VIPs). */
  async addVip(userId: string, reason: string, pinned: boolean, actorId: string | null): Promise<void> {
    const now = this.clock.now();
    const today = this.#today(now);
    await this.db.$transaction((tx) => this.#additionWrites(tx, userId, today, pinned, reason, actorId, now));
    this.#vips.set(userId, { since: today, pinned });
    await this.#additionEffects(userId, reason);
  }

  /** Pins or unpins a current VIP. Splits their stint so pinned time is tracked separately. */
  async setPinned(userId: string, pinned: boolean, actorId: string): Promise<void> {
    const v = this.#vips.get(userId);
    if (!v || v.pinned === pinned) return;
    const now = this.clock.now();
    await this.db.$transaction([
      this.db.vipMember.update({ where: { userId }, data: { pinned } }),
      this.db.vipStint.updateMany({ where: { userId, endedAt: null }, data: { endedAt: now, endReason: pinned ? 'pinned' : 'unpinned' } }),
      this.db.vipStint.create({ data: { userId, startedAt: now, pinned } }),
      this.db.auditLog.create({ data: { action: pinned ? 'vip.pin' : 'vip.unpin', actorId, targetId: userId } }),
    ]);
    this.#vips.set(userId, { ...v, pinned });
    await this.modLog.post(`${pinned ? '📌 Pinned' : '📍 Unpinned'} VIP <@${userId}> by <@${actorId}>`);
  }

  /** Makes VIP roles match the database (startup and after each reshuffle). */
  async reconcile(): Promise<{ added: number; removed: number }> {
    const roleId = this.config.current.guild.vipRoleId;
    if (!roleId) return { added: 0, removed: 0 };
    const guild = this.#guild();
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      await this.modLog.post('⚠️ The VIP role is missing. Run /bot setup to recreate it.');
      return { added: 0, removed: 0 };
    }
    // VIPs who left while the bot was offline lose VIP now.
    for (const userId of [...this.#vips.keys()]) {
      if (!guild.members.cache.has(userId)) await this.removeVip(userId, 'left the server');
    }
    const drift = roleDrift(this.#vips.keys(), role.members.keys(), new Set(guild.members.cache.keys()));
    for (const userId of drift.addRole) {
      const res = await this.roles.run({ userId, roleId, action: 'add', reason: 'VIP in the database: role restored' });
      await this.modLog.post(`🔧 VIP role restored for <@${userId}> (they're VIP in the database; use /vip remove to remove VIP)${res.ok ? '' : `\n⚠️ ${res.error}`}`);
    }
    for (const userId of drift.removeRole) {
      const res = await this.roles.run({ userId, roleId, action: 'remove', reason: 'Not VIP in the database: role removed' });
      await this.modLog.post(`🔧 VIP role removed from <@${userId}> (given by hand; use /vip pin to make someone VIP)${res.ok ? '' : `\n⚠️ ${res.error}`}`);
    }
    return { added: drift.addRole.length, removed: drift.removeRole.length };
  }

  /** Mid-day removals (SPEC §3): timed out, got a staff role, or VIP role changed by hand. */
  async onMemberUpdate(before: GuildMember | PartialGuildMember, after: GuildMember): Promise<void> {
    if (after.guild.id !== this.guildId) return;
    const roleId = this.config.current.guild.vipRoleId;
    const v = this.#vips.get(after.id);

    if (v && !v.pinned) {
      if (after.isCommunicationDisabled()) {
        await this.removeVip(after.id, 'timed out');
        return;
      }
      const staff = new Set((await this.db.staffRole.findMany()).map((s) => s.roleId));
      if (after.roles.cache.some((r) => staff.has(r.id))) {
        await this.removeVip(after.id, 'has a staff role');
        return;
      }
    }

    if (!roleId || before.partial) return;
    const had = before.roles.cache.has(roleId);
    const has = after.roles.cache.has(roleId);
    if (!had && has && !this.#vips.has(after.id)) {
      await this.roles.run({ userId: after.id, roleId, action: 'remove', reason: 'Not VIP in the database: role removed' });
      await this.modLog.post(`🔧 VIP role removed from <@${after.id}> (given by hand; use /vip pin to make someone VIP)`);
    } else if (had && !has && this.#vips.has(after.id)) {
      await this.roles.run({ userId: after.id, roleId, action: 'add', reason: 'VIP in the database: role restored' });
      await this.modLog.post(`🔧 VIP role restored for <@${after.id}> (removed by hand; use /vip remove to remove VIP)`);
    }
  }

  async onMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
    if (member.guild.id === this.guildId) await this.removeVip(member.id, 'left the server');
  }

  async #postAnnouncement(job: string, period: string, detail: StoredDetail): Promise<void> {
    if (detail.posted || !detail.announcement) return;
    const channelId = this.config.current.guild.announceChannelId;
    if (!channelId) {
      await this.modLog.post('⚠️ VIP update not announced: no announcement channel. Set one with /settings channel.');
      return;
    }
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isSendable()) throw new Error('not a text channel the bot can post in');
      const summary = `${detail.added.length} new VIPs, ${detail.removed.length} left VIP, ${detail.badges?.length ?? 0} new badges.`;
      const line = this.hype ? await this.hype(summary).catch(() => null) : null;
      const content = line ? `${line}\n${detail.announcement.content}` : detail.announcement.content;
      await channel.send({ content: content.slice(0, 2000), allowedMentions: { users: detail.announcement.pingUserIds } });
      await this.db.jobRun.update({
        where: { job_period: { job, period } },
        data: { detail: { ...detail, posted: true } as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      this.log.warn({ err }, 'posting the VIP update failed');
      await this.modLog.post(`⚠️ Couldn't post the VIP update in <#${channelId}>. Check the bot can send messages there.`);
    }
  }

  /** Startup: posts any VIP update from the last 2 days that didn't go out. */
  async postPendingAnnouncements(): Promise<void> {
    const since = new Date(this.clock.now().getTime() - 2 * 86_400_000);
    const runs = await this.db.jobRun.findMany({
      where: { job: { in: [RESHUFFLE_JOB, MANUAL_RESHUFFLE_JOB] }, status: 'succeeded', finishedAt: { gt: since } },
      orderBy: { finishedAt: 'asc' },
    });
    for (const run of runs) {
      const detail = run.detail as unknown as StoredDetail | null;
      if (detail && !detail.posted) await this.#postAnnouncement(run.job, run.period, detail);
    }
  }
}
