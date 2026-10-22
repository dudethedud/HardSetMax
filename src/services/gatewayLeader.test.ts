// Needs a real Postgres: set TEST_DATABASE_URL to run. Skipped otherwise.
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import pg from 'pg';
import { acquireGatewayLeader } from './gatewayLeader.js';

const url = process.env['TEST_DATABASE_URL'];
const conn = { connectionString: url };
const log = pino({ level: 'silent' });
const noop = () => undefined;

describe.skipIf(!url)('gateway-leader lock', () => {
  it('a second copy waits until the first releases', async () => {
    const first = await acquireGatewayLeader(conn, log, { onLost: noop, onTakenOver: noop });
    let secondGotIt = false;
    const second = acquireGatewayLeader(conn, log, { retryMs: 50, onLost: noop, onTakenOver: noop }).then((l) => {
      secondGotIt = true;
      return l;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(secondGotIt).toBe(false);

    await first.release();
    const leader = await second;
    expect(secondGotIt).toBe(true);
    expect(first.isHeld()).toBe(false);
    expect(leader.isHeld()).toBe(true);
    await leader.release();
  });

  it('stops waiting when aborted', async () => {
    const first = await acquireGatewayLeader(conn, log, { onLost: noop, onTakenOver: noop });
    const abort = new AbortController();
    const waiting = acquireGatewayLeader(conn, log, { retryMs: 50, signal: abort.signal, onLost: noop, onTakenOver: noop });
    setTimeout(() => abort.abort(new Error('SIGTERM')), 150);
    await expect(waiting).rejects.toThrow('SIGTERM');
    await first.release();
  });

  it('release is safe to call twice', async () => {
    const leader = await acquireGatewayLeader(conn, log, { onLost: noop, onTakenOver: noop });
    await leader.release();
    await leader.release();
    expect(leader.isHeld()).toBe(false);
  });
});

describe.skipIf(!url)('gateway-leader: database-down mode', () => {
  const killLockHolder = async () => {
    const admin = new pg.Client(conn);
    await admin.connect();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'vip-bot:gateway-leader'");
    await admin.end();
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 30));
  };

  it('keeps running when the connection drops, and takes the lock back when it can', async () => {
    const events: string[] = [];
    const leader = await acquireGatewayLeader(conn, log, {
      retryMs: 50,
      onLost: () => events.push('lost'),
      onRegained: () => events.push('regained'),
      onTakenOver: () => events.push('taken over'),
    });
    await killLockHolder();
    await until(() => events.includes('lost'));
    expect(leader.isHeld()).toBe(false);
    expect(leader.lostSince()).not.toBeNull();
    await until(() => events.includes('regained'));
    expect(events).toEqual(['lost', 'regained']);
    expect(leader.isHeld()).toBe(true);
    expect(leader.lostSince()).toBeNull();
    await leader.release();
  });

  it('stops if another copy took the lock while it was disconnected', async () => {
    const events: string[] = [];
    const leader = await acquireGatewayLeader(conn, log, {
      retryMs: 300,
      onLost: () => events.push('lost'),
      onTakenOver: () => events.push('taken over'),
    });
    await killLockHolder();
    await until(() => events.includes('lost'));
    // Another copy grabs the lock before this one reconnects.
    const other = await acquireGatewayLeader(conn, log, { onLost: noop, onTakenOver: noop });
    await until(() => events.includes('taken over'));
    expect(events).toEqual(['lost', 'taken over']);
    expect(leader.isHeld()).toBe(false);
    await other.release();
    await leader.release();
  });
});
