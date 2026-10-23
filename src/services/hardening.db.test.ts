// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, PermissionFlagsBits, type Client } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { createDb, type Db } from '../db/prisma.js';
import type { Clock } from './clock.js';
import type { ModLog } from './modLog.js';
import { PermissionCheck } from './permissionCheck.js';
import { pruneOldData, runPruneJob } from './prune.js';
import { DailyScheduler } from './scheduler.js';
import { BOT_PERMISSIONS } from './setup.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: 'silent' });
const GUILD = '900000000000000001';
const VIP_ROLE = '900000000000000099';
const NOW = new Date('2026-10-26T18:00:00Z'); // 2026-10-26 in Edmonton
const DAY = 86_400_000;

describe.skipIf(!url)('hardening', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  const clock: Clock = { offsetMinutes: 0, now: () => NOW };

  beforeEach(async () => {
    await db.$transaction([
      db.activityDay.deleteMany(),
      db.activityAdjustment.deleteMany(),
      db.pollPost.deleteMany(),
      db.voiceSession.deleteMany(),
      db.timeoutEvent.deleteMany(),
      db.aiUsage.deleteMany(),
      db.modalDraft.deleteMany(),
      db.shoutout.deleteMany(),
      db.crownTitle.deleteMany(),
      db.auditLog.deleteMany(),
      db.vipStint.deleteMany(),
      db.colourOption.deleteMany(),
      db.badge.deleteMany(),
      db.customRole.deleteMany(),
      db.jobRun.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD, vipRoleId: VIP_ROLE } });
  });
  afterAll(() => db.$disconnect());

  it('prunes data older than 60 days and keeps history', async () => {
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const old = new Date(NOW.getTime() - 61 * DAY);
    const recent = new Date(NOW.getTime() - 59 * DAY);
    await db.activityDay.createMany({ data: [{ userId: '1', serverDay: '2026-08-26' }, { userId: '1', serverDay: '2026-08-27' }] }); // 61 and 60 days back
    await db.activityAdjustment.create({ data: { userId: '1', serverDay: '2026-08-01', amount: 1, reason: 'x', actorId: '2' } });
    await db.pollPost.create({ data: { userId: '1', messageId: 'm1', serverDay: '2026-08-01', kind: 'vip', accepted: true } });
    await db.voiceSession.createMany({ data: [{ userId: '1', channelId: 'c', endedAt: old }, { userId: '1', channelId: 'c', endedAt: recent }, { userId: '1', channelId: 'c' }] });
    await db.timeoutEvent.create({ data: { userId: '1', startedAt: old, until: old, endedAt: old, source: 'x' } });
    await db.aiUsage.createMany({ data: [{ provider: 'groq', providerDay: '2026-08-01' }, { provider: 'groq', providerDay: '2026-10-26' }] });
    await db.modalDraft.create({ data: { userId: '1', data: {}, expiresAt: old } });
    await db.shoutout.createMany({ data: [{ userId: '1', serverDay: '2026-08-01' }, { userId: '1', serverDay: '2026-10-20' }] });
    await db.auditLog.create({ data: { action: 'x', at: old } });
    await db.vipStint.create({ data: { userId: '1', startedAt: old, endedAt: old } });

    const deleted = await pruneOldData(db, config, NOW);
    expect(deleted).toEqual({ activityDays: 1, adjustments: 1, pollPosts: 1, voiceSessions: 1, timeouts: 1, aiUsage: 1, drafts: 1, shoutouts: 1 });
    expect((await db.activityDay.findMany()).map((d) => d.serverDay)).toEqual(['2026-08-27']);
    expect(await db.voiceSession.count()).toBe(2); // recent and still open
    expect(await db.auditLog.count()).toBe(1); // kept forever
    expect(await db.vipStint.count()).toBe(1);

    await runPruneJob(db, config, clock, log, '2026-10-25');
    await runPruneJob(db, config, clock, log, '2026-10-25');
    expect(await db.jobRun.count({ where: { job: 'prune', status: 'succeeded' } })).toBe(1);
  });

  it('pauses scheduled jobs while the database is down, and catches up after', async () => {
    const config = new ConfigStore(db, GUILD);
    await config.load();
    let up = false;
    const s = new DailyScheduler(config, clock, log, () => up);
    const ran: string[] = [];
    s.register('job', (p) => (ran.push(p), Promise.resolve()));
    await s.check();
    expect(ran).toEqual([]);
    up = true;
    await s.check();
    expect(ran).toEqual(['2026-10-25']);
  });

  it('the permission check reports problems once, and when they’re fixed', async () => {
    const config = new ConfigStore(db, GUILD);
    await config.load();
    let perms = new Set<bigint>(BOT_PERMISSIONS.filter((p) => p !== PermissionFlagsBits.ManageRoles));
    let botPosition = 5;
    const roles = new Collection([[VIP_ROLE, { id: VIP_ROLE, name: 'VIP', position: 10 }]]);
    const guild = {
      id: GUILD,
      roles: { cache: roles },
      members: { fetchMe: () => Promise.resolve({ permissions: { has: (p: bigint) => perms.has(p) }, roles: { highest: { position: botPosition } } }) },
    };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
    const posts: string[] = [];
    const check = new PermissionCheck(client, GUILD, db, config, { post: (t: string) => (posts.push(t), Promise.resolve()) } as unknown as ModLog);

    await check.run();
    await check.run();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('ManageRoles');
    expect(posts[0]).toContain("below roles it manages (VIP)");

    perms = new Set(BOT_PERMISSIONS);
    botPosition = 20;
    await check.run();
    expect(posts.at(-1)).toBe('✅ Bot setup problems fixed.');
  });
});
