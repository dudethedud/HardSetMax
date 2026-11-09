// Which migrations to apply (pure). Mirrors `prisma migrate deploy` so the bot can
// migrate without the Prisma CLI on the server (docs/DECISIONS.md).

export interface MigrationFile {
  name: string;
  /** sha256 of migration.sql, hex: the same checksum Prisma stores. */
  checksum: string;
}

export interface AppliedRow {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

export type MigrationPlan =
  | { ok: true; pending: MigrationFile[]; changed: string[] }
  | { ok: false; error: string };

export function planMigrations(files: readonly MigrationFile[], applied: readonly AppliedRow[]): MigrationPlan {
  const live = applied.filter((r) => r.rolled_back_at === null);
  // A migration that started but never finished: a person must look at it first (Prisma's P3009).
  const failed = live.find((r) => r.finished_at === null);
  if (failed) return { ok: false, error: `Migration ${failed.migration_name} failed earlier and must be resolved before the bot can start (see docs/OPERATIONS.md).` };
  const done = new Map(live.map((r) => [r.migration_name, r.checksum]));
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    pending: sorted.filter((f) => !done.has(f.name)),
    // Edited after being applied: Prisma only warns about this, and so do we.
    changed: sorted.filter((f) => done.has(f.name) && done.get(f.name) !== f.checksum).map((f) => f.name),
  };
}
