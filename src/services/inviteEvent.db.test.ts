// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, PermissionFlagsBits, type Client, type Guild, type GuildMember, type Invite } from 'discord.js';
import { createDb, type Db } from '../db/prisma.js';
import { InviteEventService } from './inviteEvent.js';

const url = process.env['TEST_DATABASE_URL'];
const GUILD = '900000000000000001';
const BOARD = '900000000000000070';
const STAFF = '900000000000000071';
const LEVEL3 = '900000000000000072';
const BOT = '900000000000000099';
const INVITER = '100000000000000001';
const OTHER = '100000000000000002';
const OLD_MEMBER = '100000000000000003';
const DAY = 24 * 3600_000;
// The event starts Sunday Nov 22 2026, 13:00 Edmonton (UTC-6); ends Dec 25 12:00.
const START = new Date('2026-11-22T19:00:00Z');
const END = new Date('2026-12-25T18:00:00Z');

describe.skipIf(!url)('invite event', () => {
  const db: Db = createDb({ connectionString: url }, 3);

  beforeEach(async () => {
    await db.$transaction([
      db.inviteJoin.deleteMany(),
      db.inviteEventState.deleteMany(),
      db.personalInvite.deleteMany(),
      db.knownMember.deleteMany(),
      db.disqualifiedInviter.deleteMany(),
      db.inviteFlag.deleteMany(),
      db.settings.deleteMany(),
    ]);
  });
  afterAll(() => db.$disconnect());

  function setup(opts: { manageServer?: boolean } = {}) {
    const clock = { now: START };
    const sent: { channelId: string; embed: { title?: string; description?: string; footer?: { text: string } } }[] = [];
    const invites = new Map<string, { uses: number; inviterId: string | null }>();
    const perms = { manage: opts.manageServer ?? true };
    const member = (id: string, o: { roles?: string[]; accountDays?: number; avatar?: string | null; bot?: boolean; name?: string } = {}) =>
      ({
        id,
        guild,
        user: { id, username: o.name ?? `user${id.slice(-4)}`, bot: o.bot ?? false, avatar: o.avatar === undefined ? 'abc' : o.avatar, createdAt: new Date(clock.now.getTime() - (o.accountDays ?? 400) * DAY) },
        roles: { cache: new Collection((o.roles ?? []).map((r) => [r, {}])) },
      }) as unknown as GuildMember;
    const members = new Collection<string, GuildMember>();
    const channel = (channelId: string) => ({
      id: channelId,
      isSendable: () => true,
      send: (o: { embeds: { toJSON(): (typeof sent)[number]['embed'] }[] }) => (sent.push({ channelId, embed: o.embeds[0]!.toJSON() }), Promise.resolve({})),
      createInvite: () => {
        const code = `personal${invites.size}`;
        invites.set(code, { uses: 0, inviterId: BOT });
        return Promise.resolve({ code, uses: 0, inviterId: BOT });
      },
    });
    const guild = {
      id: GUILD,
      features: [] as string[],
      vanityURLCode: null,
      invites: { fetch: () => Promise.resolve(new Collection([...invites].map(([code, i]) => [code, { code, ...i }]))) },
      members: {
        me: { permissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageGuild && perms.manage } },
        fetch: (id?: string) => (id === undefined ? Promise.resolve(members) : members.has(id) ? Promise.resolve(members.get(id)) : Promise.reject(new Error('Unknown Member'))),
      },
      channels: { fetch: (id: string) => Promise.resolve(channel(id)) },
    } as unknown as Guild;
    const client = {
      guilds: { cache: new Map([[GUILD, guild]]) },
      channels: { fetch: (id: string) => Promise.resolve(channel(id)) },
      users: { fetch: (id: string) => Promise.resolve({ id, username: id === INVITER ? 'inviter' : `user${id.slice(-4)}` }) },
    } as unknown as Client;
    const service = new InviteEventService(client, GUILD, db, pino({ level: 'silent' }), { end: END, leaderboardChannelId: BOARD, level3RoleId: LEVEL3, staffLogChannelId: STAFF, inviteLinkChannelId: null, color: 0xa8d8f0 }, () => clock.now);

    /** Someone joins through `code` (its uses go up first, as Discord does). */
    const join = async (id: string, code: string | null, o: Parameters<typeof member>[1] = {}) => {
      if (code) invites.get(code)!.uses++;
      const m = member(id, o);
      members.set(id, m);
      await service.onMemberAdd(m);
      return m;
    };
    const status = async (id: string) => (await db.inviteJoin.findUnique({ where: { inviteeId: id } }))?.status;
    const later = (days: number) => (clock.now = new Date(clock.now.getTime() + days * DAY));
    return { service, guild, clock, sent, invites, members, perms, member, join, status, later };
  }

  it('credits the inviter, waits 7 days and the level 3 role, then counts on the leaderboard', async () => {
    const t = setup();
    t.invites.set('abc', { uses: 4, inviterId: INVITER });
    t.members.set(OLD_MEMBER, t.member(OLD_MEMBER));
    await t.service.start(t.guild);
    expect(t.service.enabled).toBe(true);

    const a = await t.join('200000000000000001', 'abc');
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: a.id } })).toMatchObject({ inviterId: INVITER, inviteCode: 'abc', source: 'invite', status: 'pending' });

    t.later(8);
    await t.service.evaluateAll(t.guild);
    expect(await t.status(a.id)).toBe('pending'); // no level 3 yet
    t.members.set(a.id, t.member(a.id, { roles: [LEVEL3] }));
    await t.service.evaluateAll(t.guild);
    expect(await t.status(a.id)).toBe('valid');
    expect((await t.service.leaderboard()).toJSON().description).toBe(`🥇 <@${INVITER}> ── **1** invite`);
    expect((await t.service.invitesOf(INVITER)).toJSON().description).toContain('**1** valid invite = **1** raffle entry · #1 on the leaderboard');

    // Leaving before the end stops it counting.
    t.members.delete(a.id);
    await t.service.onMemberRemove(a.id, GUILD);
    expect(await t.status(a.id)).toBe('left');
  });

  it('never guesses: two invites used at once, vanity and discovery joins credit nobody', async () => {
    const t = setup();
    t.invites.set('a', { uses: 0, inviterId: INVITER });
    t.invites.set('b', { uses: 0, inviterId: OTHER });
    await t.service.start(t.guild);
    t.invites.get('a')!.uses++;
    await t.join('200000000000000002', 'b');
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: '200000000000000002' } })).toMatchObject({ source: 'unknown', inviterId: null, status: 'invalid' });
    // Nothing went up: unknown, or discovery in a discoverable server.
    (t.guild.features as string[]).push('DISCOVERABLE');
    await t.join('200000000000000003', null);
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: '200000000000000003' } })).toMatchObject({ source: 'discovery', inviterId: null });
  });

  it('rule 4: people already here when the event started, and rejoins, never count', async () => {
    const t = setup();
    t.invites.set('abc', { uses: 0, inviterId: INVITER });
    t.members.set(OLD_MEMBER, t.member(OLD_MEMBER));
    await t.service.start(t.guild);
    t.members.delete(OLD_MEMBER);
    await t.join(OLD_MEMBER, 'abc');
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: OLD_MEMBER } })).toMatchObject({ rejoin: true, status: 'invalid', invalidReason: 'joined the server before' });
    // Joining twice keeps one row.
    await t.join(OLD_MEMBER, 'abc');
    expect(await db.inviteJoin.count()).toBe(1);
  });

  it('personal links are credited to their owner, not the bot that made them', async () => {
    const t = setup();
    await t.service.start(t.guild);
    const link = await t.service.personalLink(t.member(INVITER));
    expect(link).toContain('https://discord.gg/personal0');
    expect(await t.service.personalLink(t.member(INVITER))).toContain('personal0'); // same link again
    await t.join('200000000000000004', 'personal0');
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: '200000000000000004' } })).toMatchObject({ source: 'personal', inviterId: INVITER });
  });

  it('no Manage Server: tracking is off, staff are told once, joins credit nobody', async () => {
    const t = setup({ manageServer: false });
    t.invites.set('abc', { uses: 0, inviterId: INVITER });
    await t.service.start(t.guild);
    expect(t.service.enabled).toBe(false);
    expect(t.sent.filter((s) => s.channelId === STAFF).map((s) => s.embed.title)).toEqual(['⚠️ Invite tracking is OFF']);
    await t.join('200000000000000005', 'abc');
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: '200000000000000005' } })).toMatchObject({ source: 'unknown', inviterId: null });
    expect(await t.service.personalLink(t.member(INVITER))).toMatch(/tracking is off/);
    // Fixed later: the hourly re-check turns it back on.
    t.perms.manage = true;
    t.later(5 / (24 * 60)); // 5 minutes
    await t.service.tick(t.guild);
    expect(t.service.enabled).toBe(false); // checked under an hour ago
    t.later(1);
    await t.service.tick(t.guild);
    expect(t.service.enabled).toBe(true);
    expect(t.sent.filter((s) => s.channelId === STAFF).map((s) => s.embed.title)).toEqual(['⚠️ Invite tracking is OFF', '🎄 Invite tracking is back on']);
  });

  it('flags likely alts to staff once each, and never changes anything by itself', async () => {
    const t = setup();
    t.invites.set('abc', { uses: 0, inviterId: INVITER });
    await t.service.start(t.guild);
    await t.join('200000000000000006', 'abc', { avatar: null, accountDays: 40, name: 'fresh' });
    const flags = t.sent.filter((s) => s.channelId === STAFF && s.embed.title === '🚩 Possible alt invites');
    expect(flags).toHaveLength(1);
    expect(flags[0]!.embed.description).toContain('default avatar and an account under 90 days old');
    expect(await t.status('200000000000000006')).toBe('pending');
    await t.service.evaluateAll(t.guild);
    expect(t.sent.filter((s) => s.embed.title === '🚩 Possible alt invites')).toHaveLength(1);
  });

  it('staff: disqualify and reinstate, set a status by hand, export the raffle', async () => {
    const t = setup();
    t.invites.set('abc', { uses: 0, inviterId: INVITER });
    await t.service.start(t.guild);
    await t.join('200000000000000007', 'abc', { roles: [LEVEL3] });
    await t.join('200000000000000008', 'abc', { roles: [LEVEL3] });
    t.later(8);
    await t.service.evaluateAll(t.guild);
    expect(await t.status('200000000000000007')).toBe('valid');

    expect(await t.service.disqualify(INVITER, 'alts', OTHER)).toMatch(/disqualified/);
    expect(await t.status('200000000000000007')).toBe('disqualified');
    await t.service.evaluateAll(t.guild);
    expect(await t.status('200000000000000007')).toBe('disqualified');
    await t.service.reinstate(INVITER, OTHER);
    expect(await t.status('200000000000000007')).toBe('valid');

    expect(await t.service.setStatus('200000000000000008', 'invalid', 'same person', OTHER)).toMatch(/now \*\*invalid\*\* \(same person\)/);
    await t.service.evaluateAll(t.guild);
    expect(await t.status('200000000000000008')).toBe('invalid');
    expect(await t.service.review(INVITER)).toContain('same person');

    const { csv, summary } = await t.service.raffleExport();
    expect(csv).toBe('"inviter"\n');
    expect(summary).toMatch(/\*\*1\*\* raffle entry from \*\*1\*\* inviter \(not final yet\)/);
    expect(await t.service.setStatus('200000000000000008', 'auto', null, OTHER)).toMatch(/now \*\*valid\*\*/);
    expect((await t.service.raffleExport()).csv).toBe('"inviter"\n"inviter"\n');
  });

  it('if saving the members fails at start, the next check does it (rule 4 still works)', async () => {
    const t = setup();
    t.members.set(OLD_MEMBER, t.member(OLD_MEMBER));
    const fetch = t.guild.members.fetch.bind(t.guild.members) as unknown as (id?: string) => Promise<unknown>;
    let fail = true;
    (t.guild.members as { fetch: unknown }).fetch = (id?: string) => (fail && id === undefined ? Promise.reject(new Error('gateway hiccup')) : fetch(id));
    await expect(t.service.start(t.guild)).rejects.toThrow('gateway hiccup');
    expect(t.service.enabled).toBe(true); // invite tracking doesn't wait for it
    fail = false;
    await t.service.tick(t.guild);
    expect(await db.knownMember.findUnique({ where: { userId: OLD_MEMBER } })).toMatchObject({ source: 'snapshot' });
    expect((await t.service.state()).snapshotDone).toBe(true);
  });

  it('posts each Sunday at 6 PM once, freezes at the end, posts the final results a week later', async () => {
    const t = setup();
    await t.service.start(t.guild);
    await t.service.tick(t.guild); // Sunday 1 PM, the start: no post yet
    expect(t.sent.filter((s) => s.channelId === BOARD)).toHaveLength(0);

    t.clock.now = new Date('2026-11-23T00:05:00Z'); // Sunday 6:05 PM Edmonton
    await t.service.tick(t.guild);
    await t.service.tick(t.guild);
    const board = () => t.sent.filter((s) => s.channelId === BOARD).map((s) => s.embed);
    expect(board()).toHaveLength(1);
    expect(board()[0]).toMatchObject({ title: '🎄 invite leaderboard · week 1', footer: { text: '33 days left · every valid invite = a raffle entry ♡ check yours with /invites' } });

    t.clock.now = new Date('2026-11-30T00:10:00Z');
    await t.service.tick(t.guild);
    expect(board()[1]!.title).toBe('🎄 invite leaderboard · week 2');

    // An invite made late, and a join an hour before the end: it still gets its 7 days.
    t.clock.now = new Date(END.getTime() - 3600_000);
    t.invites.set('abc', { uses: 0, inviterId: INVITER });
    t.service.onInviteCreate({ code: 'abc', uses: 0, inviterId: INVITER, guild: { id: GUILD } } as unknown as Invite);
    await t.join('200000000000000009', 'abc', { roles: [LEVEL3] });

    t.clock.now = new Date(END.getTime() + 60_000);
    await t.service.tick(t.guild);
    expect(board().at(-1)!.title).toBe('🎄 invite leaderboard · event over');
    expect(board().at(-1)!.footer!.text).toMatch(/final results after Jan 1/);
    // Joins after the end aren't part of the event.
    await t.join('200000000000000010', 'abc', { roles: [LEVEL3] });
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: '200000000000000010' } })).toBeNull();

    t.clock.now = new Date(END.getTime() + 7 * DAY + 2 * 3600_000);
    await t.service.tick(t.guild);
    expect(board().at(-1)).toMatchObject({ title: '🎄 invite leaderboard · final', description: `🥇 <@${INVITER}> ── **1** invite` });
    const count = board().length;
    await t.service.tick(t.guild);
    expect(board()).toHaveLength(count);
  });
});
