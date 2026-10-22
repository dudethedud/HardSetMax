// Only one copy of the bot may be connected to Discord (SPEC §11). Before logging in,
// the bot takes the `gateway-leader` advisory lock on its own dedicated connection
// (not the Prisma pool, which can hand the lock's session to another query).
//
// If that connection drops, Postgres releases the lock. The bot then keeps running
// in "database down" mode (SPEC §13: buffer in memory, retry with backoff) and keeps
// trying to reconnect and take the lock back. This is safe: a new copy must also
// take the lock before connecting to Discord, so while the database is unreachable
// no other copy can connect either. If another copy got the lock first, this one
// must stop (onTakenOver).
import pg, { type ClientConfig } from 'pg';
import type { Logger } from '../logger.js';

const LOCK_NAME = 'gateway-leader';
const LOCK_SQL = 'SELECT pg_try_advisory_lock(hashtext($1)) AS ok';

export interface GatewayLeader {
  readonly acquiredAt: Date;
  /** False while the database is unreachable, and once released. */
  isHeld(): boolean;
  /** When the lock was lost, while it's being taken back; null when held. */
  lostSince(): Date | null;
  release(): Promise<void>;
}

export interface AcquireOptions {
  retryMs?: number;
  /** Longest wait between reconnect attempts. */
  maxRetryMs?: number;
  /** Stops waiting (e.g. SIGTERM while another copy holds the lock). */
  signal?: AbortSignal;
  /** The lock's connection dropped; the bot is now in database-down mode. */
  onLost: (err: Error) => void;
  /** Reconnected and took the lock back. */
  onRegained?: () => void;
  /** Reconnected, but another copy holds the lock now: this copy must stop. */
  onTakenOver: () => void;
}

export async function acquireGatewayLeader(
  connection: ClientConfig,
  log: Logger,
  { retryMs = 2000, maxRetryMs = 60_000, signal, onLost, onRegained, onTakenOver }: AcquireOptions,
): Promise<GatewayLeader> {
  const connect = async () => {
    const c = new pg.Client({ ...connection, application_name: 'vip-bot:gateway-leader' });
    await c.connect();
    return c;
  };
  const tryLock = async (c: pg.Client) => (await c.query<{ ok: boolean }>(LOCK_SQL, [LOCK_NAME])).rows[0]?.ok === true;

  let client = await connect();
  let held = false;
  let released = false;
  let lostAt: Date | null = null;

  const watch = (c: pg.Client) => {
    const onDrop = (err?: Error) => {
      if (released || c !== client || !held) return;
      held = false;
      lostAt = new Date();
      log.error({ err }, 'gateway-leader connection lost: database-down mode, reconnecting');
      onLost(err ?? new Error('connection ended'));
      void reacquire();
    };
    c.on('error', onDrop);
    c.on('end', () => onDrop());
  };

  const reacquire = async () => {
    let wait = retryMs;
    while (!released) {
      await sleep(wait).catch(() => undefined);
      if (released) return;
      let c: pg.Client;
      try {
        c = await connect();
      } catch (err) {
        log.warn({ err, nextTryMs: Math.min(wait * 2, maxRetryMs) }, 'database still unreachable');
        wait = Math.min(wait * 2, maxRetryMs);
        continue;
      }
      try {
        if (await tryLock(c)) {
          client = c;
          watch(c);
          held = true;
          lostAt = null;
          log.info('database back: took gateway-leader again');
          onRegained?.();
          return;
        }
        await c.end().catch(() => undefined);
        log.fatal('another copy of the bot took gateway-leader while the database was down; stopping');
        onTakenOver();
        return;
      } catch (err) {
        await c.end().catch(() => undefined);
        log.warn({ err }, 'reconnect failed; retrying');
        wait = Math.min(wait * 2, maxRetryMs);
      }
    }
  };

  let waitingLogged = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      if (await tryLock(client)) break;
      if (!waitingLogged) {
        log.info('another copy of the bot holds gateway-leader; waiting for it to exit');
        waitingLogged = true;
      }
      await sleep(retryMs, signal);
    }
  } catch (err) {
    released = true;
    await client.end().catch(() => undefined);
    throw err;
  }

  held = true;
  watch(client);
  const acquiredAt = new Date();
  log.info('acquired gateway-leader');

  return {
    acquiredAt,
    isHeld: () => held,
    lostSince: () => lostAt,
    async release() {
      if (released) return;
      released = true;
      if (held) {
        held = false;
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]).catch(() => undefined);
      }
      // Closing the session releases the lock even if the unlock above failed.
      await client.end().catch(() => undefined);
      log.info('released gateway-leader');
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}
