// Only one copy of the bot may be connected to Discord (SPEC §11). Before logging in,
// the bot takes the `gateway-leader` advisory lock on its own dedicated connection
// (not the Prisma pool, which can hand the lock's session to another query). If the
// connection drops, Postgres releases the lock, so the holder must stop at once.
import pg from 'pg';
import type { Logger } from '../logger.js';

const LOCK_NAME = 'gateway-leader';

export interface GatewayLeader {
  readonly acquiredAt: Date;
  /** False once the lock is released or its connection is lost. */
  isHeld(): boolean;
  release(): Promise<void>;
}

export interface AcquireOptions {
  retryMs?: number;
  /** Stops waiting (e.g. SIGTERM while another copy holds the lock). */
  signal?: AbortSignal;
  /** Called if the lock's connection drops while held. */
  onLost: (err: Error) => void;
}

export async function acquireGatewayLeader(
  databaseUrl: string,
  log: Logger,
  { retryMs = 2000, signal, onLost }: AcquireOptions,
): Promise<GatewayLeader> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'vip-bot:gateway-leader' });
  let held = false;
  let released = false;

  client.on('error', (err) => {
    if (released) return;
    const wasHeld = held;
    held = false;
    log.error({ err }, 'gateway-leader connection lost');
    if (wasHeld) onLost(err);
  });

  await client.connect();
  let waitingLogged = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [
        LOCK_NAME,
      ]);
      if (rows[0]?.ok) break;
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
  const acquiredAt = new Date();
  log.info('acquired gateway-leader');

  return {
    acquiredAt,
    isHeld: () => held,
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
