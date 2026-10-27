// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, describe, expect, it } from 'vitest';
import type { Guild } from 'discord.js';
import { createDb, type Db } from '../db/prisma.js';
import { freshStart } from './freshStart.js';

const url = process.env['TEST_DATABASE_URL'];
const GUILD = '900000000000000001';
const A = '100000000000000001';

describe.skipIf(!url)('/bot fresh-start', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  afterAll(() => db.$disconnect());

  it('wipes activity and VIP history, keeps the setup, and tidies Discord first', async () => {
    await db.$transaction([
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
      db.blockedWord.deleteMany({ where: { word: 'keepme' } }),
      db.speechOptOut.deleteMany({ where: { userId: A } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD, weeklyFrom: '2026-10-28', vipRoleId: '900000000000000050' } });
    await db.blockedWord.create({ data: { word: 'keepme' } });
    await db.speechOptOut.create({ data: { userId: A } });
    await db.activityDay.create({ data: { userId: A, serverDay: '2026-10-20', weightedMessages: 9 } });
    await db.vipMember.upsert({ where: { userId: A }, create: { userId: A, since: '2026-10-20' }, update: {} });
    await db.treat.create({ data: { giverId: A, serverDay: '2026-10-20', receiverId: '100000000000000002' } });
    await db.tempVoiceChannel.deleteMany();
    await db.tempVoiceChannel.create({ data: { channelId: '900000000000000777', ownerId: A } });

    const steps: string[] = [];
    let deleted = false;
    const guild = { id: GUILD, channels: { cache: new Map([['900000000000000777', { delete: () => ((deleted = true), Promise.resolve()) }]]) } } as unknown as Guild;
    const counts = await freshStart(
      guild,
      {
        db,
        endCrown: () => (steps.push('crown'), Promise.resolve()),
        resetCustomRole: () => Promise.resolve(),
        clearTitles: () => (steps.push('titles'), Promise.resolve()),
        discardPending: () => void steps.push('discard'),
        reload: () => (steps.push('reload'), Promise.resolve()),
      },
      A,
    );
    expect(steps).toEqual(['crown', 'titles', 'discard', 'reload']);
    expect(deleted).toBe(true);
    expect(counts.activityDays).toBeGreaterThanOrEqual(1);
    expect(await db.activityDay.count()).toBe(0);
    expect(await db.vipMember.count()).toBe(0);
    expect(await db.treat.count()).toBe(0);
    expect(await db.tempVoiceChannel.count()).toBe(0);
    // Kept: settings (weeklyFrom cleared), blocked words, opt-outs and the audit log.
    expect(await db.guildConfig.findUnique({ where: { guildId: GUILD } })).toMatchObject({ vipRoleId: '900000000000000050', weeklyFrom: null });
    expect(await db.blockedWord.count({ where: { word: 'keepme' } })).toBe(1);
    expect(await db.speechOptOut.count({ where: { userId: A } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'bot.fresh-start' } })).toBeGreaterThanOrEqual(1);
  });
});
