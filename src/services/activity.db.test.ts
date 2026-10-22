// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
// Uses (and empties) the activity tables in that database.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { Client } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { loadStandings } from '../db/activityRepo.js';
import { createDb, type Db } from '../db/prisma.js';
import { ActivityBuffer } from './activityBuffer.js';
import { TimeoutTracker, timedOutWithin } from './timeoutTracker.js';
import { VoiceTracker } from './voiceTracker.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: 'silent' });
const GUILD = '900000000000000001';
const A = '100000000000000001';
const B = '100000000000000002';
const C = '100000000000000003';

describe.skipIf(!url)('activity storage', () => {
  const db: Db = createDb({ connectionString: url }, 3);

  beforeEach(async () => {
    await db.$transaction([
      db.activityDay.deleteMany(),
      db.activityAdjustment.deleteMany(),
      db.memberName.deleteMany(),
      db.voiceSession.deleteMany(),
      db.timeoutEvent.deleteMany(),
      db.channelWeight.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
  });
  afterAll(() => db.$disconnect());

  describe('ActivityBuffer', () => {
    it('adds to existing rows instead of replacing them', async () => {
      const buffer = new ActivityBuffer();
      buffer.add(A, '2026-10-20', { messages: 1, weightedMessages: 0.5 });
      buffer.add(A, '2026-10-20', { messages: 1, weightedMessages: 1, filteredMessages: 2 });
      buffer.setName(A, 'Alpha');
      await buffer.flush(db);
      buffer.add(A, '2026-10-20', { voiceMinutes: 3 });
      await buffer.flush(db);

      const row = await db.activityDay.findUniqueOrThrow({ where: { userId_serverDay: { userId: A, serverDay: '2026-10-20' } } });
      expect(row).toMatchObject({ messages: 2, weightedMessages: 1.5, voiceMinutes: 3, filteredMessages: 2 });
      expect((await db.memberName.findUniqueOrThrow({ where: { userId: A } })).name).toBe('Alpha');
      expect(buffer.pendingCount).toBe(0);
    });

    it('keeps counts when the database write fails, and saves them next time', async () => {
      const buffer = new ActivityBuffer();
      buffer.add(B, '2026-10-21', { messages: 1, weightedMessages: 1 });
      const broken = createDb({ connectionString: 'postgresql://nobody@127.0.0.1:1/none' }, 1);
      await expect(buffer.flush(broken)).rejects.toThrow();
      expect(buffer.pendingCount).toBe(1);
      expect(buffer.lastFlushError).not.toBeNull();

      buffer.add(B, '2026-10-21', { messages: 1, weightedMessages: 1 }); // arrives during the outage
      await buffer.flush(db);
      const row = await db.activityDay.findUniqueOrThrow({ where: { userId_serverDay: { userId: B, serverDay: '2026-10-21' } } });
      expect(row.messages).toBe(2);
      expect(buffer.lastFlushError).toBeNull();
      await broken.$disconnect();
    });

    it("doesn't rewrite unchanged names", async () => {
      const buffer = new ActivityBuffer();
      buffer.setName(A, 'Alpha');
      await buffer.flush(db);
      buffer.setName(A, 'Alpha');
      expect(buffer.pendingCount).toBe(0);
      buffer.setName(A, 'Alpha 2');
      expect(buffer.pendingCount).toBe(1);
    });
  });

  describe('standings', () => {
    it('ranks the last complete server-days with adjustments', async () => {
      const config = new ConfigStore(db, GUILD);
      await config.load();
      // Default config: 7-day window, America/Edmonton, voice weight 0.2.
      const now = new Date('2026-10-23T18:00:00Z'); // 2026-10-23 noon MDT
      await db.activityDay.createMany({
        data: [
          { userId: A, serverDay: '2026-10-22', messages: 10, weightedMessages: 10, voiceMinutes: 0 },
          { userId: B, serverDay: '2026-10-16', messages: 5, weightedMessages: 5, voiceMinutes: 30 },
          { userId: C, serverDay: '2026-10-23', messages: 50, weightedMessages: 50 }, // today: not in window
          { userId: C, serverDay: '2026-10-15', messages: 50, weightedMessages: 50 }, // too old
        ],
      });
      await db.activityAdjustment.create({ data: { userId: B, serverDay: '2026-10-18', amount: 0.5, reason: 'test', actorId: A } });

      const { window, ranked } = await loadStandings(db, config.current, now);
      expect(window[0]).toBe('2026-10-16');
      expect(window.at(-1)).toBe('2026-10-22');
      expect(ranked.map((s) => [s.userId, s.score])).toEqual([
        [B, 11.5],
        [A, 10],
      ]);
    });
  });

  describe('VoiceTracker', () => {
    function fakeClient(states: { id: string; channelId: string | null; bot?: boolean; selfDeaf?: boolean }[], afkChannelId: string | null = null) {
      const voiceStates = new Map(
        states.map((s) => [
          s.id,
          { id: s.id, channelId: s.channelId, selfDeaf: s.selfDeaf ?? false, serverDeaf: false, member: { user: { bot: s.bot ?? false } } },
        ]),
      );
      const guild = { id: GUILD, afkChannelId, voiceStates: { cache: voiceStates } };
      return { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
    }

    async function setup(states: Parameters<typeof fakeClient>[0], cap = 240) {
      const config = new ConfigStore(db, GUILD);
      await config.load();
      await db.guildConfig.update({ where: { guildId: GUILD }, data: { voiceDailyCapMinutes: cap } });
      await config.load();
      const buffer = new ActivityBuffer();
      return { buffer, voice: new VoiceTracker(fakeClient(states), GUILD, db, config, buffer, log) };
    }

    it('counts a minute for each member with someone else there', async () => {
      const { buffer, voice } = await setup([
        { id: A, channelId: 'vc1' },
        { id: B, channelId: 'vc1', selfDeaf: true },
        { id: C, channelId: 'vc2' }, // alone
      ]);
      const now = new Date('2026-10-23T18:00:00Z');
      await voice.tick(now);
      expect(buffer.pendingVoiceMinutes(A, '2026-10-23')).toBe(1);
      expect(buffer.pendingVoiceMinutes(B, '2026-10-23')).toBe(0); // deafened
      expect(buffer.pendingVoiceMinutes(C, '2026-10-23')).toBe(0);
    });

    it('stops at the daily cap, including minutes already saved', async () => {
      const { buffer, voice } = await setup(
        [
          { id: A, channelId: 'vc1' },
          { id: B, channelId: 'vc1' },
        ],
        3,
      );
      await db.activityDay.create({ data: { userId: A, serverDay: '2026-10-23', voiceMinutes: 2 } });
      const now = new Date('2026-10-23T18:00:00Z');
      for (let i = 0; i < 5; i++) await voice.tick(new Date(now.getTime() + i * 60_000));
      expect(buffer.pendingVoiceMinutes(A, '2026-10-23')).toBe(1);
      expect(buffer.pendingVoiceMinutes(B, '2026-10-23')).toBe(3);
    });

    it('closes stale sessions at their last heartbeat on startup and opens current ones', async () => {
      const beat = new Date('2026-10-20T10:00:00Z');
      await db.voiceSession.create({ data: { userId: C, channelId: 'old', startedAt: new Date('2026-10-20T09:00:00Z'), lastHeartbeat: beat } });
      const { voice } = await setup([{ id: A, channelId: 'vc1' }, { id: B, channelId: 'vc1', bot: true }]);
      await voice.start();
      await voice.heartbeat();

      const sessions = await db.voiceSession.findMany({ orderBy: { id: 'asc' } });
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({ userId: C, endedAt: beat });
      expect(sessions[1]).toMatchObject({ userId: A, channelId: 'vc1', endedAt: null });

      await voice.stop();
      expect((await db.voiceSession.findMany({ where: { endedAt: null } })).length).toBe(0);
    });
  });

  describe('TimeoutTracker', () => {
    it('saves a timeout once, whether seen live or in the audit log', async () => {
      const t = new TimeoutTracker(GUILD, db, log);
      const until = new Date('2026-10-21T12:00:00Z');
      await t.recordStart(A, new Date('2026-10-21T11:00:00.300Z'), until, 'member-update');
      await t.recordStart(A, new Date('2026-10-21T11:00:00Z'), until, 'audit-log');
      const rows = await db.timeoutEvent.findMany({ where: { userId: A } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe('member-update');
    });

    it('records an early removal', async () => {
      const t = new TimeoutTracker(GUILD, db, log);
      const until = new Date('2026-10-21T12:00:00Z');
      await t.recordStart(A, new Date('2026-10-21T11:00:00Z'), until, 'member-update');
      await t.recordEnd(A, until, new Date('2026-10-21T11:10:00Z'));
      expect((await db.timeoutEvent.findFirstOrThrow({ where: { userId: A } })).endedAt.toISOString()).toBe('2026-10-21T11:10:00.000Z');
    });

    it('timedOutWithin looks at when the timeout ended', async () => {
      const t = new TimeoutTracker(GUILD, db, log);
      await t.recordStart(A, new Date('2026-10-10T11:00:00Z'), new Date('2026-10-10T12:00:00Z'), 'audit-log');
      await t.recordStart(B, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-21T00:00:00Z'), 'audit-log'); // long timeout
      const now = new Date('2026-10-22T00:00:00Z');
      expect(await timedOutWithin(db, A, 3, now)).toBe(false);
      expect(await timedOutWithin(db, A, 14, now)).toBe(true);
      expect(await timedOutWithin(db, B, 3, now)).toBe(true);
      expect(await timedOutWithin(db, C, 30, now)).toBe(false);
    });

    it('handles live member updates: start, extend, remove', async () => {
      const t = new TimeoutTracker(GUILD, db, log);
      const now = new Date('2026-10-21T11:00:00Z');
      const first = new Date('2026-10-21T12:00:00Z');
      const extended = new Date('2026-10-21T14:00:00Z');
      const member = (until: Date | null) =>
        ({ id: A, partial: false, guild: { id: GUILD }, user: { bot: false }, communicationDisabledUntil: until }) as never;

      await t.onMemberUpdate(member(null), member(first), now);
      await t.onMemberUpdate(member(first), member(extended), new Date('2026-10-21T11:30:00Z'));
      await t.onMemberUpdate(member(extended), member(null), new Date('2026-10-21T12:30:00Z'));
      const rows = await db.timeoutEvent.findMany({ where: { userId: A }, orderBy: { until: 'asc' } });
      expect(rows.map((r) => [r.until.toISOString(), r.endedAt.toISOString()])).toEqual([
        ['2026-10-21T12:00:00.000Z', '2026-10-21T11:30:00.000Z'],
        ['2026-10-21T14:00:00.000Z', '2026-10-21T12:30:00.000Z'],
      ]);
    });
  });
});
