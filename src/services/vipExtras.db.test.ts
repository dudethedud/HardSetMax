// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { Client } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { createDb, type Db } from '../db/prisma.js';
import type { Clock } from './clock.js';
import { ColourRequestService } from './colourRequests.js';
import type { ColourService } from './colours.js';
import type { ModLog } from './modLog.js';
import { ShoutoutService } from './shoutouts.js';
import { TreatService } from './treats.js';
import type { VipService } from './vipService.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: 'silent' });
const GUILD = '900000000000000001';
const MAIN_CHAT = '900000000000000010';
const id = (n: number) => `1000000000000000${String(n).padStart(2, '0')}`;
const NOW = new Date('2026-10-26T18:00:00Z'); // Monday noon, America/Denver

describe.skipIf(!url)('VIP extras', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  let clockNow = NOW;
  const clock: Clock = { offsetMinutes: 0, now: () => clockNow };

  beforeEach(async () => {
    clockNow = NOW;
    await db.$transaction([
      db.treat.deleteMany(),
      db.colourRequest.deleteMany(),
      db.colourOption.deleteMany({ where: { name: { in: ['Peach Fizz', 'Ocean Glow'] } } }),
      db.shoutout.deleteMany(),
      db.perkUse.deleteMany(),
      db.blockedWord.deleteMany(),
      db.auditLog.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD, mainChatChannelId: MAIN_CHAT, modLogChannelId: '900000000000000011' } });
  });
  afterAll(() => db.$disconnect());

  async function setup(vips: Record<string, string>, opts: { failSend?: boolean; members?: number[] } = {}) {
    const sent: { channelId: string; content: string; allowedMentions: unknown }[] = [];
    const members = new Map((opts.members ?? [1, 2, 3]).map((n) => [id(n), { id: id(n), user: { bot: n === 9 } }]));
    const guild = { members: { cache: members, fetch: (u: string) => Promise.resolve(members.get(u) ?? null) } };
    const client = {
      guilds: { cache: new Map([[GUILD, guild]]) },
      channels: {
        fetch: (channelId: string) =>
          Promise.resolve({
            isSendable: () => true,
            send: (o: { content: string; allowedMentions: unknown }) => (opts.failSend ? Promise.reject(new Error('Missing Access')) : (sent.push({ channelId, ...o }), Promise.resolve({ id: `m${sent.length}`, url: `https://discord.com/m${sent.length}` }))),
          }),
      },
    } as unknown as Client;
    const vipMap = new Map(Object.entries(vips).map(([u, since]) => [u, { since, pinned: false }]));
    const vip = { vips: vipMap, hasPerk: (u: string) => vipMap.has(u) } as unknown as VipService;
    const modLines: { text: string; components: number }[] = [];
    let nextMod = 0;
    const modLog = { post: (text: string, _i?: unknown, extra?: { components?: unknown[] }) => (modLines.push({ text, components: extra?.components?.length ?? 0 }), Promise.resolve(`mod${nextMod++}`)) } as unknown as ModLog;
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const options: { name: string }[] = [{ name: 'Ocean Glow' }];
    const added: string[] = [];
    const colours = {
      options: () => Promise.resolve(options),
      addOption: (name: string, hex: string, _a: string, hex2?: string) => (added.push(`${name} ${hex} ${hex2}`), options.push({ name }), Promise.resolve(`✅ Added **${name}**.`)),
    } as unknown as ColourService;
    const treats = new TreatService(client, GUILD, db, config, vip, modLog, clock, log, () => 0);
    const requests = new ColourRequestService(db, config, vip, colours, modLog, clock, () => Promise.resolve(['✅ roles', '⚠️ something to check']));
    const shoutouts = new ShoutoutService(client, db, config, vip, modLog, clock, log);
    return { treats, requests, shoutouts, sent, modLines, added };
  }

  it('a VIP gives one treat a day to someone else; it shows in the counts and the weekly top', async () => {
    const t = await setup({ [id(1)]: '2026-10-20', [id(2)]: '2026-10-20' });
    expect(await t.treats.give(id(3), id(1))).toMatch(/VIP perk/);
    expect(await t.treats.give(id(1), id(1))).toMatch(/someone else/);
    expect(await t.treats.give(id(1), id(77))).toMatch(/not in the server/);
    expect(await t.treats.give(id(1), id(3))).toMatch(/Treat given/);
    expect(t.sent[0]).toMatchObject({ channelId: MAIN_CHAT, allowedMentions: { parse: [] } });
    expect(t.sent[0]!.content).toContain(`<@${id(1)}> gave <@${id(3)}> a treat!`);
    expect(await t.treats.give(id(1), id(2))).toMatch(/today's treat/);
    expect(await t.treats.give(id(2), id(3))).toMatch(/Treat given/);
    expect(await t.treats.received(id(3), new Date(NOW.getTime() - 1000))).toEqual({ total: 2, recent: 2 });
    expect(await t.treats.top(new Date(NOW.getTime() - 3600_000), new Date(NOW.getTime() + 3600_000))).toEqual({ userId: id(3), count: 2 });
    // Tomorrow it's back.
    clockNow = new Date('2026-10-27T18:00:00Z');
    expect((await t.treats.access(id(1))).ok).toBe(true);
  });

  it('a failed treat post gives the day’s treat back', async () => {
    const t = await setup({ [id(1)]: '2026-10-20' }, { failSend: true });
    expect(await t.treats.give(id(1), id(2))).toMatch(/Couldn't/);
    expect((await t.treats.access(id(1))).ok).toBe(true);
  });

  it('veterans (14+ days) get a second shoutout a day; others get one', async () => {
    const t = await setup({ [id(1)]: '2026-10-01', [id(2)]: '2026-10-20' });
    expect(await t.shoutouts.post(id(1), 'one')).toMatch(/posted/);
    expect(await t.shoutouts.post(id(1), 'two')).toMatch(/posted/);
    expect(await t.shoutouts.post(id(1), 'three')).toMatch(/used today's shoutout/);
    expect(await t.shoutouts.post(id(2), 'one')).toMatch(/posted/);
    expect(await t.shoutouts.post(id(2), 'two')).toMatch(/used today's shoutout/);
  });

  it('colour requests go to staff with buttons; one open request, one a week; approving adds the colour once', async () => {
    const t = await setup({ [id(1)]: '2026-10-20', [id(2)]: '2026-10-20' });
    expect(await t.requests.submit(id(3), { name: 'Peach Fizz', hex: '#FFB38A', hex2: '#FF6FB5' })).toMatch(/VIP perk/);
    expect(await t.requests.submit(id(1), { name: 'Ocean Glow', hex: '#FFB38A', hex2: '#FF6FB5' })).toMatch(/already a colour/);
    expect(await t.requests.submit(id(1), { name: 'Peach Fizz', hex: '#FFB38A', hex2: '#FF6FB5' })).toMatch(/Sent!/);
    expect(t.modLines.at(-1)).toMatchObject({ components: 1 });
    expect(await t.requests.submit(id(1), { name: 'Other', hex: '#FFB38A', hex2: '#FF6FB5' })).toMatch(/still waiting/);
    // Someone else can't take the same name while it's pending.
    expect(await t.requests.submit(id(2), { name: 'peach fizz', hex: '#FFB38A', hex2: '#FF6FB5' })).toMatch(/already a colour/);

    const messageId = (await db.colourRequest.findFirstOrThrow()).messageId!;
    expect(await t.requests.decide(messageId, id(5), true)).toMatch(/Added \*\*Peach Fizz\*\*[\s\S]*something to check/);
    expect(t.added).toEqual(['Peach Fizz #FFB38A #FF6FB5']);
    expect(await t.requests.decide(messageId, id(6), false)).toMatch(/already approved/);
    expect(t.added).toHaveLength(1);
    expect(await t.requests.submit(id(1), { name: 'Next', hex: '#FFB38A', hex2: '#FF6FB5' })).toMatch(/One request a week/);
    clockNow = new Date(NOW.getTime() + 8 * 24 * 3600_000);
    expect((await t.requests.access(id(1))).ok).toBe(true);
  });

  it('declining a request', async () => {
    const t = await setup({ [id(1)]: '2026-10-20' });
    await t.requests.submit(id(1), { name: 'Peach Fizz', hex: '#FFB38A', hex2: '#FF6FB5' });
    const messageId = (await db.colourRequest.findFirstOrThrow()).messageId!;
    expect(await t.requests.decide(messageId, id(5), false)).toMatch(/Declined/);
    expect(t.added).toEqual([]);
    expect((await db.colourRequest.findFirstOrThrow()).status).toBe('declined');
  });
});
