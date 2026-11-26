// Every DM the bot sends goes through this queue (docs/SPEC.md §10): one at a time,
// at least 3 seconds apart, at most 30 an hour, and a rate limit on DMs pauses all
// DMs for an hour. Check-in DMs also check the member's opt-out first (§9); colour-
// removal DMs don't (owner's choice). Closed DMs are told apart from real errors.
import { DiscordAPIError, RESTEvents, RESTJSONErrorCodes, type Client, type MessageCreateOptions, type RateLimitData } from 'discord.js';
import { DM_PAUSE_MS, dmSlot, recentDms } from '../core/dmLimits.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';

/** "Stop these DMs": a fixed custom ID, so the button works after restarts. */
export const CHECKIN_STOP_ID = 'checkins:stop';

export type DmKind = 'checkin' | 'colour-removal';

export type DmResult =
  | { status: 'sent' }
  | { status: 'opted-out' }
  /** Their DMs are closed (or they block the bot): skip, never retry. */
  | { status: 'closed' }
  /** Not sent: over the hourly limit, or DMs are paused after a rate limit. */
  | { status: 'held'; reason: 'paused' | 'hourly limit' }
  /** Any other error. */
  | { status: 'failed'; error: unknown };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DmQueue {
  /** When recent DMs went out (ms), for the hourly limit and the 3-second gap. */
  #sent: number[] = [];
  #pausedUntil = 0;
  #sending = false;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    client.rest?.on(RESTEvents.RateLimited, (data: RateLimitData) => this.#onRateLimit(data));
  }

  /** Whether DMs are paused after a rate limit (for logs and tests). */
  get pausedUntil(): number {
    return this.#pausedUntil;
  }

  /**
   * Queues a DM. `send` delivers it (default: by user ID); colour removals pass the
   * member's own send. Resolves once it went out or was skipped.
   */
  send(userId: string, message: MessageCreateOptions, kind: DmKind, send?: (m: MessageCreateOptions) => Promise<unknown>): Promise<DmResult> {
    const job = this.#chain.then(() => this.#send(userId, message, kind, send ?? ((m) => this.client.users.send(userId, m))));
    this.#chain = job.catch(() => undefined);
    return job;
  }

  async #send(userId: string, message: MessageCreateOptions, kind: DmKind, send: (m: MessageCreateOptions) => Promise<unknown>): Promise<DmResult> {
    if (kind === 'checkin') {
      const activity = await this.db.memberActivity.findUnique({ where: { userId }, select: { checkinOptOut: true } });
      if (activity?.checkinOptOut) return { status: 'opted-out' };
    }
    const slot = dmSlot(this.#sent, this.now(), this.#pausedUntil);
    if (slot.kind === 'held') {
      this.log.info({ userId, kind, reason: slot.reason }, 'DM skipped (DM limit)');
      return { status: 'held', reason: slot.reason };
    }
    if (slot.kind === 'wait') await this.wait(slot.ms);
    this.#sending = true;
    try {
      await send({ ...message, allowedMentions: { parse: [] } });
      return { status: 'sent' };
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) return { status: 'closed' };
      return { status: 'failed', error };
    } finally {
      this.#sending = false;
      // A tried DM counts towards the limits whether or not it got through.
      this.#sent = [...recentDms(this.#sent, this.now()), this.now()];
    }
  }

  /** A rate limit that hits DMs (or everything) pauses all DMs for an hour. */
  #onRateLimit(data: Pick<RateLimitData, 'global' | 'route'>): void {
    if (!(data.global || data.route === '/users/@me/channels' || this.#sending)) return;
    const wasPaused = this.now() < this.#pausedUntil;
    this.#pausedUntil = this.now() + DM_PAUSE_MS;
    if (!wasPaused) this.log.warn({ route: data.route, global: data.global }, 'Discord rate-limited DMs: all DMs paused for an hour');
  }
}
