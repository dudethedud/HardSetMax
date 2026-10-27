// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, type Client, type Message } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { createDb, type Db } from '../db/prisma.js';
import { ActivityBuffer } from './activityBuffer.js';
import type { Clock } from './clock.js';
import { ColourService } from './colours.js';
import type { ModLog } from './modLog.js';
import { PollService } from './polls.js';
import type { RoleOp, RoleQueue } from './roleQueue.js';
import { VipService } from './vipService.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: process.env['TEST_LOG'] ?? 'silent' });
const GUILD = '900000000000000001';
const VIP_ROLE = '900000000000000099';
const STAFF_ROLE = '900000000000000098';
const POLLS = '900000000000000060';
const POLLS_ROLE = '900000000000000061';
const id = (n: number) => `1000000000000000${String(n).padStart(2, '0')}`;
const NOW = new Date('2026-10-23T18:00:00Z'); // 12:00 MDT on 2026-10-23

describe.skipIf(!url)('VIP polls and colours', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  let clockNow = NOW;
  const clock: Clock = { offsetMinutes: 0, now: () => clockNow };

  beforeEach(async () => {
    clockNow = NOW;
    await db.$transaction([
      db.pollPost.deleteMany(),
      db.pollLock.deleteMany(),
      db.crownTitle.deleteMany(),
      db.userColourChoice.deleteMany(),
      db.colourOption.deleteMany(),
      db.vipMember.deleteMany(),
      db.vipStint.deleteMany(),
      db.staffRole.deleteMany(),
      db.jobRun.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD, vipRoleId: VIP_ROLE, pollsChannelId: POLLS, pollsRoleId: POLLS_ROLE } });
    await db.staffRole.create({ data: { roleId: STAFF_ROLE } });
  });
  afterAll(() => db.$disconnect());

  function world() {
    /** id → { allow: perms[], deny: perms[] } for #polls overwrites. */
    const overwrites = new Map<string, { SendMessages: boolean; SendPolls: boolean }>();
    const replies: { content: string; allowedMentions: unknown }[] = [];
    const threads: string[] = [];
    const deleted: string[] = [];
    const memberRoles = new Map<string, Set<string>>();
    const permissionOverwrites = {
      edit: (oid: string, perms: { SendMessages: boolean; SendPolls: boolean }) => (overwrites.set(oid, perms), Promise.resolve()),
      delete: (oid: string) => (overwrites.delete(oid), Promise.resolve()),
      cache: {
        get: (oid: string) => {
          const o = overwrites.get(oid);
          if (!o) return undefined;
          const flag = (v: boolean) => ({ has: () => v });
          return { id: oid, allow: flag(o.SendPolls), deny: flag(!o.SendPolls) };
        },
        values: () => [...overwrites.keys()].map((oid) => ({ id: oid, type: oid === VIP_ROLE ? 0 : 1, allow: { has: () => overwrites.get(oid)!.SendPolls }, deny: { has: () => !overwrites.get(oid)!.SendPolls } })),
      },
    };
    const channel = { id: POLLS, isTextBased: () => true, permissionOverwrites };
    const member = (uid: string) => ({
      id: uid,
      user: { bot: false },
      permissions: { has: () => false },
      roles: { cache: new Collection([...(memberRoles.get(uid) ?? [])].map((r) => [r, { id: r }])) },
      displayName: uid,
    });
    const guild = {
      id: GUILD,
      members: {
        cache: { get: (uid: string) => (memberRoles.has(uid) ? member(uid) : undefined), values: () => [...memberRoles.keys()].map(member), has: (uid: string) => memberRoles.has(uid), keys: () => memberRoles.keys() },
        fetch: (uid: string) => Promise.resolve(member(uid)),
      },
      roles: { cache: { get: () => undefined } },
    };
    const client = {
      user: { id: '900000000000000002' },
      guilds: { cache: new Map([[GUILD, guild]]) },
      channels: { fetch: (cid: string) => Promise.resolve(cid === POLLS ? channel : null) },
    } as unknown as Client;

    let seq = 0;
    const message = (uid: string, poll: boolean): Message => {
      const mid = String(800000000000000000n + BigInt(++seq));
      return {
        id: mid,
        guildId: GUILD,
        channelId: POLLS,
        channel,
        guild,
        inGuild: () => true,
        author: { id: uid, bot: false },
        member: member(uid),
        createdAt: clockNow,
        poll: poll ? { question: { text: `Question ${seq}?` } } : null,
        delete: () => (deleted.push(mid), Promise.resolve()),
        reply: (r: { content: string; allowedMentions: unknown }) => (replies.push(r), Promise.resolve()),
        startThread: (t: { name: string }) => (threads.push(t.name), Promise.resolve()),
      } as unknown as Message;
    };

    const ops: RoleOp[] = [];
    const roles = {
      run: (op: RoleOp) => {
        ops.push(op);
        const set = memberRoles.get(op.userId) ?? new Set();
        if (op.action === 'add') set.add(op.roleId);
        else set.delete(op.roleId);
        memberRoles.set(op.userId, set);
        return Promise.resolve({ ok: true });
      },
      idle: () => Promise.resolve(),
    } as unknown as RoleQueue;
    const modLines: string[] = [];
    const modLog = { post: (t: string) => (modLines.push(t), Promise.resolve()) } as unknown as ModLog;
    return { client, overwrites, replies, threads, deleted, message, roles, modLog, modLines, memberRoles, ops };
  }

  async function setup(vips: number[]) {
    const w = world();
    for (const n of vips) {
      await db.vipMember.create({ data: { userId: id(n), since: '2026-10-20' } });
      w.memberRoles.set(id(n), new Set([VIP_ROLE]));
    }
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const vip = new VipService(w.client, GUILD, db, config, new ActivityBuffer(), w.roles, w.modLog, clock, log);
    await vip.load();
    const polls = new PollService(w.client, GUILD, db, config, vip, w.modLog, clock, log);
    const colours = new ColourService(w.client, GUILD, db, config, w.roles, vip, w.modLog, log);
    return { ...w, vip, polls, colours, config };
  }

  /** Feeds messages in and waits until they've all been handled. */
  async function post(t: Awaited<ReturnType<typeof setup>>, messages: Message[]) {
    for (const m of messages) t.polls.handleMessage(m);
    await t.polls.status(); // a DB round trip
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 50 && (await db.pollPost.count()) < messages.filter((m) => m.poll).length; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
  }

  it('one VIP posting two polls quickly: one survives, one ping, and they are locked', async () => {
    const t = await setup([1]);
    const [a, b] = [t.message(id(1), true), t.message(id(1), true)];
    await post(t, [a, b]);
    expect(t.deleted).toEqual([b.id]);
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0]!.content).toBe(`<@&${POLLS_ROLE}> 📊 New poll from <@${id(1)}>`);
    expect(t.replies[0]!.allowedMentions).toEqual({ roles: [POLLS_ROLE], users: [id(1)], repliedUser: false });
    expect(t.threads).toEqual(['Question 1?']);
    expect(t.overwrites.get(id(1))).toEqual({ SendMessages: false, SendPolls: false });
  });

  it('three VIPs in quick succession: the first two survive and the channel locks for all VIPs, until the reset', async () => {
    const t = await setup([1, 2, 3]);
    const msgs = [t.message(id(1), true), t.message(id(2), true), t.message(id(3), true)];
    await post(t, msgs);
    expect(t.deleted).toEqual([msgs[2]!.id]);
    expect(t.replies).toHaveLength(2);
    expect(t.overwrites.get(VIP_ROLE)).toEqual({ SendMessages: false, SendPolls: false });

    // A lock made just after the boundary belongs to the new day and stays.
    clockNow = new Date('2026-10-24T06:00:05Z'); // 00:00:05 on the 24th
    await t.polls.runUnlockJob('2026-10-23');
    expect(t.overwrites.get(VIP_ROLE)).toEqual({ SendMessages: true, SendPolls: true });
    expect(t.overwrites.has(id(1))).toBe(false);
    expect(t.overwrites.has(id(2))).toBe(false);
    expect(await db.pollLock.count()).toBe(0);
  });

  it('/vip poll-unlock gives one more poll past the cap, then locks again', async () => {
    const t = await setup([1, 2]);
    await post(t, [t.message(id(1), true), t.message(id(2), true)]);
    await t.polls.grantExtra(id(1), id(9));
    expect(t.overwrites.get(id(1))).toEqual({ SendMessages: true, SendPolls: true });
    const extra = t.message(id(1), true);
    await post(t, [extra]);
    expect(t.deleted).not.toContain(extra.id);
    expect(t.overwrites.get(id(1))).toEqual({ SendMessages: false, SendPolls: false });
    expect(await db.pollPost.count({ where: { kind: 'extra' } })).toBe(1);
    expect(t.modLines.some((l) => l.includes('extra poll'))).toBe(true);
  });

  it('the Advisor (a title) can post VIP polls, shares the VIP limit, and its role follows the VIP lock', async () => {
    const t = await setup([1]);
    const ADVISOR_ROLE = '900000000000000071';
    await db.crownTitle.create({ data: { slot: 'advisor', name: '📜 Advisor', roleId: ADVISOR_ROLE, holderId: id(5) } });
    t.vip.guestPerks = (u) => new Set(u === id(5) ? (['poll', 'shoutout'] as const) : []);
    const [a, b] = [t.message(id(5), true), t.message(id(1), true)];
    await post(t, [a, b]);
    expect(t.deleted).toEqual([]);
    expect(t.overwrites.get(VIP_ROLE)).toEqual({ SendMessages: false, SendPolls: false });
    expect(t.overwrites.get(ADVISOR_ROLE)).toEqual({ SendMessages: false, SendPolls: false });
    clockNow = new Date('2026-10-24T06:00:05Z');
    await t.polls.runUnlockJob('2026-10-23');
    expect(t.overwrites.get(ADVISOR_ROLE)).toEqual({ SendMessages: true, SendPolls: true });
    // Someone without the title is still turned away.
    const stranger = t.message(id(6), true);
    await post(t, [stranger]);
    expect(t.deleted).toContain(stranger.id);
  });

  it('deleting your own poll does not give it back', async () => {
    const t = await setup([1]);
    await post(t, [t.message(id(1), true)]);
    // The poll message is gone, but its row still counts.
    const again = t.message(id(1), true);
    await post(t, [again]);
    expect(t.deleted).toEqual([again.id]);
  });

  it('staff polls have no limits; non-poll messages from VIPs are deleted, from staff kept', async () => {
    const t = await setup([1]);
    t.memberRoles.set(id(5), new Set([STAFF_ROLE]));
    const staffPolls = [t.message(id(5), true), t.message(id(5), true), t.message(id(5), true)];
    const vipText = t.message(id(1), false);
    const staffText = t.message(id(5), false);
    for (const m of [...staffPolls, vipText, staffText]) t.polls.handleMessage(m);
    await post(t, []);
    for (let i = 0; i < 40 && (await db.pollPost.count()) < 3; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    expect(t.deleted).toEqual([vipText.id]);
    expect(t.replies).toHaveLength(3);
    expect(t.overwrites.size).toBe(0);
  });

  it('startup reconciliation restores missing locks and removes leftovers', async () => {
    const t = await setup([1]);
    await db.pollLock.create({ data: { scope: 'user', targetId: id(1), effect: 'deny', serverDay: '2026-10-23', until: new Date('2026-10-24T06:00:00Z') } });
    t.overwrites.set(id(7), { SendMessages: false, SendPolls: false }); // no row: leftover
    await t.polls.reconcileLocks();
    expect(t.overwrites.get(id(1))).toEqual({ SendMessages: false, SendPolls: false });
    expect(t.overwrites.has(id(7))).toBe(false);
    expect(t.overwrites.get(VIP_ROLE)).toEqual({ SendMessages: true, SendPolls: true });
  });

  describe('colours', () => {
    async function withOptions(t: Awaited<ReturnType<typeof setup>>) {
      await db.colourOption.createMany({
        data: [
          { name: 'Rose', hex: '#FF6B9D', position: 0, roleId: '900000000000000071' },
          { name: 'Mint', hex: '#5EEAD4', position: 1, roleId: '900000000000000072' },
        ],
      });
      return t.colours.options();
    }

    it('VIPs pick, switch and remove colours; non-VIPs get "VIP only"', async () => {
      const t = await setup([1]);
      const [rose, mint] = await withOptions(t);
      expect(await t.colours.pick(id(2), rose!.id)).toContain('VIPs only');
      expect(await t.colours.pick(id(1), rose!.id)).toContain('Rose');
      expect([...t.memberRoles.get(id(1))!]).toContain(rose!.roleId);
      await t.colours.pick(id(1), mint!.id);
      expect(t.memberRoles.get(id(1))!.has(rose!.roleId!)).toBe(false);
      expect(t.memberRoles.get(id(1))!.has(mint!.roleId!)).toBe(true);
      await t.colours.pick(id(1), null);
      expect(t.memberRoles.get(id(1))!.has(mint!.roleId!)).toBe(false);
      expect(await db.userColourChoice.count()).toBe(0);
    });

    it('losing VIP removes the colour role but keeps the pick; regaining VIP restores it', async () => {
      const t = await setup([1]);
      t.vip.onRemoved.push((u) => t.colours.onVipRemoved(u));
      t.vip.onAdded.push((u) => t.colours.onVipAdded(u));
      const [rose] = await withOptions(t);
      await t.colours.pick(id(1), rose!.id);
      await t.vip.removeVip(id(1), 'timed out');
      expect(t.memberRoles.get(id(1))!.has(rose!.roleId!)).toBe(false);
      expect(await db.userColourChoice.count()).toBe(1);
      await t.vip.addVip(id(1), 'pinned', true, id(9));
      expect(t.memberRoles.get(id(1))!.has(rose!.roleId!)).toBe(true);
    });

    it('reconcile takes colour roles off non-VIPs', async () => {
      const t = await setup([]);
      const [rose] = await withOptions(t);
      t.memberRoles.set(id(4), new Set([rose!.roleId!]));
      expect(await t.colours.reconcile()).toBe(1);
      expect(t.memberRoles.get(id(4))!.size).toBe(0);
    });
  });
});
