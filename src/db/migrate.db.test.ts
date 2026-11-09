// Needs a real Postgres: set TEST_DATABASE_URL to run. Creates (and drops) its own
// scratch databases next to the test database.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import pg from 'pg';
import { runMigrations } from './migrate.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: 'silent' });
const MIGRATIONS = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));

describe.skipIf(!url)('runMigrations', () => {
  const made: string[] = [];
  const admin = () => new pg.Client({ connectionString: url });
  async function freshDb(): Promise<string> {
    const name = `colourbot_migrate_${Date.now()}_${made.length}`;
    const c = admin();
    await c.connect();
    await c.query(`CREATE DATABASE "${name}"`);
    await c.end();
    made.push(name);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    return u.toString();
  }
  afterAll(async () => {
    const c = admin();
    await c.connect();
    for (const name of made) await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await c.end();
  });

  it('builds an empty database from every migration, then has nothing to do', async () => {
    const db = await freshDb();
    const applied = await runMigrations({ connectionString: db }, MIGRATIONS, log);
    expect(applied.at(-1)).toBe('20261108230144_colour_menus');
    const c = new pg.Client({ connectionString: db });
    await c.connect();
    const tables = (await c.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((r) => r.table_name);
    expect(tables).toEqual(['ColourMenu', 'MenuColour', 'Settings', 'UnlockRole', '_prisma_migrations']);
    const rows = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND applied_steps_count = 1");
    expect(rows.rows[0]?.n).toBe(applied.length);
    await c.end();
    expect(await runMigrations({ connectionString: db }, MIGRATIONS, log)).toEqual([]);
  });

  it('agrees with what Prisma already applied (same checksums): nothing to do on the test database', async () => {
    expect(await runMigrations({ connectionString: url }, MIGRATIONS, log)).toEqual([]);
  });

  it('a failing migration is rolled back, recorded, and blocks the next start', async () => {
    const db = await freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'migr-'));
    try {
      mkdirSync(join(dir, '1_ok'));
      writeFileSync(join(dir, '1_ok', 'migration.sql'), 'CREATE TABLE "A" (id int);');
      mkdirSync(join(dir, '2_bad'));
      writeFileSync(join(dir, '2_bad', 'migration.sql'), 'CREATE TABLE "B" (id int); SELECT nope_not_a_function();');
      await expect(runMigrations({ connectionString: db }, dir, log)).rejects.toThrow(/2_bad failed/);
      const c = new pg.Client({ connectionString: db });
      await c.connect();
      // B was rolled back with the failed migration; A stays.
      const tables = (await c.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((r) => r.table_name);
      expect(tables).toEqual(['A', '_prisma_migrations']);
      const failed = await c.query<{ logs: string }>("SELECT logs FROM _prisma_migrations WHERE migration_name = '2_bad'");
      expect(failed.rows[0]?.logs).toMatch(/nope_not_a_function/);
      await c.end();
      await expect(runMigrations({ connectionString: db }, dir, log)).rejects.toThrow(/failed earlier/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
