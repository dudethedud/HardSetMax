import { describe, expect, it } from 'vitest';
import { checkCustomRole, isNearBlack, normalizeRoleName, pickCrown, type CustomRoleContext } from './crown.js';
import type { Candidate } from './reshuffle.js';
import { weekStartOf } from './serverDay.js';

const cand = (userId: string, score: number): Candidate => ({ userId, score, activeDays: 1, lastDayScore: 0, lastActiveDay: null, eligibility: 'eligible' });

describe('pickCrown', () => {
  it('goes to the highest-ranked member of the new VIP list', () => {
    const ranked = [cand('1', 100), cand('2', 90), cand('3', 80)];
    expect(pickCrown({ ranked, finalVips: ['3', '2'] })).toBe('2');
  });

  it('no VIPs, no Crown', () => {
    expect(pickCrown({ ranked: [cand('1', 100)], finalVips: [] })).toBeNull();
  });
});

describe('weekStartOf', () => {
  it('weeks start on Monday', () => {
    expect(weekStartOf('2026-10-26')).toBe('2026-10-26'); // Monday
    expect(weekStartOf('2026-10-25')).toBe('2026-10-19'); // Sunday
    expect(weekStartOf('2026-11-01')).toBe('2026-10-26');
    expect(weekStartOf('2027-01-01')).toBe('2026-12-28'); // across a year
  });
});

describe('role name checks', () => {
  it('normalizes case, symbols and lookalikes', () => {
    expect(normalizeRoleName('M0d3r@tor!')).toBe(normalizeRoleName('moderator'));
    expect(normalizeRoleName('A d m i n')).toBe('admin');
    expect(normalizeRoleName('$taff')).toBe(normalizeRoleName('staff'));
    expect(normalizeRoleName('🔥')).toBe('');
  });

  it('near-black colours are rejected, dark greys are fine', () => {
    expect(isNearBlack(0x000000)).toBe(true);
    expect(isNearBlack(0x1a1a1a)).toBe(true);
    expect(isNearBlack(0x333333)).toBe(false);
    expect(isNearBlack(0x0000ff)).toBe(true); // pure blue is very dark too
  });
});

describe('checkCustomRole', () => {
  const ctx: CustomRoleContext = {
    otherRoleNames: ['VIP', 'Moderator', 'Level 10', 'Crown'],
    staffRoleNames: ['Moderator', 'Admin'],
    blockedWords: ['badword'],
    roleIconsAllowed: true,
    isEdit: false,
    editsUsedThisWeek: 0,
    maxEditsPerWeek: 3,
  };
  const ok = { name: 'Sunset Club', hex: 'ff8800', emoji: '🔥' };

  it('accepts a good role and tidies it', () => {
    expect(checkCustomRole({ ...ok, name: '  Sunset   Club ' }, ctx)).toEqual({
      ok: true,
      value: { name: 'Sunset Club', hex: '#FF8800', hex2: null, emoji: '🔥', useImage: false, emojiIgnored: false },
    });
  });

  it('lists every problem at once', () => {
    const r = checkCustomRole({ name: 'x', hex: 'nope', emoji: 'abc' }, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toHaveLength(3);
  });

  it('rejects names that match or imitate a role, or contain a staff role', () => {
    expect(checkCustomRole({ ...ok, name: 'v.i.p' }, ctx).ok).toBe(false);
    expect(checkCustomRole({ ...ok, name: 'M0DERATOR' }, ctx).ok).toBe(false);
    expect(checkCustomRole({ ...ok, name: 'Moderator Bob' }, ctx).ok).toBe(false);
    expect(checkCustomRole({ ...ok, name: 'Head Adm1n' }, ctx).ok).toBe(false);
    expect(checkCustomRole({ ...ok, name: 'Level 11' }, ctx).ok).toBe(true);
  });

  it('rejects blocked words, including disguised ones', () => {
    expect(checkCustomRole({ ...ok, name: 'the B@dw0rd club' }, ctx).ok).toBe(false);
  });

  it('rejects near-black colours', () => {
    expect(checkCustomRole({ ...ok, hex: '#111111' }, ctx).ok).toBe(false);
  });

  it('ignores the emoji (with a note) below boost level 2', () => {
    expect(checkCustomRole(ok, { ...ctx, roleIconsAllowed: false })).toMatchObject({ ok: true, value: { emoji: null, emojiIgnored: true } });
    expect(checkCustomRole({ ...ok, emoji: '' }, ctx)).toMatchObject({ ok: true, value: { emoji: null, emojiIgnored: false } });
    expect(checkCustomRole({ ...ok, emoji: '👍🏽' }, ctx).ok).toBe(true);
    expect(checkCustomRole({ ...ok, emoji: '<:pepe:123>' }, ctx).ok).toBe(false);
  });

  it('creating is free; edits are limited to 3 per Crown week', () => {
    expect(checkCustomRole(ok, { ...ctx, isEdit: false, editsUsedThisWeek: 3 }).ok).toBe(true);
    expect(checkCustomRole(ok, { ...ctx, isEdit: true, editsUsedThisWeek: 2 }).ok).toBe(true);
    expect(checkCustomRole(ok, { ...ctx, isEdit: true, editsUsedThisWeek: 3 }).ok).toBe(false);
  });

  it('takes an optional second colour for a gradient', () => {
    expect(checkCustomRole({ ...ok, hex2: '9b8cff' }, ctx)).toMatchObject({ ok: true, value: { hex: '#FF8800', hex2: '#9B8CFF' } });
    expect(checkCustomRole({ ...ok, hex2: '  ' }, ctx)).toMatchObject({ ok: true, value: { hex2: null } });
    expect(checkCustomRole({ ...ok, hex2: 'purple' }, ctx).ok).toBe(false);
    expect(checkCustomRole({ ...ok, hex2: '#050505' }, ctx).ok).toBe(false);
  });

  it('takes a PNG or JPG icon up to 256 KB, which wins over the emoji', () => {
    const png = { contentType: 'image/png', size: 40_000 };
    expect(checkCustomRole({ ...ok, image: png }, ctx)).toMatchObject({ ok: true, value: { useImage: true } });
    expect(checkCustomRole({ ...ok, image: { contentType: 'image/jpeg', size: 256 * 1024 } }, ctx).ok).toBe(true);
    expect(checkCustomRole({ ...ok, image: { contentType: 'image/png', size: 256 * 1024 + 1 } }, ctx).ok).toBe(false);
    expect(checkCustomRole({ ...ok, image: { contentType: 'image/gif', size: 1000 } }, ctx).ok).toBe(false);
    expect(checkCustomRole({ ...ok, image: { contentType: null, size: 1000 } }, ctx).ok).toBe(false);
    expect(checkCustomRole({ ...ok, emoji: '', image: png }, { ...ctx, roleIconsAllowed: false })).toMatchObject({ ok: true, value: { useImage: false, emojiIgnored: true } });
  });
});
