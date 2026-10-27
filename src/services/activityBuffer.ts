// Activity counters are batched in memory and written to Postgres every 30 s
// (SPEC §11 "Write buffering"). If a write fails, the counts are kept and retried
// on the next flush, so a database outage loses nothing unless the bot also dies.
import type { Db } from '../db/prisma.js';

export interface ActivityDelta {
  messages: number;
  weightedMessages: number;
  voiceMinutes: number;
  filteredMessages: number;
}

interface Pending extends ActivityDelta {
  userId: string;
  serverDay: string;
}

const ZERO: ActivityDelta = { messages: 0, weightedMessages: 0, voiceMinutes: 0, filteredMessages: 0 };

export class ActivityBuffer {
  #pending = new Map<string, Pending>();
  #names = new Map<string, string>();
  /** Names already in the database, so unchanged names aren't rewritten. */
  #savedNames = new Map<string, string>();
  #flushing: Promise<void> | null = null;
  lastFlushAt: Date | null = null;
  lastFlushError: string | null = null;

  add(userId: string, serverDay: string, delta: Partial<ActivityDelta>): void {
    const key = `${userId}|${serverDay}`;
    const p = this.#pending.get(key) ?? { userId, serverDay, ...ZERO };
    p.messages += delta.messages ?? 0;
    p.weightedMessages += delta.weightedMessages ?? 0;
    p.voiceMinutes += delta.voiceMinutes ?? 0;
    p.filteredMessages += delta.filteredMessages ?? 0;
    this.#pending.set(key, p);
  }

  /** Voice minutes added for this user and day but not yet written. */
  pendingVoiceMinutes(userId: string, serverDay: string): number {
    return this.#pending.get(`${userId}|${serverDay}`)?.voiceMinutes ?? 0;
  }

  setName(userId: string, name: string): void {
    if (this.#savedNames.get(userId) !== name) this.#names.set(userId, name);
  }

  /** Rows and names waiting to be written. */
  get pendingCount(): number {
    return this.#pending.size + this.#names.size;
  }

  /** Writes everything pending. Concurrent calls share one write. */
  /** Drops counts not saved yet (for /bot fresh-start, which wipes activity). */
  discard(): void {
    this.#pending.clear();
  }

  flush(db: Db): Promise<void> {
    this.#flushing ??= this.#flush(db).finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  async #flush(db: Db): Promise<void> {
    if (this.pendingCount === 0) return;
    const rows = [...this.#pending.values()];
    const names = new Map(this.#names);
    this.#pending = new Map();
    this.#names = new Map();
    try {
      await db.$transaction([
        ...rows.map(({ userId, serverDay, ...d }) =>
          db.activityDay.upsert({
            where: { userId_serverDay: { userId, serverDay } },
            create: { userId, serverDay, ...d },
            update: {
              messages: { increment: d.messages },
              weightedMessages: { increment: d.weightedMessages },
              voiceMinutes: { increment: d.voiceMinutes },
              filteredMessages: { increment: d.filteredMessages },
            },
          }),
        ),
        ...[...names].map(([userId, name]) => db.memberName.upsert({ where: { userId }, create: { userId, name }, update: { name } })),
      ]);
      for (const [userId, name] of names) this.#savedNames.set(userId, name);
      this.lastFlushAt = new Date();
      this.lastFlushError = null;
    } catch (err) {
      // Put everything back (merged with anything added meanwhile) for the next try.
      for (const { userId, serverDay, ...d } of rows) this.add(userId, serverDay, d);
      for (const [userId, name] of names) if (!this.#names.has(userId)) this.#names.set(userId, name);
      this.lastFlushError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }
}
