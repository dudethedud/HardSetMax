// Needs a real Postgres: set TEST_DATABASE_URL to run. Skipped otherwise.
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { acquireGatewayLeader } from './gatewayLeader.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: 'silent' });
const noop = () => undefined;

describe.skipIf(!url)('gateway-leader lock', () => {
  it('a second copy waits until the first releases', async () => {
    const first = await acquireGatewayLeader(url!, log, { onLost: noop });
    let secondGotIt = false;
    const second = acquireGatewayLeader(url!, log, { retryMs: 50, onLost: noop }).then((l) => {
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
    const first = await acquireGatewayLeader(url!, log, { onLost: noop });
    const abort = new AbortController();
    const waiting = acquireGatewayLeader(url!, log, { retryMs: 50, signal: abort.signal, onLost: noop });
    setTimeout(() => abort.abort(new Error('SIGTERM')), 150);
    await expect(waiting).rejects.toThrow('SIGTERM');
    await first.release();
  });

  it('release is safe to call twice', async () => {
    const leader = await acquireGatewayLeader(url!, log, { onLost: noop });
    await leader.release();
    await leader.release();
    expect(leader.isHeld()).toBe(false);
  });
});
