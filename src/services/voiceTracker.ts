// Voice minutes (SPEC §2) and voice sessions (SPEC §11).
//
// Every minute, each member in voice whose minute counts gets +1, up to the daily
// cap. Separately, each stay in a voice channel is saved as a VoiceSession with a
// heartbeat, so a crash leaves sessions that can be closed at their last heartbeat.
import type { Client, Guild, VoiceState } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { countsVoiceMinute, minutesUnderCap, type VoiceMemberState } from '../core/activityRules.js';
import { serverDayAt } from '../core/serverDay.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { ActivityBuffer } from './activityBuffer.js';

export class VoiceTracker {
  /** userId → open VoiceSession id. */
  #sessions = new Map<string, Promise<number | null>>();
  /** "userId|serverDay" → voice minutes counted today (database + buffer). */
  #today = new Map<string, number>();
  #writes: Promise<unknown> = Promise.resolve();
  #stopped = false;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly buffer: ActivityBuffer,
    private readonly log: Logger,
  ) {}

  #guild(): Guild | undefined {
    return this.client.guilds.cache.get(this.guildId);
  }

  /** Database writes for sessions run one at a time, in order. */
  #write<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const p = this.#writes.then(fn).catch((err: unknown) => {
      this.log.warn({ err }, `voice session ${name} failed`);
      return null;
    });
    this.#writes = p;
    return p;
  }

  #open(userId: string, channelId: string): void {
    this.#sessions.set(
      userId,
      this.#write('open', async () => (await this.db.voiceSession.create({ data: { userId, channelId } })).id),
    );
  }

  #close(userId: string, endedAt = new Date()): void {
    const session = this.#sessions.get(userId);
    this.#sessions.delete(userId);
    if (!session) return;
    void this.#write('close', async () => {
      const id = await session;
      if (id !== null) await this.db.voiceSession.update({ where: { id }, data: { endedAt, lastHeartbeat: endedAt } });
    });
  }

  /**
   * Startup: close sessions left open by a crash or restart at their last heartbeat,
   * then open sessions for everyone in voice now.
   */
  async start(): Promise<void> {
    const stale = await this.db.voiceSession.findMany({ where: { endedAt: null }, select: { id: true, lastHeartbeat: true } });
    for (const s of stale) await this.db.voiceSession.update({ where: { id: s.id }, data: { endedAt: s.lastHeartbeat } });
    if (stale.length) this.log.info({ count: stale.length }, 'closed stale voice sessions');

    for (const state of this.#guild()?.voiceStates.cache.values() ?? []) {
      if (state.channelId && !state.member?.user.bot) this.#open(state.id, state.channelId);
    }
  }

  onVoiceStateUpdate(before: VoiceState, after: VoiceState): void {
    if (this.#stopped || after.guild.id !== this.guildId || after.member?.user.bot) return;
    if (after.member) this.buffer.setName(after.id, after.member.displayName);
    if (before.channelId === after.channelId) return; // mute/deafen changes are read at each tick
    if (before.channelId) this.#close(after.id);
    if (after.channelId) this.#open(after.id, after.channelId);
  }

  /** Counts this minute for everyone in voice. Runs once a minute. */
  async tick(now = new Date()): Promise<void> {
    const guild = this.#guild();
    if (this.#stopped || !guild) return;
    const { boundary, guild: cfg } = this.config.current;
    const day = serverDayAt(now, boundary).key;

    const states = [...guild.voiceStates.cache.values()].map((s) => ({
      userId: s.id,
      state: {
        isBot: s.member?.user.bot ?? false,
        channelId: s.channelId,
        selfDeaf: s.selfDeaf ?? false,
        serverDeaf: s.serverDeaf ?? false,
      } satisfies VoiceMemberState,
    }));
    const counting = states.filter(({ userId, state }) =>
      countsVoiceMinute(
        state,
        states.filter((o) => o.userId !== userId).map((o) => o.state),
        guild.afkChannelId,
      ),
    );
    if (counting.length === 0) return;

    for (const key of this.#today.keys()) if (!key.endsWith(`|${day}`)) this.#today.delete(key);
    const missing = counting.map((c) => c.userId).filter((id) => !this.#today.has(`${id}|${day}`));
    if (missing.length) {
      try {
        const rows = await this.db.activityDay.findMany({
          where: { serverDay: day, userId: { in: missing } },
          select: { userId: true, voiceMinutes: true },
        });
        const saved = new Map(rows.map((r) => [r.userId, r.voiceMinutes]));
        for (const id of missing) this.#today.set(`${id}|${day}`, (saved.get(id) ?? 0) + this.buffer.pendingVoiceMinutes(id, day));
      } catch (err) {
        // Without today's total the cap can't be applied; skip these members this minute.
        this.log.warn({ err }, "voice tick: couldn't load today's minutes");
      }
    }

    for (const { userId } of counting) {
      const key = `${userId}|${day}`;
      const already = this.#today.get(key);
      if (already === undefined) continue;
      const add = minutesUnderCap(already, 1, cfg.voiceDailyCapMinutes);
      if (add === 0) continue;
      this.#today.set(key, already + add);
      this.buffer.add(userId, day, { voiceMinutes: add });
    }
  }

  /** Marks open sessions as still alive. Runs with every flush. */
  async heartbeat(now = new Date()): Promise<void> {
    const ids = (await Promise.all(this.#sessions.values())).filter((id): id is number => id !== null);
    if (ids.length) await this.db.voiceSession.updateMany({ where: { id: { in: ids } }, data: { lastHeartbeat: now } });
  }

  /** Shutdown: stop counting and close every open session. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const now = new Date();
    for (const userId of [...this.#sessions.keys()]) this.#close(userId, now);
    await this.#writes;
  }
}
