// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { ChannelType, Collection, type Client } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { createDb, type Db } from '../db/prisma.js';
import type { Clock } from './clock.js';
import type { ModLog } from './modLog.js';
import { TempVoiceService } from './tempVoice.js';
import type { VipService } from './vipService.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: process.env['TEST_LOG'] ?? 'silent' });
const GUILD = '900000000000000001';
const CATEGORY = '900000000000000040';
const id = (n: number) => `1000000000000000${String(n).padStart(2, '0')}`;
const T0 = new Date('2026-10-26T18:00:00Z');

describe.skipIf(!url)('temporary VIP voice', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  let now = T0;
  const clock: Clock = { offsetMinutes: 0, now: () => now };

  beforeEach(async () => {
    now = T0;
    await db.$transaction([db.tempVoiceChannel.deleteMany(), db.blockedWord.deleteMany(), db.guildConfig.deleteMany({ where: { guildId: GUILD } })]);
    await db.guildConfig.create({ data: { guildId: GUILD, loungeCategoryId: CATEGORY } });
  });
  afterAll(() => db.$disconnect());

  async function setup(vipIds: number[]) {
    type Ch = { id: string; type: ChannelType; name: string; userLimit: number; members: Collection<string, { user: { bot: boolean } }>; sent: unknown[] };
    const channels = new Collection<string, Ch>();
    let next = 0;
    const make = (name: string): Ch => {
      const ch: Ch & Record<string, unknown> = {
        id: `90000000000000200${next++}`,
        type: ChannelType.GuildVoice,
        name,
        userLimit: 0,
        members: new Collection(),
        sent: [],
      };
      ch['send'] = (m: unknown) => (ch.sent.push(m), Promise.resolve());
      ch['setName'] = (n: string) => ((ch.name = n), Promise.resolve(ch));
      ch['setUserLimit'] = (l: number) => ((ch.userLimit = l), Promise.resolve(ch));
      ch['delete'] = () => (channels.delete(ch.id), Promise.resolve());
      channels.set(ch.id, ch);
      return ch;
    };
    const guild = {
      id: GUILD,
      channels: { cache: channels, create: (o: { name: string }) => Promise.resolve(make(o.name)) },
      members: { cache: { get: (u: string) => ({ displayName: `Member ${u.slice(-2)}` }) } },
    };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
    const vips = new Set(vipIds.map(id));
    const vip = { vips: { has: (u: string) => vips.has(u) }, hasPerk: (u: string) => vips.has(u) } as unknown as VipService;
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const modLog = { post: () => Promise.resolve() } as unknown as ModLog;
    const service = new TempVoiceService(client, GUILD, db, config, vip, modLog, clock, log);
    const join = (channelId: string, user: string, bot = false) => channels.get(channelId)!.members.set(user, { user: { bot } });
    const leave = (channelId: string, user: string) => channels.get(channelId)!.members.delete(user);
    return { service, channels, vips, join, leave };
  }

  const at = (s: number) => new Date(T0.getTime() + s * 1000);
  const channelOf = async (owner: string) => (await db.tempVoiceChannel.findUniqueOrThrow({ where: { ownerId: owner } })).channelId;

  it('VIPs create one channel each, in the lounge, named after them, with owner controls', async () => {
    const t = await setup([1]);
    expect(await t.service.create(id(2))).toContain('VIPs only');
    expect(await t.service.create(id(1))).toContain('Created');
    const ch = t.channels.get(await channelOf(id(1)))!;
    expect(ch.name).toBe("Member 01's room");
    expect(ch.sent).toHaveLength(1);
    expect(await t.service.create(id(1))).toContain('already have');
    expect(t.channels.size).toBe(1);
  });

  it('is deleted after 60 s empty, not while someone is in it', async () => {
    const t = await setup([1]);
    await t.service.create(id(1));
    const cid = await channelOf(id(1));
    now = at(30);
    t.join(cid, id(1));
    await t.service.sweep();
    now = at(200);
    await t.service.sweep();
    expect(t.channels.has(cid)).toBe(true);

    t.leave(cid, id(1));
    t.join(cid, id(9), true); // only a bot left: counts as empty
    now = at(210);
    await t.service.sweep();
    now = at(269);
    await t.service.sweep();
    expect(t.channels.has(cid)).toBe(true);
    now = at(270);
    await t.service.sweep();
    expect(t.channels.has(cid)).toBe(false);
    expect(await db.tempVoiceChannel.count()).toBe(0);
  });

  it('never joined: removed after a minute', async () => {
    const t = await setup([1]);
    await t.service.create(id(1));
    now = at(61);
    await t.service.sweep();
    expect(t.channels.size).toBe(0);
  });

  it('the owner leaving while others stay keeps it; owner losing VIP deletes it once empty', async () => {
    const t = await setup([1]);
    await t.service.create(id(1));
    const cid = await channelOf(id(1));
    t.join(cid, id(2));
    t.vips.delete(id(1));
    await t.service.onVipRemoved(id(1));
    expect(t.channels.has(cid)).toBe(true);
    t.leave(cid, id(2));
    await t.service.sweep();
    expect(t.channels.has(cid)).toBe(false);
  });

  it('only the owner can rename or set the limit; names are checked; 2 renames per 10 minutes', async () => {
    const t = await setup([1]);
    await db.blockedWord.create({ data: { word: 'rude' } });
    await t.service.create(id(1));
    const cid = await channelOf(id(1));
    expect(await t.service.rename(id(2), cid, 'mine now')).toContain('Only the channel owner');
    expect(await t.service.rename(id(1), cid, 'so RUDE')).toContain('❌');
    expect(await t.service.rename(id(1), cid, 'Chill zone')).toContain('Chill zone');
    expect(await t.service.rename(id(1), cid, 'Chill zone 2')).toContain('✅');
    expect(await t.service.rename(id(1), cid, 'Chill zone 3')).toContain('2 renames per 10 minutes');
    expect(t.channels.get(cid)!.name).toBe('Chill zone 2');
    expect(await t.service.setLimit(id(2), cid, 5)).toContain('Only the channel owner');
    expect(await t.service.setLimit(id(1), cid, 5)).toBe('✅ User limit: 5.');
    expect(t.channels.get(cid)!.userLimit).toBe(5);
  });

  it('startup: deletes empty saved channels, forgets ones deleted by hand, keeps busy ones', async () => {
    const t = await setup([1, 2, 3]);
    for (const n of [1, 2, 3]) await t.service.create(id(n));
    const [c1, c2, c3] = [await channelOf(id(1)), await channelOf(id(2)), await channelOf(id(3))];
    t.join(c1, id(1));
    t.channels.delete(c3); // deleted by hand while offline
    await t.service.start();
    expect(t.channels.has(c1)).toBe(true);
    expect(t.channels.has(c2)).toBe(false);
    expect((await db.tempVoiceChannel.findMany()).map((r) => r.channelId)).toEqual([c1]);
    expect((await db.tempVoiceChannel.findUniqueOrThrow({ where: { channelId: c1 } })).emptySince).toBeNull();
  });
});
