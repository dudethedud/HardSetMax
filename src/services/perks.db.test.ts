// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, PermissionFlagsBits, type Client } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import type { Candidate, ReshuffleResult } from '../core/reshuffle.js';
import { createDb, type Db } from '../db/prisma.js';
import type { Clock } from './clock.js';
import { CrownService } from './crown.js';
import { CrownPowers } from './crownPowers.js';
import type { ModLog } from './modLog.js';
import type { RoleOp, RoleQueue } from './roleQueue.js';
import { ShoutoutService } from './shoutouts.js';
import type { VipService } from './vipService.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: process.env['TEST_LOG'] ?? 'silent' });
const GUILD = '900000000000000001';
const CROWN_ROLE = '900000000000000080';
const STAFF_ROLE = '900000000000000098';
const ANNOUNCE = '900000000000000070';
const MAIN_CHAT = '900000000000000071';
const OWNER = '100000000000000099';
const id = (n: number) => `1000000000000000${String(n).padStart(2, '0')}`;
const NOW = new Date('2026-10-26T06:00:30Z'); // Monday 00:00:30 in the server's timezone

const cand = (n: number, score: number): Candidate => ({ userId: id(n), score, activeDays: 1, lastDayScore: 0, lastActiveDay: '2026-10-25', eligibility: 'eligible' });
const result = (ranked: Candidate[], finalVips: number[]): ReshuffleResult => ({ ranked, finalVips: finalVips.map(id), added: [], removed: [] });

describe.skipIf(!url)('VIP and Crown perks', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  let clockNow = NOW;
  const clock: Clock = { offsetMinutes: 0, now: () => clockNow };

  beforeEach(async () => {
    clockNow = NOW;
    await db.$transaction([
      db.crownHolder.deleteMany(),
      db.crownTitle.deleteMany(),
      db.customRole.deleteMany(),
      db.shoutout.deleteMany(),
      db.blockedWord.deleteMany(),
      db.staffRole.deleteMany(),
      db.jobRun.deleteMany(),
      db.auditLog.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD, crownRoleId: CROWN_ROLE, announceChannelId: ANNOUNCE, mainChatChannelId: MAIN_CHAT } });
    await db.staffRole.create({ data: { roleId: STAFF_ROLE } });
  });
  afterAll(() => db.$disconnect());

  async function setup(opts: { members: number[]; staff?: number[]; bots?: number[]; vips?: number[]; failSend?: boolean }) {
    const memberRoles = new Map<string, Set<string>>();
    const nicks = new Map<string, string | null>();
    const all = [...opts.members, ...(opts.staff ?? []), ...(opts.bots ?? [])];
    for (const n of all) {
      memberRoles.set(id(n), new Set(opts.staff?.includes(n) ? [STAFF_ROLE] : []));
      nicks.set(id(n), n === 1 ? 'Ace' : null);
    }
    const member = (uid: string) => {
      if (!memberRoles.has(uid)) return undefined;
      const n = Number(uid.slice(-2));
      return {
        id: uid,
        user: { bot: opts.bots?.includes(n) ?? false },
        get nickname() {
          return nicks.get(uid) ?? null;
        },
        get displayName() {
          return nicks.get(uid) ?? `user${n}`;
        },
        manageable: true,
        permissions: { has: (p: bigint) => p === PermissionFlagsBits.Administrator && false },
        roles: { cache: new Collection([...memberRoles.get(uid)!].map((r) => [r, { id: r }])) },
        setNickname: (nick: string | null) => (nicks.set(uid, nick), Promise.resolve()),
      };
    };
    const roles = new Collection<string, { id: string; position: number; members: Collection<string, unknown>; edit: () => Promise<unknown>; setPosition: () => Promise<unknown> }>();
    let nextRole = 0;
    const addRole = (rid: string, position: number) => {
      const role = {
        id: rid,
        position,
        get members() {
          return new Collection([...memberRoles].filter(([, s]) => s.has(rid)).map(([uid]) => [uid, {}]));
        },
        edit: () => Promise.resolve(role),
        setPosition: () => Promise.resolve(role),
      };
      roles.set(rid, role);
      return role;
    };
    addRole(CROWN_ROLE, 20);
    const guild = {
      id: GUILD,
      ownerId: OWNER,
      premiumTier: 0,
      members: { cache: { get: member, has: (uid: string) => memberRoles.has(uid) }, fetch: (uid: string) => Promise.resolve(member(uid) ?? null) },
      roles: { cache: roles, create: () => Promise.resolve(addRole(`90000000000000200${nextRole++}`, 10)) },
    };
    const sent: { channelId: string; content: string; allowedMentions: unknown }[] = [];
    const channel = (channelId: string) => ({
      isSendable: () => true,
      send: (o: { content: string; allowedMentions: unknown }) => {
        if (opts.failSend) return Promise.reject(new Error('Missing Access'));
        sent.push({ channelId, ...o });
        return Promise.resolve({ id: `m${sent.length}`, url: `https://discord.com/m${sent.length}` });
      },
    });
    const client = { guilds: { cache: new Map([[GUILD, guild]]) }, channels: { fetch: (cid: string) => Promise.resolve(channel(cid)) } } as unknown as Client;
    const queue = {
      run: (op: RoleOp) => {
        const set = memberRoles.get(op.userId);
        if (set && op.action === 'add') set.add(op.roleId);
        if (set && op.action === 'remove') set.delete(op.roleId);
        return Promise.resolve({ ok: true });
      },
    } as unknown as RoleQueue;
    const modLog = { post: () => Promise.resolve() } as unknown as ModLog;
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const crown = new CrownService(client, GUILD, db, config, queue, modLog, clock, log);
    const powers = new CrownPowers(client, GUILD, db, config, crown, queue, modLog, clock, log);
    crown.onAwarded.push((h, p) => powers.onAwarded(h, p));
    crown.onEnded.push((h, why, c) => powers.onEnded(h, why, c));
    const vip = { vips: new Map((opts.vips ?? []).map((n) => [id(n), { since: '2026-10-20', pinned: false }])) } as unknown as VipService;
    const shoutouts = new ShoutoutService(client, db, config, vip, modLog, clock, log);
    const report: string[] = [];
    await powers.setup(guild as never, {} as never, report);
    return { crown, powers, shoutouts, memberRoles, nicks, sent, report };
  }

  const titleRole = async (slot: string) => (await db.crownTitle.findUnique({ where: { slot } }))!.roleId!;

  it('setup creates a role per title', async () => {
    const t = await setup({ members: [1] });
    const titles = await t.powers.titles();
    expect(titles.map((x) => x.slot)).toEqual(['champion', 'advisor', 'jester']);
    expect(titles.every((x) => x.roleId)).toBe(true);
  });

  it('only the Crown appoints; not to bots, staff or themselves; one title per person', async () => {
    const t = await setup({ members: [1, 2, 3], staff: [4], bots: [5] });
    await t.crown.afterReshuffle('2026-10-26', result([cand(1, 90)], [1]));
    expect(await t.powers.appoint(id(2), 'champion', id(3))).toMatch(/Only this week/);
    expect(await t.powers.appoint(id(1), 'champion', id(1))).toMatch(/yourself/);
    expect(await t.powers.appoint(id(1), 'champion', id(4))).toMatch(/Staff/);
    expect(await t.powers.appoint(id(1), 'champion', id(5))).toMatch(/Bots/);
    expect(await t.powers.appoint(id(1), 'champion', id(77))).toMatch(/not in the server/);

    expect(await t.powers.appoint(id(1), 'champion', id(2))).toMatch(/is now/);
    expect(t.memberRoles.get(id(2))!.has(await titleRole('champion'))).toBe(true);
    // Giving them another title moves them.
    expect(await t.powers.appoint(id(1), 'jester', id(2))).toMatch(/moved from/);
    expect(t.memberRoles.get(id(2))!.has(await titleRole('champion'))).toBe(false);
    expect(t.memberRoles.get(id(2))!.has(await titleRole('jester'))).toBe(true);
    // Clearing.
    expect(await t.powers.appoint(id(1), 'jester', null)).toMatch(/now empty/);
    expect(t.memberRoles.get(id(2))!.has(await titleRole('jester'))).toBe(false);
  });

  it('titles end with the Crown week and when the Crown is lost', async () => {
    const t = await setup({ members: [1, 2, 3] });
    await t.crown.afterReshuffle('2026-10-26', result([cand(1, 90)], [1]));
    await t.powers.appoint(id(1), 'advisor', id(2));
    // Next week, same winner: titles still reset.
    clockNow = new Date('2026-11-02T07:00:30Z');
    await t.crown.afterReshuffle('2026-11-02', result([cand(1, 90)], [1]));
    expect((await t.powers.titles()).every((x) => !x.holderId)).toBe(true);
    expect(t.memberRoles.get(id(2))!.has(await titleRole('advisor'))).toBe(false);

    await t.powers.appoint(id(1), 'advisor', id(3));
    await t.crown.onVipRemoved(id(1), 'removed by an admin');
    expect((await t.powers.titles()).every((x) => !x.holderId)).toBe(true);
    expect(t.memberRoles.get(id(3))!.has(await titleRole('advisor'))).toBe(false);
  });

  it('the 👑 nickname goes on with the Crown, stays for a repeat win, and comes off after', async () => {
    const t = await setup({ members: [1, 2] });
    await t.crown.afterReshuffle('2026-10-26', result([cand(1, 90)], [1]));
    expect(t.nicks.get(id(1))).toBe('👑 Ace');
    clockNow = new Date('2026-11-02T07:00:30Z');
    await t.crown.afterReshuffle('2026-11-02', result([cand(1, 90)], [1]));
    expect(t.nicks.get(id(1))).toBe('👑 Ace');
    clockNow = new Date('2026-11-09T07:00:30Z');
    await t.crown.afterReshuffle('2026-11-09', result([cand(2, 90)], [2]));
    expect(t.nicks.get(id(1))).toBe('Ace'); // restored to their old nickname
    expect(t.nicks.get(id(2))).toBe('👑 user2');
    await t.crown.onVipRemoved(id(2), 'left');
    expect(t.nicks.get(id(2))).toBeNull(); // they had no nickname before
  });

  it('a renamed member keeps their new name when the Crown ends', async () => {
    const t = await setup({ members: [1] });
    await t.crown.afterReshuffle('2026-10-26', result([cand(1, 90)], [1]));
    t.nicks.set(id(1), 'Brand New');
    await t.crown.onVipRemoved(id(1), 'removed');
    expect(t.nicks.get(id(1))).toBe('Brand New');
  });

  it('an admin can hand the Crown over mid-week: the old holder loses it, the new one gets everything', async () => {
    const t = await setup({ members: [1, 2, 3] });
    // Nobody yet: giving it also marks this week's award as done.
    expect(await t.crown.giveManually(id(1), id(9))).toMatch(/now holds the Crown/);
    expect((await t.crown.current())?.userId).toBe(id(1));
    expect(await t.crown.afterReshuffle('2026-10-27', result([cand(2, 99)], [2]))).toBeNull();
    expect(t.nicks.get(id(1))).toBe('👑 Ace');
    await t.powers.appoint(id(1), 'champion', id(3));

    expect(await t.crown.giveManually(id(1), id(9))).toMatch(/already holds/);
    await t.crown.giveManually(id(2), id(9));
    expect((await t.crown.current())?.userId).toBe(id(2));
    expect(t.memberRoles.get(id(1))!.has(CROWN_ROLE)).toBe(false);
    expect(t.memberRoles.get(id(2))!.has(CROWN_ROLE)).toBe(true);
    expect(t.nicks.get(id(1))).toBe('Ace');
    expect(t.nicks.get(id(2))).toBe('👑 user2');
    expect((await t.powers.titles()).every((x) => !x.holderId)).toBe(true);
    expect((await t.crown.current())?.decreeAt).toBeNull();
    // Next week's award works as usual.
    clockNow = new Date('2026-11-02T07:00:30Z');
    expect(await t.crown.afterReshuffle('2026-11-02', result([cand(3, 99)], [3]))).toBe(id(3));
  });

  it('one decree per Crown week, with no pings; a failed post can be retried', async () => {
    const t = await setup({ members: [1, 2] });
    expect(await t.powers.decree(id(1), 'hi')).toMatch(/Only this week/);
    await t.crown.afterReshuffle('2026-10-26', result([cand(1, 90)], [1]));
    expect(await t.powers.decree(id(1), 'Double XP friday <@&123> @everyone')).toMatch(/decree is up/);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.channelId).toBe(ANNOUNCE);
    expect(t.sent[0]!.allowedMentions).toEqual({ parse: [] });
    expect(t.sent[0]!.content).not.toContain('<@&123>');
    expect(t.sent[0]!.content).not.toMatch(/@everyone/);
    expect(await t.powers.decree(id(1), 'again')).toMatch(/already made/);
    // The text isn't saved anywhere.
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain('Double XP');

    const f = await setup({ members: [1], failSend: true });
    await db.crownHolder.updateMany({ data: { decreeAt: null } });
    expect(await f.powers.decree(id(1), 'hello')).toMatch(/Couldn't post/);
    expect((await f.crown.current())!.decreeAt).toBeNull();
  });

  it('shoutouts: VIPs only, once per server-day, no pings, blocked words checked', async () => {
    const t = await setup({ members: [1, 2], vips: [1] });
    await db.blockedWord.create({ data: { word: 'badword' } });
    expect(await t.shoutouts.post(id(2), 'hi')).toMatch(/VIP perk/);
    expect(await t.shoutouts.post(id(1), 'what a b4dword')).toMatch(/isn't allowed/);
    expect(await t.shoutouts.post(id(1), 'Love you all <@100000000000000002>')).toMatch(/posted/);
    expect(t.sent[0]).toMatchObject({ channelId: MAIN_CHAT, allowedMentions: { parse: [] } });
    expect(t.sent[0]!.content).not.toContain('<@100000000000000002>');
    expect(await t.shoutouts.post(id(1), 'again')).toMatch(/used today's shoutout/);
    // Next server-day it's back.
    clockNow = new Date('2026-10-27T06:00:30Z');
    expect((await t.shoutouts.access(id(1))).ok).toBe(true);
  });

  it('a failed shoutout post gives the day’s shoutout back', async () => {
    const t = await setup({ members: [1], vips: [1], failSend: true });
    expect(await t.shoutouts.post(id(1), 'hello')).toMatch(/Couldn't post/);
    expect((await t.shoutouts.access(id(1))).ok).toBe(true);
  });
});
