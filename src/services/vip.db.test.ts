// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
// Uses (and empties) the activity and VIP tables in that database.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { Client } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { createDb, type Db } from '../db/prisma.js';
import { ActivityBuffer } from './activityBuffer.js';
import type { Clock } from './clock.js';
import { claimJob } from './jobs.js';
import type { ModLog } from './modLog.js';
import type { RoleOp, RoleQueue } from './roleQueue.js';
import { DailyScheduler } from './scheduler.js';
import { RESHUFFLE_JOB, VipService } from './vipService.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: 'silent' });
const GUILD = '900000000000000001';
const VIP_ROLE = '900000000000000099';
const STAFF_ROLE = '900000000000000098';
const ANNOUNCE = '900000000000000050';
const id = (n: number) => `1000000000000000${String(n).padStart(2, '0')}`;

// 2026-10-23 00:00:30 MDT: just after the boundary that closed 2026-10-22.
const NOW = new Date('2026-10-23T06:00:30Z');

interface FakeMember {
  id: string;
  roles: Set<string>;
  bot?: boolean;
  timedOut?: boolean;
}

function fakeDiscord(members: FakeMember[]) {
  const sent: { content: string; allowedMentions: unknown }[] = [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const asMember = (m: FakeMember) => ({
    id: m.id,
    user: { bot: m.bot ?? false },
    roles: { cache: new Map([...m.roles].map((r) => [r, { id: r }])) },
    isCommunicationDisabled: () => m.timedOut ?? false,
  });
  const guild = {
    id: GUILD,
    members: { cache: { get: (i: string) => (byId.has(i) ? asMember(byId.get(i)!) : undefined), has: (i: string) => byId.has(i), keys: () => byId.keys() } },
    roles: {
      cache: {
        get: (r: string) =>
          r === VIP_ROLE ? { id: VIP_ROLE, members: new Map(members.filter((m) => m.roles.has(VIP_ROLE)).map((m) => [m.id, m])) } : undefined,
      },
    },
  };
  const client = {
    guilds: { cache: new Map([[GUILD, guild]]) },
    channels: {
      fetch: (cid: string) =>
        Promise.resolve(
          cid === ANNOUNCE
            ? { isSendable: () => true, send: (msg: { content: string; allowedMentions: unknown }) => (sent.push(msg), Promise.resolve()) }
            : null,
        ),
    },
  } as unknown as Client;

  const ops: RoleOp[] = [];
  const roles = {
    run: (op: RoleOp) => {
      ops.push(op);
      const m = byId.get(op.userId);
      if (m && op.action === 'add') m.roles.add(op.roleId);
      if (m && op.action === 'remove') m.roles.delete(op.roleId);
      return Promise.resolve({ ok: true });
    },
    idle: () => Promise.resolve(),
  } as unknown as RoleQueue;
  const modLines: string[] = [];
  const modLog = { post: (t: string) => (modLines.push(t), Promise.resolve()) } as unknown as ModLog;
  return { client, roles, modLog, sent, ops, modLines, byId };
}

describe.skipIf(!url)('VIP service', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  let clockNow = NOW;
  const clock: Clock = { offsetMinutes: 0, now: () => clockNow };

  beforeEach(async () => {
    clockNow = NOW;
    await db.$transaction([
      db.activityDay.deleteMany(),
      db.activityAdjustment.deleteMany(),
      db.memberName.deleteMany(),
      db.timeoutEvent.deleteMany(),
      db.vipMember.deleteMany(),
      db.vipStint.deleteMany(),
      db.vipBlock.deleteMany(),
      db.staffRole.deleteMany(),
      db.jobRun.deleteMany(),
      db.auditLog.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD, vipRoleId: VIP_ROLE, announceChannelId: ANNOUNCE, vipSlots: 2 } });
  });
  afterAll(() => db.$disconnect());

  async function setup(members: FakeMember[]) {
    const fake = fakeDiscord(members);
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const vip = new VipService(fake.client, GUILD, db, config, new ActivityBuffer(), fake.roles, fake.modLog, clock, log);
    await vip.load();
    return { ...fake, vip, config };
  }

  /** Activity on 2026-10-22 (inside the window, and recent enough to be active). */
  async function activity(scores: Record<number, number>) {
    await db.activityDay.createMany({
      data: Object.entries(scores).map(([n, score]) => ({ userId: id(Number(n)), serverDay: '2026-10-22', messages: score, weightedMessages: score })),
    });
    await db.memberName.createMany({ data: Object.keys(scores).map((n) => ({ userId: id(Number(n)), name: `Member ${n}` })) });
  }

  it('the scheduled reshuffle fills slots, saves everything, gives roles and announces', async () => {
    const t = await setup([1, 2, 3].map((n) => ({ id: id(n), roles: new Set<string>() })));
    await activity({ 1: 50, 2: 40, 3: 30 });

    const run = await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-22');
    expect(run.status).toBe('done');
    expect([...t.vip.vips.keys()].sort()).toEqual([id(1), id(2)]);
    expect((await db.vipMember.findMany()).map((v) => [v.userId, v.since]).sort()).toEqual([
      [id(1), '2026-10-23'],
      [id(2), '2026-10-23'],
    ]);
    expect(await db.vipStint.count({ where: { endedAt: null } })).toBe(2);
    expect(t.ops.map((o) => [o.userId, o.action])).toEqual([
      [id(1), 'add'],
      [id(2), 'add'],
    ]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.content).toContain(`<@${id(1)}> → filled an open slot`);
    expect(t.sent[0]!.allowedMentions).toEqual({ users: [id(1), id(2)] });

    const job = await db.jobRun.findUniqueOrThrow({ where: { job_period: { job: RESHUFFLE_JOB, period: '2026-10-22' } } });
    expect(job.status).toBe('succeeded');
    expect((job.detail as { posted: boolean }).posted).toBe(true);
    expect(t.modLines.filter((l) => l.startsWith('⭐'))).toHaveLength(2);
  });

  it('runs exactly once per period, even after a restart', async () => {
    const t = await setup([{ id: id(1), roles: new Set() }]);
    await activity({ 1: 50 });
    expect((await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-22')).status).toBe('done');
    expect((await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-22')).status).toBe('skipped');
    const restarted = await setup([{ id: id(1), roles: new Set([VIP_ROLE]) }]);
    expect((await restarted.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-22')).status).toBe('skipped');
    expect(await db.vipStint.count()).toBe(1);
  });

  it('a later reshuffle replaces a VIP who dropped, and pairs them in the announcement', async () => {
    const t = await setup([1, 2, 3].map((n) => ({ id: id(n), roles: new Set<string>() })));
    await activity({ 1: 50, 2: 40 });
    await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-22');
    await db.guildConfig.update({ where: { guildId: GUILD }, data: { vipBuffer: 0, vipMinHoldDays: 0 } });
    await t.config.load();
    // Next day: member 3 is very active, member 2 isn't.
    await db.activityDay.create({ data: { userId: id(3), serverDay: '2026-10-23', messages: 500, weightedMessages: 500 } });
    clockNow = new Date('2026-10-24T06:00:30Z');

    await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-23');
    expect([...t.vip.vips.keys()].sort()).toEqual([id(1), id(3)]);
    expect(t.sent.at(-1)!.content).toBe(`⭐ **VIP update**\n<@${id(3)}> → replaced Member 2`);
    expect(t.sent.at(-1)!.allowedMentions).toEqual({ users: [id(3)] });
    expect(await db.vipStint.findFirst({ where: { userId: id(2) } })).toMatchObject({ endReason: 'dropped to #3' });
  });

  it('skips until /setup run has created the VIP role', async () => {
    await db.guildConfig.update({ where: { guildId: GUILD }, data: { vipRoleId: null } });
    const t = await setup([]);
    expect((await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-22')).status).toBe('skipped');
    expect(await db.jobRun.count()).toBe(0);
  });

  it('respects staff roles, blocks and recent timeouts', async () => {
    const t = await setup([
      { id: id(1), roles: new Set([STAFF_ROLE]) },
      { id: id(2), roles: new Set() },
      { id: id(3), roles: new Set() },
      { id: id(4), roles: new Set() },
    ]);
    await db.staffRole.create({ data: { roleId: STAFF_ROLE } });
    await db.vipBlock.create({ data: { userId: id(2), until: new Date('2026-11-01T00:00:00Z'), reason: 'test', actorId: id(9) } });
    await db.timeoutEvent.create({
      data: { userId: id(3), startedAt: new Date('2026-10-21T00:00:00Z'), until: new Date('2026-10-21T01:00:00Z'), endedAt: new Date('2026-10-21T01:00:00Z'), source: 'audit-log' },
    });
    await activity({ 1: 90, 2: 80, 3: 70, 4: 20 });
    await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-22');
    expect([...t.vip.vips.keys()]).toEqual([id(4)]);
  });

  it('the shared removal routine ends the stint, removes the role and runs cleanup hooks', async () => {
    const t = await setup([{ id: id(1), roles: new Set() }]);
    const hooked: string[] = [];
    t.vip.onRemoved.push((userId, reason) => (hooked.push(`${userId}:${reason}`), Promise.resolve()));
    await t.vip.addVip(id(1), 'test', false, id(9));
    expect(t.byId.get(id(1))!.roles.has(VIP_ROLE)).toBe(true);

    expect(await t.vip.removeVip(id(1), 'timed out')).toBe(true);
    expect(await t.vip.removeVip(id(1), 'timed out')).toBe(false);
    expect(t.byId.get(id(1))!.roles.has(VIP_ROLE)).toBe(false);
    expect(await db.vipMember.count()).toBe(0);
    expect(await db.vipStint.findFirst()).toMatchObject({ endReason: 'timed out' });
    expect(hooked).toEqual([`${id(1)}:timed out`]);
  });

  it('pinning and unpinning split the stint', async () => {
    const t = await setup([{ id: id(1), roles: new Set() }]);
    await t.vip.addVip(id(1), 'test', false, id(9));
    clockNow = new Date(NOW.getTime() + 3600_000);
    await t.vip.setPinned(id(1), true, id(9));
    clockNow = new Date(NOW.getTime() + 7200_000);
    await t.vip.setPinned(id(1), false, id(9));
    const stints = await db.vipStint.findMany({ orderBy: { id: 'asc' } });
    expect(stints.map((s) => [s.pinned, s.endReason, s.endedAt === null])).toEqual([
      [false, 'pinned', false],
      [true, 'unpinned', false],
      [false, null, true],
    ]);
  });

  it('reconcile removes hand-given roles and restores missing ones', async () => {
    const t = await setup([
      { id: id(1), roles: new Set([VIP_ROLE]) }, // given by hand
      { id: id(2), roles: new Set() }, // VIP in DB, role missing
    ]);
    await db.vipMember.create({ data: { userId: id(2), since: '2026-10-20' } });
    await t.vip.load();
    expect(await t.vip.reconcile()).toEqual({ added: 1, removed: 1 });
    expect(t.byId.get(id(1))!.roles.has(VIP_ROLE)).toBe(false);
    expect(t.byId.get(id(2))!.roles.has(VIP_ROLE)).toBe(true);
  });

  it('reconcile removes VIP from members who left while the bot was offline', async () => {
    const t = await setup([]);
    await db.vipMember.create({ data: { userId: id(5), since: '2026-10-20' } });
    await db.vipStint.create({ data: { userId: id(5) } });
    await t.vip.load();
    await t.vip.reconcile();
    expect(await db.vipMember.count()).toBe(0);
    expect(await db.vipStint.findFirst()).toMatchObject({ endReason: 'left the server' });
  });

  it('posts an announcement that was saved but not sent', async () => {
    const t = await setup([]);
    await db.jobRun.create({
      data: {
        job: RESHUFFLE_JOB,
        period: '2026-10-22',
        status: 'succeeded',
        finishedAt: NOW,
        detail: { added: [], removed: [], posted: false, announcement: { content: '⭐ **VIP update**\nx', pingUserIds: [] } },
      },
    });
    await t.vip.postPendingAnnouncements();
    await t.vip.postPendingAnnouncements();
    expect(t.sent).toHaveLength(1);
  });

  it('claimJob: one claim per period; a crashed run can be re-claimed after 10 min; a failure after 5', async () => {
    expect(await claimJob(db, 'test', 'p1', NOW)).toBe(true);
    expect(await claimJob(db, 'test', 'p1', NOW)).toBe(false);
    expect(await claimJob(db, 'test', 'p1', new Date(NOW.getTime() + 11 * 60_000))).toBe(true);
    await db.jobRun.update({ where: { job_period: { job: 'test', period: 'p1' } }, data: { status: 'failed', finishedAt: NOW } });
    expect(await claimJob(db, 'test', 'p1', new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(await claimJob(db, 'test', 'p1', new Date(NOW.getTime() + 6 * 60_000))).toBe(true);
    const results = await Promise.all([claimJob(db, 'test', 'p2', NOW), claimJob(db, 'test', 'p2', NOW), claimJob(db, 'test', 'p2', NOW)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('the scheduler runs the day that just closed, once', async () => {
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const s = new DailyScheduler(config, clock, log);
    expect(s.duePeriod(new Date('2026-10-23T05:59:00Z'))).toBe('2026-10-21'); // 23:59 on the 22nd
    expect(s.duePeriod(new Date('2026-10-23T06:00:00Z'))).toBe('2026-10-22'); // midnight
    const periods: string[] = [];
    s.register('test', (p) => (periods.push(p), Promise.resolve()));
    await s.check();
    expect(periods).toEqual(['2026-10-22']);
  });
});
