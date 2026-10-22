// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { Client } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import type { Candidate, ReshuffleResult } from '../core/reshuffle.js';
import { createDb, type Db } from '../db/prisma.js';
import { ActivityBuffer } from './activityBuffer.js';
import { BadgeService } from './badges.js';
import type { Clock } from './clock.js';
import type { ModLog } from './modLog.js';
import { RecapService } from './recap.js';
import type { RoleOp, RoleQueue } from './roleQueue.js';
import { RESHUFFLE_JOB, VipService } from './vipService.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: process.env['TEST_LOG'] ?? 'silent' });
const GUILD = '900000000000000001';
const VIP_ROLE = '900000000000000099';
const ANNOUNCE = '900000000000000050';
const id = (n: number) => `1000000000000000${String(n).padStart(2, '0')}`;
const NOW = new Date('2026-10-26T06:00:30Z'); // Monday 2026-10-26, 00:00:30 MDT
const DAY = 86_400_000;

describe.skipIf(!url)('badges and weekly recap', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  const clock: Clock = { offsetMinutes: 0, now: () => NOW };

  beforeEach(async () => {
    await db.$transaction([
      db.userBadge.deleteMany(),
      db.badge.deleteMany(),
      db.activityDay.deleteMany(),
      db.memberName.deleteMany(),
      db.vipMember.deleteMany(),
      db.vipStint.deleteMany(),
      db.crownHolder.deleteMany(),
      db.jobRun.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD, vipRoleId: VIP_ROLE, announceChannelId: ANNOUNCE, vipSlots: 2 } });
    await db.badge.createMany({
      data: [
        { weeks: 4, name: 'VIP Regular', roleId: '900000000000000091' },
        { weeks: 12, name: 'VIP Veteran', roleId: '900000000000000092' },
      ],
    });
  });
  afterAll(() => db.$disconnect());

  function fakes(memberIds: string[]) {
    const sent: { content: string; allowedMentions: unknown }[] = [];
    const ops: RoleOp[] = [];
    const roles = new Map(memberIds.map((m) => [m, new Set<string>()]));
    const member = (m: string) => ({ id: m, user: { bot: false }, roles: { cache: new Map([...(roles.get(m) ?? [])].map((r) => [r, {}])) }, isCommunicationDisabled: () => false });
    const guild = {
      id: GUILD,
      members: { cache: { get: (m: string) => (roles.has(m) ? member(m) : undefined), has: (m: string) => roles.has(m), keys: () => roles.keys() } },
      roles: { cache: { get: (r: string) => (r === VIP_ROLE ? { members: new Map([...roles].filter(([, s]) => s.has(VIP_ROLE)).map(([m]) => [m, {}])) } : undefined) } },
    };
    const client = {
      guilds: { cache: new Map([[GUILD, guild]]) },
      channels: { fetch: () => Promise.resolve({ isSendable: () => true, send: (m: { content: string; allowedMentions: unknown }) => (sent.push(m), Promise.resolve()) }) },
    } as unknown as Client;
    const queue = {
      run: (op: RoleOp) => {
        ops.push(op);
        const set = roles.get(op.userId);
        if (set && op.action === 'add') set.add(op.roleId);
        if (set && op.action === 'remove') set.delete(op.roleId);
        return Promise.resolve({ ok: true });
      },
    } as unknown as RoleQueue;
    const modLog = { post: () => Promise.resolve() } as unknown as ModLog;
    return { client, queue, modLog, sent, ops, roles };
  }

  async function services(memberIds: string[]) {
    const f = fakes(memberIds);
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const vip = new VipService(f.client, GUILD, db, config, new ActivityBuffer(), f.queue, f.modLog, clock, log);
    const badges = new BadgeService(f.client, GUILD, db, config, f.queue, f.modLog, log);
    vip.badges = badges;
    await vip.load();
    return { ...f, vip, badges, recap: new RecapService(f.client, db, config, f.modLog, clock, log) };
  }

  /** A current VIP who has held VIP (unpinned) for `days` days, and is active. */
  async function veteran(n: number, days: number, pinnedDays = 0) {
    const start = new Date(NOW.getTime() - (days + pinnedDays) * DAY);
    await db.vipMember.create({ data: { userId: id(n), since: '2026-01-01' } });
    if (pinnedDays) {
      await db.vipStint.create({ data: { userId: id(n), startedAt: start, endedAt: new Date(start.getTime() + pinnedDays * DAY), pinned: true } });
    }
    await db.vipStint.create({ data: { userId: id(n), startedAt: new Date(start.getTime() + pinnedDays * DAY) } });
    await db.activityDay.create({ data: { userId: id(n), serverDay: '2026-10-25', messages: 50, weightedMessages: 50 } });
  }

  it('the reshuffle gives badges once reached, saves them, gives roles and mentions them (no pings) in the post', async () => {
    await veteran(1, 29);
    await veteran(2, 27);
    const t = await services([id(1), id(2)]);
    await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-25');
    expect((await db.userBadge.findMany()).map((b) => b.userId)).toEqual([id(1)]);
    expect(t.roles.get(id(1))!.has('900000000000000091')).toBe(true);
    expect(t.sent).toHaveLength(1); // no VIP changes, but the badge counts as one
    expect(t.sent[0]!.content).toBe(`⭐ **VIP update**\n🏅 <@${id(1)}> earned **VIP Regular**`);
    expect(t.sent[0]!.allowedMentions).toEqual({ users: [] });

    // Next day: nothing new, nothing posted.
    await db.jobRun.deleteMany();
    await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-26');
    expect(await db.userBadge.count()).toBe(1);
    expect(t.sent).toHaveLength(1);
  });

  it('pinned time doesn’t count', async () => {
    await veteran(1, 20, 60);
    expect(await (await services([id(1)])).badges.pending(NOW)).toEqual([]);
  });

  it('badges stay after VIP is lost', async () => {
    await veteran(1, 29);
    const t = await services([id(1)]);
    await t.vip.runReshuffle(RESHUFFLE_JOB, '2026-10-25');
    await t.vip.removeVip(id(1), 'timed out');
    expect(await db.userBadge.count()).toBe(1);
    expect(t.roles.get(id(1))!.has('900000000000000091')).toBe(true);
  });

  it('the recap covers last week, once, with no pings', async () => {
    const t = await services([id(1), id(2), id(3)]);
    await db.vipMember.createMany({ data: [{ userId: id(1), since: '2026-10-20' }, { userId: id(2), since: '2026-10-03' }] });
    await db.crownHolder.create({ data: { userId: id(1), weekStart: '2026-10-26' } });
    const lastWeek = (d: number) => new Date(NOW.getTime() - d * DAY);
    await db.jobRun.createMany({
      data: [
        { job: RESHUFFLE_JOB, period: '2026-10-19', status: 'succeeded', finishedAt: lastWeek(6), detail: { added: [{}, {}] } },
        { job: 'reshuffle-manual', period: 'x', status: 'succeeded', finishedAt: lastWeek(3), detail: { added: [{}] } },
        { job: RESHUFFLE_JOB, period: '2026-10-11', status: 'succeeded', finishedAt: lastWeek(9), detail: { added: [{}, {}, {}] } }, // older
      ],
    });
    const badge = await db.badge.findFirstOrThrow();
    await db.userBadge.create({ data: { userId: id(3), badgeId: badge.id, awardedAt: lastWeek(2) } });

    const c = (n: number, score: number): Candidate => ({ userId: id(n), score, activeDays: 1, lastDayScore: 0, lastActiveDay: null, eligibility: 'eligible' });
    const result: ReshuffleResult = { ranked: [c(1, 212), c(2, 150), c(3, 99), c(4, 50)], finalVips: [id(1), id(2)], added: [], removed: [] };
    await t.recap.afterReshuffle('2026-10-26', result);
    await t.recap.afterReshuffle('2026-10-27', result); // same week: no second post

    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.allowedMentions).toEqual({ parse: [] });
    expect(t.sent[0]!.content).toBe(
      [
        '📅 **Weekly VIP recap** (2026-10-19 to 2026-10-25)',
        `👑 Crown of the week: <@${id(1)}>`,
        `🏆 Top 3: 🥇 <@${id(1)}> (212) · 🥈 <@${id(2)}> (150) · 🥉 <@${id(3)}> (99)`,
        `⏳ Longest-standing VIP: <@${id(2)}> (23 days in a row)`,
        '🔄 VIP swaps this week: 3',
        `🏅 Badges earned: <@${id(3)}> VIP Regular`,
      ].join('\n'),
    );
  });
});
