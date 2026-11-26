// Check-in DMs for quiet members (docs/SPEC.md §9). Notes when members talk
// (timestamps only, saved in batches), and once a day DMs up to 20 members who've
// been quiet a week, about the server's next scheduled event, 5–10 minutes apart.
// Members can opt out with the DM's button or /checkins. Rules are in core/checkins.ts.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildScheduledEventStatus, type Guild, type Message } from 'discord.js';
import { checkinDue, checkinOrder, checkinText, dmGap, MAX_PER_RUN, nextEvent, runDay, type CheckinFacts } from '../core/checkins.js';
import type { Db } from '../db/prisma.js';
import type { CheckinState } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';
import { CHECKIN_STOP_ID, type DmQueue } from './dm.js';
import { fetchAllMembers } from './memberList.js';

export interface CheckinRun {
  due: number;
  sent: number;
  closed: number;
  /** Started talking again while the run was going: skipped. */
  becameActive: number;
  /** Why the run stopped early, if it did. */
  stopped: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CheckinService {
  /** userId → their latest message since the last save. */
  #seen = new Map<string, Date>();
  #running = false;

  constructor(
    /** Every DM goes through the shared queue (opt-out, limits, rate-limit pause). */
    private readonly dms: DmQueue,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly log: Logger,
    /** CHECKIN_DMS: when off, nothing is sent (messages are still noted and opt-outs still work). */
    readonly enabled: boolean,
    private readonly now: () => Date = () => new Date(),
    private readonly wait: (ms: number) => Promise<void> = sleep,
    private readonly random: () => number = Math.random,
  ) {}

  state(): Promise<CheckinState> {
    return this.db.checkinState.upsert({ where: { guildId: this.guildId }, create: { guildId: this.guildId, trackingStartedAt: this.now() }, update: {} });
  }

  // ---- Activity ----

  /** A message in the server: remember when (never what). Saved by flush(). */
  noteMessage(message: Pick<Message, 'guildId' | 'author' | 'webhookId' | 'system'>): void {
    if (message.guildId !== this.guildId || message.author.bot || message.webhookId || message.system) return;
    this.#seen.set(message.author.id, this.now());
  }

  /** Saves the noted message times (every few minutes, before each run and on shutdown). */
  async flush(): Promise<number> {
    if (!this.#seen.size) return 0;
    const batch = [...this.#seen];
    this.#seen.clear();
    try {
      await this.db.$transaction(batch.map(([userId, at]) => this.db.memberActivity.upsert({ where: { userId }, create: { userId, lastMessageAt: at }, update: { lastMessageAt: at } })));
    } catch (err) {
      // Put them back (unless newer ones came in meanwhile) and try again next time.
      for (const [userId, at] of batch) if (!this.#seen.has(userId)) this.#seen.set(userId, at);
      throw err;
    }
    return batch.length;
  }

  // ---- Opt-out ----

  async setOptOut(userId: string, optOut: boolean): Promise<void> {
    await this.db.memberActivity.upsert({ where: { userId }, create: { userId, checkinOptOut: optOut }, update: { checkinOptOut: optOut } });
  }

  async status(userId: string): Promise<{ optedOut: boolean; lastCheckinAt: Date | null }> {
    const row = await this.db.memberActivity.findUnique({ where: { userId } });
    return { optedOut: row?.checkinOptOut ?? false, lastCheckinAt: row?.lastCheckinAt ?? null };
  }

  // ---- The daily run ----

  /** Called every hour: runs once a day, after noon Edmonton. */
  async tick(guild: Guild): Promise<CheckinRun | null> {
    await this.flush();
    if (!this.enabled || this.#running) return null;
    const state = await this.state();
    const today = runDay(this.now());
    if (!today.dueNow || state.lastRunDay === today.day) return null;
    // Marked first: a crash or restart mid-run never sends a second batch the same day.
    await this.db.checkinState.update({ where: { guildId: this.guildId }, data: { lastRunDay: today.day } });
    return this.run(guild, state);
  }

  async run(guild: Guild, state?: CheckinState): Promise<CheckinRun> {
    this.#running = true;
    try {
      return await this.#run(guild, state ?? (await this.state()));
    } finally {
      this.#running = false;
    }
  }

  async #activeSince(userId: string, since: Date): Promise<boolean> {
    if (this.#seen.has(userId)) return true;
    const row = await this.db.memberActivity.findUnique({ where: { userId }, select: { lastMessageAt: true } });
    return !!row?.lastMessageAt && row.lastMessageAt > since;
  }

  async #run(guild: Guild, state: CheckinState): Promise<CheckinRun> {
    await this.flush();
    const now = this.now();
    const result: CheckinRun = { due: 0, sent: 0, closed: 0, becameActive: 0, stopped: null };

    // No real upcoming event, no DMs.
    const events = await guild.scheduledEvents.fetch();
    const event = nextEvent(
      [...events.values()].map((e) => ({ name: e.name, startAt: e.scheduledStartAt, scheduled: e.status === GuildScheduledEventStatus.Scheduled })),
      now,
    );
    if (!event) {
      this.log.info('check-ins: no upcoming scheduled event, so no DMs today');
      return result;
    }

    const members = await fetchAllMembers(guild);
    const rows = new Map((await this.db.memberActivity.findMany()).map((r) => [r.userId, r]));
    const due = [...members.values()]
      .map((m) => {
        const row = rows.get(m.id);
        const facts: CheckinFacts = { joinedAt: m.joinedAt, lastMessageAt: row?.lastMessageAt ?? null, lastCheckinAt: row?.lastCheckinAt ?? null, optedOut: row?.checkinOptOut ?? false, isBot: m.user.bot };
        return { userId: m.id, facts };
      })
      .filter((c) => checkinDue(c.facts, now, state.trackingStartedAt));
    result.due = due.length;

    const message = {
      content: checkinText(event.name, event.startAt!),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(CHECKIN_STOP_ID).setLabel('Stop these DMs').setStyle(ButtonStyle.Secondary))],
    };

    let tried = 0;
    for (const c of checkinOrder(due, state.trackingStartedAt).slice(0, MAX_PER_RUN)) {
      if (tried > 0) await this.wait(dmGap(this.random()));
      // The run takes hours: skip anyone who has talked since it started.
      if (await this.#activeSince(c.userId, now)) {
        result.becameActive++;
        continue;
      }
      tried++;
      const dm = await this.dms.send(c.userId, message, 'checkin');
      // A rate limit (DMs paused), the hourly DM limit or any error stops the run for the day.
      if (dm.status === 'held') {
        result.stopped = `DM limit (${dm.reason})`;
        break;
      }
      if (dm.status === 'failed') {
        result.stopped = dm.error instanceof Error ? dm.error.message : String(dm.error);
        this.log.warn({ err: dm.error, userId: c.userId }, 'check-ins: a DM failed, stopping for today');
        break;
      }
      if (dm.status === 'opted-out') continue;
      // Closed DMs count as their check-in: no retries until they're active again.
      await this.db.memberActivity.upsert({ where: { userId: c.userId }, create: { userId: c.userId, lastCheckinAt: now }, update: { lastCheckinAt: now } });
      if (dm.status === 'sent') result.sent++;
      else result.closed++;
    }
    this.log.info({ event: event.name, due: result.due, sent: result.sent, dmsClosed: result.closed, becameActive: result.becameActive, stopped: result.stopped }, `check-ins: sent ${result.sent} DM${result.sent === 1 ? '' : 's'} today`);
    return result;
  }
}
