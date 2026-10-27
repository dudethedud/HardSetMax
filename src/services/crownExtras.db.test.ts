// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, PermissionFlagsBits, type Client, type Message } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { createDb, type Db } from '../db/prisma.js';
import type { Clock } from './clock.js';
import type { CrownService } from './crown.js';
import { CrownExtras } from './crownExtras.js';
import type { ModLog } from './modLog.js';
import { SpeechFilterService } from './speechFilter.js';
import type { VipService } from './vipService.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: 'silent' });
const GUILD = '900000000000000001';
const OWNER = '100000000000000099';
const STAFF_ROLE = '900000000000000098';
const BOT = '900000000000000097';
const id = (n: number) => `1000000000000000${String(n).padStart(2, '0')}`;
const NOW = new Date('2026-10-26T18:00:00Z');

describe.skipIf(!url)('Crown extras', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  let clockNow = NOW;
  const clock: Clock = { offsetMinutes: 0, now: () => clockNow };

  beforeEach(async () => {
    clockNow = NOW;
    await db.$transaction([
      db.crownHolder.deleteMany(),
      db.perkUse.deleteMany(),
      db.speechFilter.deleteMany(),
      db.speechOptOut.deleteMany(),
      db.staffRole.deleteMany(),
      db.blockedWord.deleteMany(),
      db.auditLog.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD } });
    await db.staffRole.create({ data: { roleId: STAFF_ROLE } });
    await db.crownHolder.create({ data: { userId: id(1), weekStart: '2026-10-26', awardedAt: NOW } });
  });
  afterAll(() => db.$disconnect());

  async function setup(vips: number[] = [1, 2]) {
    const member = (n: number) => ({
      id: id(n),
      user: { bot: n === 9 },
      displayName: `user${n}`,
      displayAvatarURL: () => `https://cdn.example/${n}.png`,
      permissions: { has: () => false },
      roles: { cache: new Collection(n === 5 ? [[STAFF_ROLE, { id: STAFF_ROLE }]] : []) },
    });
    const members = new Map([1, 2, 3, 5, 9].map((n) => [id(n), member(n)]));
    members.set(OWNER, { ...member(99), id: OWNER });
    const guild = { id: GUILD, ownerId: OWNER, members: { cache: members, fetch: (u: string) => Promise.resolve(members.get(u) ?? null), me: { id: BOT } } };
    const notices: { content: string; allowedMentions: unknown }[] = [];
    const client = {
      user: { id: BOT },
      guilds: { cache: new Map([[GUILD, guild]]) },
      channels: { fetch: () => Promise.resolve({ isSendable: () => true, send: (o: { content: string; allowedMentions: unknown }) => (notices.push(o), Promise.resolve()) }) },
    } as unknown as Client;
    const crown = { current: () => db.crownHolder.findFirst({ where: { endedAt: null } }) } as unknown as CrownService;
    const vipMap = new Map(vips.map((n) => [id(n), { since: '2026-10-01', pinned: false }]));
    const vip = { vips: vipMap } as unknown as VipService;
    const modLines: string[] = [];
    const modLog = { post: (t: string) => (modLines.push(t), Promise.resolve('m1')) } as unknown as ModLog;
    const config = new ConfigStore(db, GUILD);
    await config.load();
    let changes = 0;
    const extras = new CrownExtras(client, GUILD, db, config, crown, vip, modLog, clock);
    extras.onChange = () => void changes++;
    const speech = new SpeechFilterService(client, GUILD, db, crown, modLog, clock, log, () => 0.9);
    speech.noticeChannel = () => 'main-chat';
    return { extras, speech, modLines, notices, guild, changes: () => changes };
  }

  it('the pardon protects one VIP at one reshuffle, once a week, Crown only', async () => {
    const t = await setup();
    expect(await t.extras.pardon(id(2), id(1))).toMatch(/Only this week/);
    expect(await t.extras.pardon(id(1), id(1))).toMatch(/don't need/);
    expect(await t.extras.pardon(id(1), id(3))).toMatch(/current VIPs/);
    expect(await t.extras.pardon(id(1), id(2))).toMatch(/safe at the next reshuffle/);
    expect(await t.extras.protectedIds()).toEqual(new Set([id(2)]));
    expect(await t.extras.pardon(id(1), id(2))).toMatch(/already pardoned/);
    await t.extras.afterReshuffle();
    expect(await t.extras.protectedIds()).toEqual(new Set());
    expect((await t.extras.access(id(1), 'pardon')).ok).toBe(false);
  });

  it('mood is picked from the fixed list only', async () => {
    const t = await setup();
    expect(await t.extras.setMood(id(1), 'make carter say bad things')).toMatch(/Pick one/);
    expect(await t.extras.setMood(id(1), 'pirate')).toMatch(/Pirate pup/);
    expect(t.modLines).toEqual([]); // a fixed choice: audit log only
    expect((await db.crownHolder.findFirstOrThrow()).mood).toBe('pirate');
  });

  it('spotlight once a day and theme once a day, checked like shoutouts', async () => {
    const t = await setup();
    await db.blockedWord.create({ data: { word: 'badword' } });
    expect(await t.extras.spotlight(id(1), id(9), 'beep')).toMatch(/Bots/);
    expect(await t.extras.spotlight(id(1), id(3), 'such a b4dword')).toMatch(/isn't allowed/);
    expect(await t.extras.spotlight(id(1), id(3), 'carried the vc <@100000000000000002>')).toMatch(/is in the spotlight/);
    expect(await db.crownHolder.findFirstOrThrow()).toMatchObject({ spotlightId: id(3), spotlightReason: 'carried the vc' });
    expect(await t.extras.spotlight(id(1), id(2), 'again')).toMatch(/today’s spotlight/);
    expect(await t.extras.setTheme(id(1), 'spooky   season')).toMatch(/spooky season/);
    expect(await t.extras.theme()).toBe('spooky season');
    expect(await t.extras.setTheme(id(1), 'other')).toMatch(/changed the theme today/);
    expect(t.changes()).toBe(2);
    clockNow = new Date('2026-10-27T18:00:00Z');
    expect(await t.extras.setTheme(id(1), 'cosy week')).toMatch(/cosy week/);
  });

  it('speech filter: Crown once a week, staff any time, never on staff, the owner or bots; stops early', async () => {
    const t = await setup();
    expect(await t.speech.start(id(1), id(5), true)).toMatch(/Staff and the owner/);
    expect(await t.speech.start(id(1), OWNER, true)).toMatch(/Staff and the owner/);
    expect(await t.speech.start(id(1), id(9), true)).toMatch(/Bots/);
    expect(await t.speech.start(id(2), id(3), true)).toMatch(/Only this week/);
    expect(await t.speech.start(id(1), id(3), true)).toMatch(/10 minutes/);
    expect(t.modLines.at(-1)).toMatch(/\(Crown\) turned on the speech filter for/);
    // They're told (and pinged), with how to opt out.
    expect(t.notices.at(-1)).toMatchObject({ allowedMentions: { users: [id(3)] } });
    expect(t.notices.at(-1)!.content).toMatch(/Opt out/);
    expect(await t.speech.start(id(1), id(2), true)).toMatch(/already used/);
    // Staff aren't limited.
    expect(await t.speech.start(id(5), id(2), false)).toMatch(/10 minutes/);
    expect(await t.speech.stopFromLog(`🌈 <@${id(5)}> turned on the speech filter for <@${id(2)}> until`, id(5))).toMatch(/Stopped/);
    expect(await db.speechFilter.count()).toBe(1);
  });

  it('members can opt out (stopping one in progress) and opt back in', async () => {
    const t = await setup();
    await t.speech.start(id(5), id(3), false);
    expect(await t.speech.toggleOptOut(id(3))).toMatch(/opted out[\s\S]*has stopped/);
    expect(await db.speechFilter.count()).toBe(0);
    expect(await t.speech.start(id(1), id(3), true)).toMatch(/opted out/);
    expect(await t.speech.start(id(5), id(3), false)).toMatch(/opted out/);
    // The Crown's weekly use wasn't spent on a refusal.
    expect((await t.speech.crownAccess(id(1))).ok).toBe(true);
    expect(await t.speech.toggleOptOut(id(3))).toMatch(/can be used on you again/);
    expect(await t.speech.start(id(1), id(3), true)).toMatch(/10 minutes/);
  });

  it('a filtered member’s plain text is reposted with flair under their name, and the original deleted', async () => {
    const t = await setup();
    await t.speech.start(id(5), id(3), false);
    const sent: { content: string; username: string; allowedMentions: unknown }[] = [];
    let deleted = 0;
    const hook = { send: (o: { content: string; username: string; allowedMentions: unknown }) => (sent.push(o), Promise.resolve()) };
    const channel = {
      id: 'c1',
      isThread: () => false,
      createWebhook: () => Promise.resolve(hook),
      fetchWebhooks: () => Promise.resolve(new Map()),
      permissionsFor: () => ({ has: (p: bigint[]) => p.includes(PermissionFlagsBits.ManageWebhooks) }),
    };
    const message = (author: string, content: string, extra: Record<string, unknown> = {}) =>
      ({
        inGuild: () => true,
        guildId: GUILD,
        guild: t.guild,
        author: { id: author, bot: false },
        member: t.guild.members.cache.get(author),
        webhookId: null,
        content,
        attachments: new Collection(),
        stickers: new Collection(),
        poll: null,
        mentions: { users: new Collection() },
        reference: null,
        channel,
        channelId: 'c1',
        delete: () => (deleted++, Promise.resolve()),
        ...extra,
      }) as unknown as Message;
    await t.speech.handleMessage(message(id(3), 'hi guys'));
    expect(sent).toEqual([{ content: '🌈 heyyy gorgeous besties ~ 💖✨', username: 'user3 🌈', avatarURL: 'https://cdn.example/3.png', allowedMentions: { parse: [] } }]);
    expect(deleted).toBe(1);
    // Other members, attachments, and messages to the bot are left alone.
    await t.speech.handleMessage(message(id(2), 'hi'));
    await t.speech.handleMessage(message(id(3), 'look', { attachments: new Collection([['a', {}]]) }));
    await t.speech.handleMessage(message(id(3), 'hey carter', { mentions: { users: new Collection([[BOT, {}]]) } }));
    expect(sent).toHaveLength(1);
    // After 10 minutes it ends by itself.
    clockNow = new Date(NOW.getTime() + 11 * 60_000);
    await t.speech.handleMessage(message(id(3), 'hi again'));
    expect(sent).toHaveLength(1);
    expect(await db.speechFilter.count()).toBe(0);
  });
});
