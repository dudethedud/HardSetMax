// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { RESTEvents, type Client } from 'discord.js';
import { createDb, type Db } from '../db/prisma.js';
import { DmQueue } from './dm.js';

const url = process.env['TEST_DATABASE_URL'];
const USER = '500000000000000001';

describe.skipIf(!url)('the shared DM queue', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  beforeEach(() => db.memberActivity.deleteMany());
  afterAll(() => db.$disconnect());

  function setup() {
    const clock = { now: 1_800_000_000_000 };
    const rest = new EventEmitter();
    const sent: string[] = [];
    const waits: number[] = [];
    const client = { rest, users: { send: (id: string) => (sent.push(id), Promise.resolve({})) } } as unknown as Client;
    const queue = new DmQueue(client, db, pino({ level: 'silent' }), () => clock.now, (ms) => (waits.push(ms), (clock.now += ms), Promise.resolve()));
    return { queue, clock, rest, sent, waits };
  }

  it('DMs go out one at a time, at least 3 seconds apart', async () => {
    const t = setup();
    const results = await Promise.all([1, 2, 3].map((n) => t.queue.send(`50000000000000000${n}`, { content: 'hi' }, 'colour-removal')));
    expect(results.map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
    expect(t.sent).toEqual(['500000000000000001', '500000000000000002', '500000000000000003']);
    expect(t.waits).toEqual([3000, 3000]);
  });

  it('the check-in opt-out only covers check-ins, not colour-removal DMs', async () => {
    const t = setup();
    await db.memberActivity.create({ data: { userId: USER, checkinOptOut: true } });
    expect(await t.queue.send(USER, { content: 'hi' }, 'checkin')).toEqual({ status: 'opted-out' });
    expect(await t.queue.send(USER, { content: 'hi' }, 'colour-removal')).toEqual({ status: 'sent' });
  });

  it('a rate limit on DMs (or a global one) pauses every DM for an hour; others do not', async () => {
    const t = setup();
    // A role edit being rate-limited while no DM is going out: DMs carry on.
    t.rest.emit(RESTEvents.RateLimited, { global: false, route: '/guilds/:id/members/:id' });
    expect(await t.queue.send(USER, { content: 'hi' }, 'colour-removal')).toEqual({ status: 'sent' });
    // Opening DM channels is rate-limited: everything waits an hour.
    t.rest.emit(RESTEvents.RateLimited, { global: false, route: '/users/@me/channels' });
    expect(await t.queue.send(USER, { content: 'hi' }, 'colour-removal')).toEqual({ status: 'held', reason: 'paused' });
    t.clock.now += 60 * 60_000;
    expect(await t.queue.send(USER, { content: 'hi' }, 'colour-removal')).toEqual({ status: 'sent' });
    t.rest.emit(RESTEvents.RateLimited, { global: true, route: '/anything' });
    expect(await t.queue.send(USER, { content: 'hi' }, 'checkin')).toEqual({ status: 'held', reason: 'paused' });
  });
});
