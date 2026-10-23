// VIP polls (SPEC §5a). Polls in #polls are handled one at a time, in the order
// Discord received them, so the limits hold even when several arrive at once. Locks
// are channel permission overwrites, saved as PollLock rows and removed by the
// daily poll-unlock job once they expire.
import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type Client,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type OverwriteResolvable,
  type Role,
  type TextChannel,
} from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { decidePoll, POLL_REJECT_TEXT, pollThreadName } from '../core/polls.js';
import { serverDayAt, serverDayByKey } from '../core/serverDay.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import { claimJob, completeJob, failJob } from './jobs.js';
import type { ModLog } from './modLog.js';
import { findExistingChannel, findExistingRole } from './reuse.js';
import type { VipService } from './vipService.js';

export const POLL_UNLOCK_JOB = 'poll-unlock';

const LOCKED = { SendMessages: false, SendPolls: false } as const;
const ALLOWED = { SendMessages: true, SendPolls: true } as const;

export class PollService {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly vip: VipService,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async #channel(): Promise<TextChannel | null> {
    const id = this.config.current.guild.pollsChannelId;
    const channel = id ? await this.client.channels.fetch(id).catch(() => null) : null;
    return channel?.isTextBased() && 'permissionOverwrites' in channel ? (channel as TextChannel) : null;
  }

  async #isStaffOrAdmin(message: Message<true>): Promise<boolean> {
    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const staff = new Set((await this.db.staffRole.findMany()).map((s) => s.roleId));
    return member.roles.cache.some((r) => staff.has(r.id));
  }

  /** Every message in the guild comes through here; only #polls ones are handled. */
  handleMessage(message: Message): void {
    if (!message.inGuild() || message.guildId !== this.guildId || message.author.bot) return;
    if (message.channelId !== this.config.current.guild.pollsChannelId) return;
    const job = this.#queue.then(() => this.#process(message));
    this.#queue = job.catch((err: unknown) => this.log.error({ err }, 'poll handling failed'));
  }

  async #process(message: Message<true>): Promise<void> {
    const staff = await this.#isStaffOrAdmin(message);
    const userId = message.author.id;

    if (!message.poll) {
      // Discussion goes in the poll's thread; staff and admins can post announcements.
      if (staff) return;
      await message.delete().catch(() => undefined);
      await this.modLog.post(`🗑️ Deleted a non-poll message from <@${userId}> in <#${message.channelId}> (discussion goes in the poll threads)`);
      return;
    }

    const day = serverDayAt(message.createdAt, this.config.current.boundary).key;
    const until = serverDayByKey(day, this.config.current.boundary).end;
    const cap = this.config.current.guild.pollsDailyCap;
    const isVip = this.vip.vips.has(userId);

    const decision = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`polls:${day}`}))`;
      if (await tx.pollPost.findUnique({ where: { messageId: message.id } })) return null; // already handled
      const [userPollsToday, vipPollsToday, allowance] = await Promise.all([
        tx.pollPost.count({ where: { serverDay: day, userId, accepted: true, kind: { in: ['vip', 'extra'] } } }),
        tx.pollPost.count({ where: { serverDay: day, accepted: true, kind: 'vip' } }),
        tx.pollLock.findFirst({ where: { scope: 'user', targetId: userId, effect: 'allow', until: { gt: message.createdAt } } }),
      ]);
      const d = decidePoll({ isStaffOrAdmin: staff, isVip, userPollsToday, vipPollsToday, cap, hasExtraAllowance: !!allowance });
      await tx.pollPost.create({ data: { userId, messageId: message.id, serverDay: day, kind: d.accept ? d.kind : 'vip', accepted: d.accept } });
      if (d.lockUser) {
        await tx.pollLock.upsert({
          where: { scope_targetId: { scope: 'user', targetId: userId } },
          create: { scope: 'user', targetId: userId, effect: 'deny', serverDay: day, until },
          update: { effect: 'deny', serverDay: day, until },
        });
      }
      const vipRoleId = this.config.current.guild.vipRoleId;
      if (d.lockRole && vipRoleId) {
        await tx.pollLock.upsert({
          where: { scope_targetId: { scope: 'role', targetId: vipRoleId } },
          create: { scope: 'role', targetId: vipRoleId, effect: 'deny', serverDay: day, until },
          update: { effect: 'deny', serverDay: day, until },
        });
      }
      return d;
    });
    if (!decision) return;

    const channel = message.channel;
    if (decision.lockUser) await this.#overwrite(channel, userId, OverwriteType.Member, LOCKED, 'Poll posted: locked until the daily reset');
    const vipRoleId = this.config.current.guild.vipRoleId;
    if (decision.lockRole && vipRoleId) {
      await this.#overwrite(channel, vipRoleId, OverwriteType.Role, LOCKED, "Today's VIP poll limit reached");
    }

    if (!decision.accept) {
      await message.delete().catch(() => undefined);
      await this.modLog.post(`🗑️ Deleted a poll from <@${userId}>: ${POLL_REJECT_TEXT[decision.reason]}`);
      return;
    }

    const pollsRoleId = this.config.current.guild.pollsRoleId;
    await message
      .reply({
        content: `${pollsRoleId ? `<@&${pollsRoleId}> ` : ''}📊 New poll from <@${userId}>`,
        allowedMentions: { roles: pollsRoleId ? [pollsRoleId] : [], users: [userId], repliedUser: false },
      })
      .catch((err: unknown) => this.log.warn({ err }, "couldn't ping the Polls role"));
    await message
      .startThread({ name: pollThreadName(message.poll.question.text ?? ''), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay, reason: 'Poll discussion' })
      .catch((err: unknown) => this.log.warn({ err }, "couldn't create the poll thread"));
    if (decision.kind === 'extra') await this.modLog.post(`📊 <@${userId}> used an admin-granted extra poll`);
    if (decision.lockRole) await this.modLog.post(`🔒 Today's VIP poll limit (${cap}) reached: #polls locked for VIPs until the reset`);
  }

  async #overwrite(
    channel: GuildTextBasedChannel,
    id: string,
    type: OverwriteType,
    perms: typeof LOCKED | typeof ALLOWED | null,
    reason: string,
  ): Promise<void> {
    if (!('permissionOverwrites' in channel)) return;
    try {
      if (perms) await channel.permissionOverwrites.edit(id, perms, { type, reason });
      else await channel.permissionOverwrites.delete(id, reason);
    } catch (err) {
      this.log.warn({ err, id }, 'poll lock change failed');
      await this.modLog.post(`⚠️ Couldn't change #polls permissions (the bot needs Manage Permissions there). Run /bot setup.`);
    }
  }

  /** /vip poll-unlock: one more poll today for this VIP, even past the cap. */
  async grantExtra(userId: string, actorId: string): Promise<string> {
    const channel = await this.#channel();
    if (!channel) return '❌ No polls channel. Run /bot setup.';
    const now = this.clock.now();
    const day = serverDayAt(now, this.config.current.boundary).key;
    const until = serverDayByKey(day, this.config.current.boundary).end;
    await this.db.$transaction([
      this.db.pollLock.upsert({
        where: { scope_targetId: { scope: 'user', targetId: userId } },
        create: { scope: 'user', targetId: userId, effect: 'allow', serverDay: day, until },
        update: { effect: 'allow', serverDay: day, until },
      }),
      this.db.auditLog.create({ data: { action: 'polls.unlock', actorId, targetId: userId, data: { day } } }),
    ]);
    // A member "allow" beats the VIP role's lock (Discord applies member overwrites last).
    await this.#overwrite(channel, userId, OverwriteType.Member, ALLOWED, `Extra poll granted by ${actorId}`);
    await this.modLog.post(`🔓 <@${actorId}> gave <@${userId}> one more poll today`);
    return `✅ <@${userId}> can post one more poll today, even if the daily limit is reached.`;
  }

  /** Removes only locks that have expired (SPEC §5a "Daily reset"). */
  async unlockExpired(now = this.clock.now()): Promise<number> {
    const expired = await this.db.pollLock.findMany({ where: { until: { lte: now } } });
    const channel = await this.#channel();
    for (const lock of expired) {
      if (channel) {
        if (lock.scope === 'role') await this.#overwrite(channel, lock.targetId, OverwriteType.Role, ALLOWED, 'Daily poll reset');
        else await this.#overwrite(channel, lock.targetId, OverwriteType.Member, null, 'Daily poll reset');
      }
      await this.db.pollLock.delete({ where: { id: lock.id } });
    }
    return expired.length;
  }

  /** The daily job: at the boundary, after the day `period` closed. */
  async runUnlockJob(period: string): Promise<void> {
    const now = this.clock.now();
    if (!(await claimJob(this.db, POLL_UNLOCK_JOB, period, now))) return;
    try {
      const count = await this.unlockExpired(now);
      await this.db.$transaction((tx) => completeJob(tx, POLL_UNLOCK_JOB, period, { unlocked: count }, now));
      if (count) this.log.info({ count }, 'poll locks removed');
    } catch (err) {
      await failJob(this.db, POLL_UNLOCK_JOB, period, err instanceof Error ? err.message : String(err), this.clock.now());
      throw err;
    }
  }

  /** Startup and /bot setup: #polls overwrites match PollLock rows. */
  async reconcileLocks(): Promise<void> {
    await this.unlockExpired();
    const channel = await this.#channel();
    const vipRoleId = this.config.current.guild.vipRoleId;
    if (!channel) return;
    const locks = await this.db.pollLock.findMany();
    const userLocks = new Map(locks.filter((l) => l.scope === 'user').map((l) => [l.targetId, l]));
    for (const [id, lock] of userLocks) {
      const ow = channel.permissionOverwrites.cache.get(id);
      const want = lock.effect === 'allow' ? ALLOWED : LOCKED;
      const ok = ow && (lock.effect === 'allow' ? ow.allow.has(PermissionFlagsBits.SendPolls) : ow.deny.has(PermissionFlagsBits.SendPolls));
      if (!ok) await this.#overwrite(channel, id, OverwriteType.Member, want, 'Poll lock check');
    }
    // Member overwrites on SendPolls that no lock row explains are leftovers: remove them.
    for (const ow of channel.permissionOverwrites.cache.values()) {
      if (ow.type !== OverwriteType.Member || ow.id === this.client.user?.id || userLocks.has(ow.id)) continue;
      if (ow.allow.has(PermissionFlagsBits.SendPolls) || ow.deny.has(PermissionFlagsBits.SendPolls)) {
        await this.#overwrite(channel, ow.id, OverwriteType.Member, null, 'Poll lock check: leftover');
      }
    }
    if (vipRoleId) {
      const roleLocked = locks.some((l) => l.scope === 'role' && l.targetId === vipRoleId);
      await this.#overwrite(channel, vipRoleId, OverwriteType.Role, roleLocked ? LOCKED : ALLOWED, 'Poll lock check');
    }
  }

  /** /vip polls text. */
  async status(): Promise<string> {
    const now = this.clock.now();
    const day = serverDayAt(now, this.config.current.boundary);
    const posts = await this.db.pollPost.findMany({ where: { serverDay: day.key }, orderBy: { createdAt: 'asc' } });
    const locks = await this.db.pollLock.findMany();
    const counted = posts.filter((p) => p.accepted && p.kind === 'vip').length;
    const lines = [
      `**VIP polls today:** ${counted}/${this.config.current.guild.pollsDailyCap} · resets <t:${Math.floor(day.end.getTime() / 1000)}:R>`,
      ...posts.map((p) => `• <@${p.userId}>: ${p.accepted ? (p.kind === 'staff' ? 'staff poll' : p.kind === 'extra' ? 'extra poll' : 'poll') : 'deleted (over the limit)'}`),
      `**Locked:** ${locks.filter((l) => l.effect === 'deny').map((l) => (l.scope === 'role' ? 'all VIPs' : `<@${l.targetId}>`)).join(', ') || 'nobody'}`,
    ];
    const extras = locks.filter((l) => l.effect === 'allow');
    if (extras.length) lines.push(`**Extra poll allowed:** ${extras.map((l) => `<@${l.targetId}>`).join(', ')}`);
    return lines.join('\n');
  }

  /** /bot setup: the polls channel, its permissions and the Polls role. */
  async setup(guild: Guild, vipRole: Role, report: string[]): Promise<void> {
    const cfg = this.config.current.guild;
    const me = await guild.members.fetchMe();
    let pollsRoleId = cfg.pollsRoleId && guild.roles.cache.has(cfg.pollsRoleId) ? cfg.pollsRoleId : null;
    try {
      const reuse = pollsRoleId ? undefined : await findExistingRole(guild, this.db, cfg, ['Polls', 'Poll Ping', 'Poll Pings']);
      if (reuse) {
        pollsRoleId = reuse.id;
        if (reuse.mentionable) await reuse.setMentionable(false, 'Only the bot pings the Polls role');
        report.push(`♻️ Using the existing ${reuse.toString()} role for poll pings`);
      } else if (!pollsRoleId) {
        const role = await guild.roles.create({ name: 'Polls', mentionable: false, permissions: [], reason: 'Pinged for new VIP polls' });
        pollsRoleId = role.id;
        report.push(`✅ Polls role ${role.toString()} created. Give it to members who want poll pings.`);
      } else {
        const role = guild.roles.cache.get(pollsRoleId)!;
        if (role.mentionable) await role.setMentionable(false, 'Only the bot pings the Polls role');
      }
    } catch (err) {
      report.push(`❌ Polls role: ${err instanceof Error ? err.message : String(err)}`);
    }

    const staff = (await this.db.staffRole.findMany()).map((s) => s.roleId).filter((id) => guild.roles.cache.has(id));
    const posters = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendPolls];
    const overwrites: OverwriteResolvable[] = [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads],
        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendPolls, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
      },
      { id: vipRole.id, type: OverwriteType.Role, allow: posters },
      ...staff.map((id) => ({ id, type: OverwriteType.Role, allow: posters })),
      {
        id: me.id,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.MentionEveryone,
        ],
      },
    ];
    let channelId = cfg.pollsChannelId;
    try {
      const existing = (channelId ? guild.channels.cache.get(channelId) : undefined) ?? findExistingChannel(guild, ['polls'], ChannelType.GuildText);
      if (existing && 'permissionOverwrites' in existing && existing.isTextBased()) {
        await existing.permissionOverwrites.set(overwrites, '/bot setup');
        channelId = existing.id;
      } else {
        channelId = (await guild.channels.create({ name: 'polls', permissionOverwrites: overwrites, reason: '/bot setup' })).id;
      }
      report.push(`✅ Polls channel <#${channelId}> ready`);
    } catch (err) {
      report.push(`❌ Polls channel: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.db.guildConfig.update({ where: { guildId: guild.id }, data: { pollsRoleId, pollsChannelId: channelId } });
    await this.config.load();
    // Setting the overwrites above cleared any active locks; put them back.
    await this.reconcileLocks();
  }
}
