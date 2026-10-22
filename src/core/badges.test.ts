import { describe, expect, it } from 'vitest';
import { formatVipUpdate } from './announcement.js';
import { formatRecap, newBadges, unpinnedWeeks } from './badges.js';

const d = (s: string) => new Date(s);

describe('unpinnedWeeks', () => {
  it('adds up stints and rounds down', () => {
    expect(
      unpinnedWeeks(
        [
          { startedAt: d('2026-01-01T00:00:00Z'), endedAt: d('2026-01-15T00:00:00Z'), pinned: false }, // 2 weeks
          { startedAt: d('2026-03-01T00:00:00Z'), endedAt: d('2026-03-13T00:00:00Z'), pinned: false }, // 12 days
        ],
        d('2026-10-01T00:00:00Z'),
      ),
    ).toBe(3);
  });

  it("doesn't count pinned time", () => {
    expect(
      unpinnedWeeks(
        [
          { startedAt: d('2026-01-01T00:00:00Z'), endedAt: d('2026-01-08T00:00:00Z'), pinned: false },
          { startedAt: d('2026-01-08T00:00:00Z'), endedAt: d('2026-03-08T00:00:00Z'), pinned: true },
        ],
        d('2026-10-01T00:00:00Z'),
      ),
    ).toBe(1);
  });

  it('counts an open stint up to now', () => {
    expect(unpinnedWeeks([{ startedAt: d('2026-10-01T00:00:00Z'), endedAt: null, pinned: false }], d('2026-10-29T00:00:00Z'))).toBe(4);
    expect(unpinnedWeeks([{ startedAt: d('2026-10-01T00:00:00Z'), endedAt: null, pinned: false }], d('2026-10-28T23:59:00Z'))).toBe(3);
  });
});

describe('newBadges', () => {
  const ms = [
    { id: 1, weeks: 4, name: 'VIP Regular' },
    { id: 2, weeks: 12, name: 'VIP Veteran' },
    { id: 3, weeks: 26, name: 'VIP Legend' },
  ];
  it('gives every milestone reached and not owned', () => {
    expect(newBadges(3, ms, new Set()).map((b) => b.id)).toEqual([]);
    expect(newBadges(4, ms, new Set()).map((b) => b.id)).toEqual([1]);
    expect(newBadges(13, ms, new Set([1])).map((b) => b.id)).toEqual([2]);
    expect(newBadges(30, ms, new Set()).map((b) => b.id)).toEqual([1, 2, 3]);
  });
});

describe('announcements with badges', () => {
  it('a new badge alone is enough for a VIP update post, without pinging the earner', () => {
    const msg = formatVipUpdate([], new Map(), [{ userId: '100000000000000001', name: 'VIP Regular' }]);
    expect(msg?.content).toBe('⭐ **VIP update**\n🏅 <@100000000000000001> earned **VIP Regular**');
    expect(msg?.pingUserIds).toEqual([]);
  });

  it('nothing at all: no post', () => {
    expect(formatVipUpdate([], new Map(), [])).toBeNull();
  });
});

describe('formatRecap', () => {
  it('has every SPEC §9 part', () => {
    expect(
      formatRecap({
        from: '2026-10-19',
        to: '2026-10-25',
        crown: '1',
        top: [
          { userId: '1', score: 212 },
          { userId: '2', score: 150.5 },
          { userId: '3', score: 99 },
        ],
        longest: { userId: '2', days: 23 },
        swaps: 5,
        badges: [{ userId: '3', name: 'VIP Regular' }],
      }),
    ).toBe(
      [
        '📅 **Weekly VIP recap** (2026-10-19 to 2026-10-25)',
        '👑 Crown of the week: <@1>',
        '🏆 Top 3: 🥇 <@1> (212) · 🥈 <@2> (150.5) · 🥉 <@3> (99)',
        '⏳ Longest-standing VIP: <@2> (23 days in a row)',
        '🔄 VIP swaps this week: 5',
        '🏅 Badges earned: <@3> VIP Regular',
      ].join('\n'),
    );
  });

  it('handles a quiet week', () => {
    const text = formatRecap({ from: 'a', to: 'b', crown: null, top: [], longest: null, swaps: 0, badges: [] });
    expect(text).toContain('No Crown this week');
    expect(text).toContain('No activity this week');
    expect(text).not.toContain('Badges');
  });
});
