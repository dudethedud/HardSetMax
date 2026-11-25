// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, DiscordAPIError, GuildScheduledEventStatus, RESTEvents, RESTJSONErrorCodes, type Client, type Guild } from 'discord.js';
import { createDb, type Db } from '../db/prisma.js';
import { CheckinService } from './checkins.js';
import { CHECKIN_STOP_ID, sendDm } from './dm.js';

const url = process.env['TEST_DATABASE_URL'];
const GUILD = '900000000000000001';
const DAY = 24 * 3600_000;
// Thursday Dec 10 2026, 1 PM Edmonton (UTC-6): after noon, so the daily run is due.
const NOW = new Date('2026-12-10T19:00:00Z');
const id = (n: number) => `4000000000000${String(n).padStart(5, '0')}`;

const closedDms = () => new DiscordAPIError({ message: 'Cannot send messages to this user', code: RESTJSONErrorCodes.CannotSendMessagesToThisUser }, RESTJSONErrorCodes.CannotSendMessagesToThisUser, 403, 'POST', '/channels/x/messages', {});

describe.skipIf(!url)('check-in DMs', () => {
  const db: Db = createDb({ connectionString: url }, 3);

  beforeEach(async () => {
    await db.$transaction([db.memberActivity.deleteMany(), db.checkinState.deleteMany()]);
  });
  afterAll(() => db.$disconnect());

  function setup(opts: { enabled?: boolean } = {}) {
    const clock = { now: NOW };
    const dms: { userId: string; content: string; buttonId: string }[] = [];
    const waits: number[] = [];
    /** userId → what sending them a DM does. */
    const failFor = new Map<string, () => never>();
    const rest = new EventEmitter();
    const members = new Collection<string, { id: string; joinedAt: Date; user: { bot: boolean } }>();
    const addMember = (n: number, joinedDaysAgo = 300, bot = false) => members.set(id(n), { id: id(n), joinedAt: new Date(NOW.getTime() - joinedDaysAgo * DAY), user: { bot } });
    const events = new Collection<string, { name: string; scheduledStartAt: Date | null; status: GuildScheduledEventStatus }>();
    events.set('e1', { name: 'Movie Night', scheduledStartAt: new Date(NOW.getTime() + 2 * DAY), status: GuildScheduledEventStatus.Scheduled });
    const guild = { id: GUILD, scheduledEvents: { fetch: () => Promise.resolve(events) }, members: { fetch: () => Promise.resolve(members) } } as unknown as Guild;
    const client = {
      rest,
      users: {
        send: (userId: string, o: { content: string; components: { toJSON(): { components: { custom_id: string }[] } }[] }) => {
          failFor.get(userId)?.();
          dms.push({ userId, content: o.content, buttonId: o.components[0]!.toJSON().components[0]!.custom_id });
          return Promise.resolve({});
        },
      },
    } as unknown as Client;
    const service = new CheckinService(client, GUILD, db, pino({ level: 'silent' }), opts.enabled ?? true, () => clock.now, (ms) => (waits.push(ms), Promise.resolve()));
    /** Someone talked `daysAgo` days ago (saved the way the bot saves them). */
    const talked = async (n: number, daysAgo: number) => {
      const at = clock.now;
      clock.now = new Date(NOW.getTime() - daysAgo * DAY);
      service.noteMessage({ guildId: GUILD, author: { id: id(n), bot: false } as never, webhookId: null, system: false });
      clock.now = at;
      await service.flush();
    };
    // Tracking started long ago unless a test says otherwise.
    const trackingFrom = (daysAgo: number) => db.checkinState.create({ data: { guildId: GUILD, trackingStartedAt: new Date(NOW.getTime() - daysAgo * DAY) } });
    return { service, guild, clock, dms, waits, failFor, rest, members, events, addMember, talked, trackingFrom };
  }

  it('notes when members talk (never what), ignoring bots, webhooks, system messages and other servers', async () => {
    const t = setup();
    const msg = (o: object) => ({ guildId: GUILD, author: { id: id(1), bot: false }, webhookId: null, system: false, ...o }) as never;
    t.service.noteMessage(msg({}));
    t.service.noteMessage(msg({ author: { id: id(2), bot: true } }));
    t.service.noteMessage(msg({ author: { id: id(3), bot: false }, webhookId: '1' }));
    t.service.noteMessage(msg({ author: { id: id(4), bot: false }, system: true }));
    t.service.noteMessage(msg({ author: { id: id(5), bot: false }, guildId: '1' }));
    expect(await t.service.flush()).toBe(1);
    expect(await db.memberActivity.findMany()).toEqual([{ userId: id(1), lastMessageAt: NOW, lastCheckinAt: null, checkinOptOut: false }]);
    expect(await t.service.flush()).toBe(0);
  });

  it('DMs members quiet 7+ days about the next event, with the Stop button; skips the active, opted out and bots', async () => {
    const t = setup();
    await t.trackingFrom(60);
    [1, 2, 3, 4].forEach((n) => t.addMember(n));
    t.addMember(5, 300, true);
    await t.talked(1, 10); // quiet: yes
    await t.talked(2, 2); // active: no
    await t.talked(3, 10);
    await t.service.setOptOut(id(3), true); // opted out: no
    await t.talked(4, 8); // quiet: yes
    const run = await t.service.run(t.guild);
    expect(run).toEqual({ due: 2, sent: 2, closed: 0, stopped: null });
    // Most recently quiet first.
    expect(t.dms.map((d) => d.userId)).toEqual([id(4), id(1)]);
    expect(t.dms[0]!.content).toBe(`Hey! It's been a bit, we miss you at Soft Hearts ♡ **Movie Night** is on <t:${Math.floor((NOW.getTime() + 2 * DAY) / 1000)}:F>, come say hi!\n-# Don't want these? Tap below.`);
    expect(t.dms[0]!.buttonId).toBe(CHECKIN_STOP_ID);
    expect(t.waits).toEqual([30_000]);
    expect((await db.memberActivity.findUnique({ where: { userId: id(1) } }))!.lastCheckinAt).toEqual(NOW);
  });

  it('at most 20 a run, 30 seconds apart', async () => {
    const t = setup();
    await t.trackingFrom(60);
    for (let n = 1; n <= 25; n++) {
      t.addMember(n);
      await t.talked(n, 8 + n);
    }
    const run = await t.service.run(t.guild);
    expect(run).toMatchObject({ due: 25, sent: 20 });
    expect(t.dms).toHaveLength(20);
    expect(t.waits).toEqual(Array(19).fill(30_000));
  });

  it('no upcoming scheduled event: no DMs', async () => {
    const t = setup();
    await t.trackingFrom(60);
    t.addMember(1);
    await t.talked(1, 10);
    t.events.clear();
    t.events.set('past', { name: 'Old', scheduledStartAt: new Date(NOW.getTime() - DAY), status: GuildScheduledEventStatus.Completed });
    expect(await t.service.run(t.guild)).toEqual({ due: 0, sent: 0, closed: 0, stopped: null });
    expect(t.dms).toHaveLength(0);
  });

  it('closed DMs are skipped quietly and count as their check-in (no retries until they are active again)', async () => {
    const t = setup();
    await t.trackingFrom(60);
    t.addMember(1);
    t.addMember(2);
    await t.talked(1, 10);
    await t.talked(2, 9);
    t.failFor.set(id(2), () => {
      throw closedDms();
    });
    expect(await t.service.run(t.guild)).toMatchObject({ sent: 1, closed: 1, stopped: null });
    // 15 days later, still quiet: nobody is DMed again.
    t.clock.now = new Date(NOW.getTime() + 15 * DAY);
    expect(await t.service.run(t.guild)).toMatchObject({ due: 0, sent: 0 });
  });

  it('any other error, or a rate limit, stops the run for the day', async () => {
    const t = setup();
    await t.trackingFrom(60);
    for (let n = 1; n <= 5; n++) {
      t.addMember(n);
      await t.talked(n, 8 + n);
    }
    t.failFor.set(id(2), () => {
      throw new Error('Internal Server Error');
    });
    expect(await t.service.run(t.guild)).toMatchObject({ sent: 1, stopped: 'Internal Server Error' });
    expect(t.dms.map((d) => d.userId)).toEqual([id(1)]);

    // A rate limit while sending: stop after that DM.
    const u = setup();
    for (let n = 1; n <= 5; n++) {
      u.addMember(n);
      await db.memberActivity.update({ where: { userId: id(n) }, data: { lastCheckinAt: null } }).catch(() => undefined);
    }
    u.failFor.set(id(1), () => {
      u.rest.emit(RESTEvents.RateLimited, { timeToReset: 1000 });
      return undefined as never;
    });
    expect(await u.service.run(u.guild)).toMatchObject({ stopped: 'rate limited' });
    expect(u.dms.length).toBeLessThanOrEqual(1);
  });

  it('members with no message on record: quiet from when tracking started (or when they joined, if later)', async () => {
    const t = setup();
    await t.trackingFrom(5);
    t.addMember(1, 300); // long-time member, nothing on record
    t.addMember(2, 2); // joined 2 days ago
    expect(await t.service.run(t.guild)).toMatchObject({ due: 0 });
    t.events.set('e1', { name: 'Movie Night', scheduledStartAt: new Date(NOW.getTime() + 10 * DAY), status: GuildScheduledEventStatus.Scheduled });
    t.clock.now = new Date(NOW.getTime() + 3 * DAY); // tracking started 8 days ago
    expect(await t.service.run(t.guild)).toMatchObject({ due: 1, sent: 1 });
    expect(t.dms.map((d) => d.userId)).toEqual([id(1)]);
  });

  it('runs once a day, after noon Edmonton; off switch sends nothing', async () => {
    const t = setup();
    await t.trackingFrom(60);
    t.addMember(1);
    await t.talked(1, 10);
    t.clock.now = new Date('2026-12-10T17:00:00Z'); // 11 AM
    expect(await t.service.tick(t.guild)).toBeNull();
    t.clock.now = NOW; // 1 PM
    expect(await t.service.tick(t.guild)).toMatchObject({ sent: 1 });
    t.clock.now = new Date(NOW.getTime() + 3600_000);
    expect(await t.service.tick(t.guild)).toBeNull(); // already ran today

    const off = setup({ enabled: false });
    off.addMember(2);
    await off.talked(2, 10);
    expect(await off.service.tick(off.guild)).toBeNull();
    expect(off.dms).toHaveLength(0);
  });

  it('opt-out: every DM goes through the helper, which checks it first; /checkins status', async () => {
    const t = setup();
    expect(await t.service.status(id(1))).toEqual({ optedOut: false, lastCheckinAt: null });
    await t.service.setOptOut(id(1), true);
    expect(await t.service.status(id(1))).toEqual({ optedOut: true, lastCheckinAt: null });
    const client = { users: { send: () => Promise.reject(new Error('should not be called')) } } as unknown as Client;
    expect(await sendDm(client, db, id(1), { content: 'hi' })).toEqual({ status: 'opted-out' });
    await t.service.setOptOut(id(1), false);
    expect(await t.service.status(id(1))).toMatchObject({ optedOut: false });
  });
});
