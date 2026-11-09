import { describe, expect, it } from 'vitest';
import { planMigrations } from './migrations.js';

const f = (name: string, checksum = `c-${name}`) => ({ name, checksum });
const row = (name: string, over: Partial<{ checksum: string; finished_at: Date | null; rolled_back_at: Date | null }> = {}) => ({
  migration_name: name,
  checksum: `c-${name}`,
  finished_at: new Date(),
  rolled_back_at: null,
  ...over,
});

describe('planMigrations', () => {
  it('applies the ones not done yet, oldest first', () => {
    expect(planMigrations([f('2_b'), f('1_a'), f('3_c')], [row('1_a')])).toEqual({ ok: true, pending: [f('2_b'), f('3_c')], changed: [] });
    expect(planMigrations([f('1_a')], [row('1_a')])).toEqual({ ok: true, pending: [], changed: [] });
  });

  it('stops on a migration that failed earlier, like prisma migrate deploy', () => {
    const plan = planMigrations([f('1_a'), f('2_b')], [row('1_a'), row('2_b', { finished_at: null })]);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toMatch(/2_b failed earlier/);
  });

  it('a rolled-back row is ignored, so the migration runs again', () => {
    expect(planMigrations([f('1_a')], [row('1_a', { finished_at: null, rolled_back_at: new Date() })])).toMatchObject({ ok: true, pending: [f('1_a')] });
  });

  it('reports files edited after they were applied', () => {
    expect(planMigrations([f('1_a', 'new')], [row('1_a')])).toEqual({ ok: true, pending: [], changed: ['1_a'] });
  });
});
