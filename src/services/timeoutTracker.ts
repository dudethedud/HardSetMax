// The bot's own timeout history (SPEC §2 "Timeout tracking"). Discord only shows
// timeouts that are active now, so every timeout seen is saved as a TimeoutEvent:
// - live, from member updates (covers moderators, bots and AutoMod),
// - on startup, from the audit log back to where the last scan stopped, plus any
//   member who is timed out right now.
// A timeout is keyed by (user, scheduled end), so the same one is never saved twice.
import { AuditLogEvent, type Guild, type GuildAuditLogsEntry, type GuildMember, type PartialGuildMember } from 'discord.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';

/** How far back the first audit log scan goes. */
const FIRST_SCAN_DAYS = 30;
const MAX_PAGES = 20;
const TIMEOUT_KEY = 'communication_disabled_until';

type Source = 'member-update' | 'audit-log' | 'startup';

export class TimeoutTracker {
  constructor(
    private readonly guildId: string,
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  /** Saves a timeout that runs until `until`. Does nothing if it's already saved. */
  async recordStart(userId: string, startedAt: Date, until: Date, source: Source): Promise<void> {
    await this.db.timeoutEvent.upsert({
      where: { userId_until: { userId, until } },
      create: { userId, startedAt, until, endedAt: until, source },
      update: {},
    });
  }

  /** A timeout that was meant to run until `until` was removed (or replaced) at `at`. */
  async recordEnd(userId: string, until: Date, at: Date): Promise<void> {
    await this.db.timeoutEvent.updateMany({ where: { userId, until, endedAt: { gt: at } }, data: { endedAt: at } });
  }

  async onMemberUpdate(before: GuildMember | PartialGuildMember, after: GuildMember, now = new Date()): Promise<void> {
    if (after.guild.id !== this.guildId || after.user.bot) return;
    const old = before.partial ? null : before.communicationDisabledUntil;
    const next = after.communicationDisabledUntil;
    if (old?.getTime() === next?.getTime()) return;
    if (old && old > now) await this.recordEnd(after.id, old, now);
    if (next && next > now) await this.recordStart(after.id, now, next, 'member-update');
  }

  /** Saves the newest audit log entry seen, so the next startup scan stops there. */
  async onAuditLogEntry(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    if (guild.id !== this.guildId || entry.action !== AuditLogEvent.MemberUpdate) return;
    await this.db.guildConfig.update({ where: { guildId: this.guildId }, data: { timeoutAuditCursor: entry.id } });
  }

  /** Startup catch-up. Needs the View Audit Log permission. */
  async catchUp(guild: Guild, now = new Date()): Promise<void> {
    const config = await this.db.guildConfig.findUniqueOrThrow({ where: { guildId: this.guildId } });
    const cursor = config.timeoutAuditCursor ? BigInt(config.timeoutAuditCursor) : null;
    const oldest = now.getTime() - FIRST_SCAN_DAYS * 86_400_000;

    const entries: GuildAuditLogsEntry<AuditLogEvent.MemberUpdate>[] = [];
    let before: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 100, ...(before ? { before } : {}) });
        const batch = [...logs.entries.values()];
        const fresh = batch.filter((e) => (cursor === null || BigInt(e.id) > cursor) && e.createdTimestamp >= oldest);
        entries.push(...fresh);
        if (batch.length < 100 || fresh.length < batch.length) break;
        before = batch.at(-1)?.id;
      }
    } catch (err) {
      this.log.warn({ err }, "couldn't read the audit log for missed timeouts (needs View Audit Log)");
    }

    // Oldest first, so a removal is applied after the timeout it removes.
    entries.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    let saved = 0;
    for (const e of entries) {
      const userId = e.targetId;
      if (!userId) continue;
      for (const change of e.changes) {
        if (change.key !== TIMEOUT_KEY) continue;
        const old = typeof change.old === 'string' ? new Date(change.old) : null;
        const next = typeof change.new === 'string' ? new Date(change.new) : null;
        if (old && old > e.createdAt) await this.recordEnd(userId, old, e.createdAt);
        if (next && next > e.createdAt) {
          await this.recordStart(userId, e.createdAt, next, 'audit-log');
          saved++;
        }
      }
    }
    const newest = entries.at(-1);
    if (newest) await this.db.guildConfig.update({ where: { guildId: this.guildId }, data: { timeoutAuditCursor: newest.id } });

    // Anyone timed out right now (e.g. by AutoMod while the bot was offline).
    for (const member of guild.members.cache.values()) {
      const until = member.communicationDisabledUntil;
      if (!member.user.bot && until && until > now) await this.recordStart(member.id, now, until, 'startup');
    }
    this.log.info({ scanned: entries.length, saved }, 'timeout catch-up done');
  }
}

/** Whether a user was timed out at any point in the last `days` days (for VIP eligibility). */
export async function timedOutWithin(db: Db, userId: string, days: number, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - days * 86_400_000);
  return (await db.timeoutEvent.count({ where: { userId, endedAt: { gt: since }, startedAt: { lte: now } } })) > 0;
}
