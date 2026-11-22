// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, PermissionFlagsBits, type Client, type Guild, type GuildMember } from 'discord.js';
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
/** A listing bot (like DISBOARD) whose invite people join through. */
const LISTING_BOT = '300000000000000001';
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
    type Embed = { title?: string; description?: string; footer?: { text: string } };
    // Staff log posts are embeds; the leaderboard is a components box, kept here as its text.
    const sent: { channelId: string; embed: Embed; text: string }[] = [];
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
    type Payload = { embeds?: { toJSON(): Embed }[]; components?: { toJSON(): { components: { content?: string }[] } }[]; flags?: number };
    const textOf = (o: Payload) => (o.components ?? []).flatMap((c) => c.toJSON().components.map((x) => x.content ?? '---')).join('\n');
    // Posted messages by ID; editing one replaces what it shows.
    const posted = new Map<string, { channelId: string; text: string; boxed: boolean; edits: number }>();
    const channel = (channelId: string) => ({
      id: channelId,
      isSendable: () => true,
      messages: {
        fetch: (id: string) => {
          const m = posted.get(id);
          if (!m) return Promise.reject(new Error('Unknown Message'));
          return Promise.resolve({
            id,
            flags: { has: () => m.boxed },
            edit: (o: Payload) => ((m.text = textOf(o)), m.edits++, Promise.resolve({})),
            delete: () => (posted.delete(id), Promise.resolve({})),
          });
        },
      },
      send: (o: Payload) => {
        sent.push({ channelId, embed: o.embeds?.[0]?.toJSON() ?? {}, text: textOf(o) });
        const id = `m${sent.length}`;
        posted.set(id, { channelId, text: textOf(o), boxed: !!o.flags, edits: 0 });
        return Promise.resolve({ id });
      },
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
      users: { fetch: (id: string) => Promise.resolve({ id, username: id === INVITER ? 'inviter' : `user${id.slice(-4)}`, bot: id === LISTING_BOT }) },
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
    return { service, guild, clock, sent, posted, invites, members, perms, member, join, status, later };
  }

  it('counts straight away: invited on join, verified the moment they get level 3, left when they leave', async () => {
    const t = setup();
    t.invites.set('abc', { uses: 4, inviterId: INVITER });
    t.members.set(OLD_MEMBER, t.member(OLD_MEMBER));
    await t.service.start(t.guild);
    expect(t.service.enabled).toBe(true);
    // The first place line (the server has no blue_1 emoji here, so it's the medal).
    const line = async () => JSON.stringify((await t.service.leaderboard()).components.map((c) => c.toJSON())).match(/🥇[^"\\]*|no invites yet/)?.[0];

    const a = await t.join('200000000000000001', 'abc');
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: a.id } })).toMatchObject({ inviterId: INVITER, inviteCode: 'abc', source: 'invite', status: 'pending' });
    expect(await line()).toBe(`🥇 <@${INVITER}> - **0** verified · 1 invited`);

    // Getting level 3 (a role change) verifies them right away, no waiting.
    t.later(1 / 24);
    const levelled = t.member(a.id, { roles: [LEVEL3] });
    t.members.set(a.id, levelled);
    await t.service.onMemberUpdate(levelled);
    expect(await t.status(a.id)).toBe('valid');
    expect(await line()).toBe(`🥇 <@${INVITER}> - **1** verified`);
    const mine = (await t.service.invitesOf(INVITER)).toJSON().description!;
    expect(mine).toContain('✅ **1** verified = **1** raffle entry · #1 on the leaderboard');
    expect(mine).toContain('⏳ 0 invited · 🚪 0 left');

    // Leaving before the end: it moves to left.
    t.members.delete(a.id);
    await t.service.onMemberRemove(a.id, GUILD);
    expect(await t.status(a.id)).toBe('left');
    expect(await line()).toBe('no invites yet'); // only left: not listed
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

  it('one live leaderboard box: posted at start, edited only when it changes, reposted if deleted; event over, then final', async () => {
    const t = setup();
    t.invites.set('abc', { uses: 0, inviterId: INVITER });
    await t.service.start(t.guild);
    await t.service.tick(t.guild);
    const boards = () => [...t.posted].filter(([, m]) => m.channelId === BOARD);
    expect(boards()).toHaveLength(1);
    const [id, live] = boards()[0]!;
    expect(live.boxed).toBe(true);
    expect(live.text.split('\n')).toEqual([
      '## 🎄 Invite Leaderboard',
      '---',
      'no invites yet · be the first! get your link with `/invite-link` ♡',
      '-# 33 days left · every verified invite = a raffle entry ♡ check yours with /invites',
      '-# **verified** = they have the level 3 role (a raffle entry) · **invited** = joined, not level 3 yet · **left** = left the server',
    ]);

    // Nothing changed: no edit.
    t.later(5 / (24 * 60));
    await t.service.tick(t.guild);
    expect(live.edits).toBe(0);

    // A join that already has level 3: verified, and the same message is edited straight away.
    await t.join('200000000000000009', 'abc', { roles: [LEVEL3] });
    expect(boards()).toHaveLength(1);
    expect(live.edits).toBe(1);
    expect(live.text).toContain(`\n🥇 <@${INVITER}> - **1** verified\n`); // no blue_1 emoji in this server: the medal
    // A day later only the days left change: edited once more.
    t.later(8);
    await t.service.tick(t.guild);
    expect(live.edits).toBe(2);
    expect(live.text).toContain('-# 25 days left');

    // Someone deleted it: posted again, once.
    t.posted.delete(id);
    t.later(1 / 24);
    await t.service.tick(t.guild);
    await t.service.tick(t.guild);
    expect(boards()).toHaveLength(1);

    // The end: the same message says the event is over; joins after it aren't part of the event.
    t.clock.now = new Date(END.getTime() + 60_000);
    await t.service.tick(t.guild);
    const after = boards()[0]![1].text;
    expect(after).toMatch(/^## 🎄 Invite Leaderboard · Event Over\n/);
    expect(after).toContain('-# the event is over · final results after Jan 1: invited friends have until then to reach level 3 ♡');
    await t.join('200000000000000010', 'abc', { roles: [LEVEL3] });
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: '200000000000000010' } })).toBeNull();

    // A week later: final results, still the same message, and statuses stop changing.
    t.clock.now = new Date(END.getTime() + 7 * DAY + 2 * 3600_000);
    await t.service.tick(t.guild);
    expect(boards()).toHaveLength(1);
    expect(boards()[0]![1].text).toMatch(new RegExp(`^## 🎄 Invite Leaderboard · Final Results\\n---\\n🥇 <@${INVITER}> - \\*\\*1\\*\\* verified\\n`));
    expect(t.sent.filter((s) => s.channelId === BOARD)).toHaveLength(2); // the first post and the repost, nothing else
  });

  it('uses the server\'s blue_1…blue_10 emojis for places when it has them', async () => {
    const t = setup();
    (t.guild as unknown as { emojis: unknown }).emojis = {
      cache: new Collection([['700000000000000001', { id: '700000000000000001', name: 'blue_1', available: true, toString: () => '<:blue_1:700000000000000001>' }]]),
    };
    t.invites.set('abc', { uses: 0, inviterId: INVITER });
    await t.service.start(t.guild);
    await t.join('200000000000000011', 'abc', { roles: [LEVEL3] });
    const [, live] = [...t.posted].find(([, m]) => m.channelId === BOARD)!;
    expect(live.text).toContain(`\n<:blue_1:700000000000000001> <@${INVITER}> - **1** verified\n`);
  });

  it('bots never count as inviters (e.g. DISBOARD\'s server listing invite), including joins credited to them before', async () => {
    const t = setup();
    t.invites.set('listing', { uses: 0, inviterId: LISTING_BOT });
    await t.service.start(t.guild);
    await t.join('200000000000000012', 'listing', { roles: [LEVEL3] });
    expect(await db.inviteJoin.findUnique({ where: { inviteeId: '200000000000000012' } })).toMatchObject({ source: 'bot', inviterId: LISTING_BOT, status: 'invalid' });
    // A join credited to the bot by an older version: hidden at once, relabelled by the hourly check.
    const old = await db.inviteJoin.create({ data: { inviteeId: '200000000000000013', inviteeName: 'someone', inviterId: LISTING_BOT, inviteCode: 'listing', source: 'invite', joinedAt: t.clock.now, accountCreatedAt: new Date(t.clock.now.getTime() - 400 * DAY) } });
    t.members.set(old.inviteeId, t.member(old.inviteeId));
    expect(JSON.stringify((await t.service.leaderboard()).components.map((c) => c.toJSON()))).not.toContain(LISTING_BOT);
    await t.service.evaluateAll(t.guild);
    expect(await db.inviteJoin.findUnique({ where: { id: old.id } })).toMatchObject({ source: 'bot', status: 'invalid' });
  });

  it('replaces an old-style (embed) leaderboard message with the new box, once', async () => {
    const t = setup();
    await t.service.start(t.guild);
    t.posted.set('old', { channelId: BOARD, text: '', boxed: false, edits: 0 });
    await db.inviteEventState.update({ where: { guildId: GUILD }, data: { leaderboardMessageId: 'old' } });
    await t.service.tick(t.guild);
    await t.service.tick(t.guild);
    expect(t.posted.has('old')).toBe(false);
    const boards = [...t.posted].filter(([, m]) => m.channelId === BOARD);
    expect(boards).toHaveLength(1);
    expect(boards[0]![1].boxed).toBe(true);
    expect((await t.service.state()).leaderboardMessageId).toBe(boards[0]![0]);
  });
});
