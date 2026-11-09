// Applies prisma/migrations the way `prisma migrate deploy` does, so the server
// doesn't need the Prisma CLI: same lock, same _prisma_migrations table and
// checksums, so Prisma itself still agrees afterwards. Each migration runs in a
// transaction; a failure is recorded like Prisma records it and stops startup.
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg, { type ClientConfig } from 'pg';
import { planMigrations, type AppliedRow, type MigrationFile } from '../core/migrations.js';
import type { Logger } from '../logger.js';

/** The advisory lock key `prisma migrate` uses, so the two never run at once. */
const PRISMA_MIGRATE_LOCK = 72707369;

const TABLE = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

async function readMigrations(dir: string): Promise<(MigrationFile & { sql: string })[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: (MigrationFile & { sql: string })[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sql = await readFile(join(dir, e.name, 'migration.sql'), 'utf8').catch(() => null);
    if (sql === null) continue;
    out.push({ name: e.name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

/** Applies pending migrations from `dir`. Returns the names applied. Throws if one fails. */
export async function runMigrations(connection: ClientConfig, dir: string, log: Logger): Promise<string[]> {
  const files = await readMigrations(dir);
  const client = new pg.Client({ ...connection, application_name: 'colour-bot:migrate' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [PRISMA_MIGRATE_LOCK]);
    await client.query(TABLE);
    const { rows } = await client.query<AppliedRow>('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"');
    const plan = planMigrations(files, rows);
    if (!plan.ok) throw new Error(plan.error);
    for (const name of plan.changed) log.warn({ migration: name }, 'migration file changed after it was applied');
    const applied: string[] = [];
    for (const m of plan.pending) {
      const sql = files.find((f) => f.name === m.name)!.sql;
      const id = randomUUID();
      await client.query('INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at) VALUES ($1, $2, $3, now())', [id, m.checksum, m.name]);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('UPDATE "_prisma_migrations" SET finished_at = now(), applied_steps_count = 1 WHERE id = $1', [id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        // Recorded as failed, like Prisma does, so it isn't retried blindly.
        await client.query('UPDATE "_prisma_migrations" SET logs = $2 WHERE id = $1', [id, err instanceof Error ? err.message : String(err)]).catch(() => undefined);
        throw new Error(`Migration ${m.name} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      log.info({ migration: m.name }, 'applied migration');
      applied.push(m.name);
    }
    if (!applied.length) log.info({ migrations: files.length }, 'database is up to date');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [PRISMA_MIGRATE_LOCK]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
