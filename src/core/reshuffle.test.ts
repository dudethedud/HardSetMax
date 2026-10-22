import { describe, expect, it } from 'vitest';
import { formatVipUpdate, plainName } from './announcement.js';
import {
  computeReshuffle,
  describeAdd,
  describeRemove,
  isInactive,
  pairAnnouncements,
  rankCandidates,
  type Candidate,
  type CurrentVip,
  type ReshuffleConfig,
  type ReshuffleInput,
} from './reshuffle.js';

const TODAY = '2026-10-23';
const config: ReshuffleConfig = { slots: 10, buffer: 3, minHoldDays: 5, inactivityDays: 3, minScore: 20 };

/** User IDs 100000000000000001, ...02, etc. */
const id = (n: number) => `1000000000000000${String(n).padStart(2, '0')}`;

function cand(n: number, score: number, over: Partial<Candidate> = {}): Candidate {
  return { userId: id(n), score, activeDays: 3, lastDayScore: 1, lastActiveDay: '2026-10-22', eligibility: 'eligible', ...over };
}

const vip = (n: number, since = '2026-10-01'): CurrentVip => ({ userId: id(n), since });

function run(over: Partial<ReshuffleInput>) {
  return computeReshuffle({ today: TODAY, candidates: [], currentVips: [], pinned: new Set(), config, ...over });
}

/** 20 eligible members: #1 has score 200, #2 190, … #20 10. */
const twenty = Array.from({ length: 20 }, (_, i) => cand(i + 1, 200 - i * 10));

describe('fill', () => {
  it('fills an empty VIP list with the top 10 who reach the minimum score', () => {
    const r = run({ candidates: twenty });
    expect(r.finalVips).toEqual(Array.from({ length: 10 }, (_, i) => id(i + 1)));
    expect(r.added.map((a) => a.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.removed).toEqual([]);
    expect(describeAdd(r.added[0]!.reason)).toBe('ranked #1 (score 200)');
  });

  it('respects the minimum score, leaving slots open', () => {
    const r = run({ candidates: [cand(1, 50), cand(2, 20), cand(3, 19.9)] });
    expect(r.finalVips).toEqual([id(1), id(2)]);
  });

  it('a dead week with nobody at the minimum gives no VIPs', () => {
    expect(run({ candidates: [cand(1, 5), cand(2, 1)] }).finalVips).toEqual([]);
  });

  it('an empty server does nothing', () => {
    expect(run({})).toEqual({ added: [], removed: [], finalVips: [], ranked: [] });
  });

  it("doesn't add members inactive for the last 3 days, even with a high score", () => {
    const r = run({ candidates: [cand(1, 500, { lastActiveDay: '2026-10-19' }), cand(2, 30, { lastActiveDay: '2026-10-20' })] });
    expect(r.finalVips).toEqual([id(2)]);
  });

  it("doesn't add ineligible members", () => {
    const r = run({
      candidates: [
        cand(1, 500, { eligibility: 'staff' }),
        cand(2, 400, { eligibility: 'blocked' }),
        cand(3, 300, { eligibility: 'timed-out' }),
        cand(4, 200, { eligibility: 'bot' }),
        cand(5, 100),
      ],
    });
    expect(r.finalVips).toEqual([id(5)]);
    expect(r.ranked.map((c) => c.userId)).toEqual([id(5)]);
  });

  it('only fills open slots', () => {
    const vips = Array.from({ length: 9 }, (_, i) => vip(i + 1));
    const r = run({ candidates: twenty, currentVips: vips });
    expect(r.added.map((a) => a.userId)).toEqual([id(10)]);
    expect(r.finalVips).toHaveLength(10);
  });
});

describe('rank removals: buffer zone and minimum hold', () => {
  const vips = Array.from({ length: 10 }, (_, i) => vip(i + 1));

  it('keeps VIPs ranked down to #13 (slots + buffer)', () => {
    // VIP 1 has the lowest score of all VIPs and ranks #13.
    const candidates = [cand(1, 75), ...twenty.slice(1)];
    const r = run({ candidates, currentVips: vips });
    expect(r.ranked.findIndex((c) => c.userId === id(1)) + 1).toBe(13);
    expect(r.removed).toEqual([]);
    expect(r.added).toEqual([]);
  });

  it('removes a VIP ranked below #13, and the best non-VIP replaces them', () => {
    const candidates = [cand(1, 65), ...twenty.slice(1)];
    const r = run({ candidates, currentVips: vips });
    expect(r.removed.map((x) => [x.userId, describeRemove(x.reason)])).toEqual([[id(1), 'dropped to #14']]);
    expect(r.added.map((a) => [a.userId, a.rank])).toEqual([[id(11), 10]]);
  });

  it('keeps a VIP below #13 who has held VIP for less than 5 days', () => {
    const candidates = [cand(1, 5), ...twenty.slice(1)];
    expect(run({ candidates, currentVips: [vip(1, '2026-10-19'), ...vips.slice(1)] }).removed).toEqual([]); // 4 days
    expect(run({ candidates, currentVips: [vip(1, '2026-10-18'), ...vips.slice(1)] }).removed).toHaveLength(1); // 5 days
  });
});

describe('forced removals', () => {
  it('removes VIPs who became ineligible or left, regardless of rank or hold', () => {
    const r = run({
      candidates: [cand(1, 900, { eligibility: 'timed-out' }), cand(2, 800, { eligibility: 'staff' }), cand(3, 700, { eligibility: 'blocked' })],
      currentVips: [vip(1, TODAY), vip(2, TODAY), vip(3, TODAY), vip(4, TODAY)], // 4 isn't in candidates: left
    });
    expect(r.removed.map((x) => [x.userId, describeRemove(x.reason)]).sort()).toEqual(
      [
        [id(1), 'timed out'],
        [id(2), 'has a staff role'],
        [id(3), 'blocked from VIP'],
        [id(4), 'left the server'],
      ].sort(),
    );
    expect(r.finalVips).toEqual([]);
  });

  it('removes a VIP with no activity for 3 days, even ranked #1', () => {
    const r = run({ candidates: [cand(1, 900, { lastActiveDay: '2026-10-19' })], currentVips: [vip(1)] });
    expect(r.removed.map((x) => describeRemove(x.reason))).toEqual(['inactive 3 days']);
  });

  it('active on the 3rd day back is still active', () => {
    expect(isInactive({ lastActiveDay: '2026-10-20' }, TODAY, 3)).toBe(false);
    expect(isInactive({ lastActiveDay: '2026-10-19' }, TODAY, 3)).toBe(true);
    expect(isInactive({ lastActiveDay: null }, TODAY, 3)).toBe(true);
  });

  it("someone removed can't be re-added in the same reshuffle", () => {
    // Inactive VIP with the top score: removed, and not picked to fill their own slot.
    const r = run({ candidates: [cand(1, 900, { lastActiveDay: '2026-10-10' }), cand(2, 50)], currentVips: [vip(1)] });
    expect(r.finalVips).toEqual([id(2)]);
  });
});

describe('pinned', () => {
  it('pinned VIPs stay even when inactive, ineligible or ranked low', () => {
    const r = run({
      candidates: [cand(1, 0, { lastActiveDay: null, eligibility: 'timed-out' }), ...twenty.slice(1)],
      currentVips: Array.from({ length: 10 }, (_, i) => vip(i + 1)),
      pinned: new Set([id(1)]),
    });
    expect(r.removed).toEqual([]);
    expect(r.finalVips).toContain(id(1));
  });

  it('a pinned VIP who leaves the server is removed', () => {
    const r = run({ candidates: [cand(1, 100, { eligibility: 'left' })], currentVips: [vip(1)], pinned: new Set([id(1)]) });
    expect(r.removed.map((x) => describeRemove(x.reason))).toEqual(['left the server']);
  });

  it("pinned members who aren't VIP yet are added and take a slot", () => {
    const r = run({ candidates: [...twenty, cand(30, 0, { lastActiveDay: null })], pinned: new Set([id(30)]) });
    expect(r.finalVips).toHaveLength(10);
    expect(r.finalVips).toContain(id(30));
    expect(r.finalVips).not.toContain(id(10));
    expect(describeAdd(r.added.find((a) => a.userId === id(30))!.reason)).toBe('pinned');
  });

  it("more pinned VIPs than slots: nobody is removed to make room, and nothing is filled", () => {
    const vips = Array.from({ length: 12 }, (_, i) => vip(i + 1));
    const r = run({ candidates: twenty, currentVips: vips, pinned: new Set([id(11), id(12)]) });
    expect(r.removed).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.finalVips).toHaveLength(12);
  });
});

describe('tie-breakers', () => {
  const tie = (n: number, over: Partial<Candidate> = {}) => cand(n, 50, { activeDays: 3, lastDayScore: 5, ...over });

  it('1. current VIPs before non-VIPs', () => {
    expect(rankCandidates([tie(1), tie(2)], new Set([id(2)])).map((c) => c.userId)).toEqual([id(2), id(1)]);
  });

  it('2. more active days', () => {
    expect(rankCandidates([tie(1, { activeDays: 2 }), tie(2, { activeDays: 4 })], new Set()).map((c) => c.userId)).toEqual([id(2), id(1)]);
  });

  it('3. higher score on the most recent day', () => {
    expect(rankCandidates([tie(1, { lastDayScore: 1 }), tie(2, { lastDayScore: 9 })], new Set()).map((c) => c.userId)).toEqual([id(2), id(1)]);
  });

  it('4. smaller Discord user ID', () => {
    expect(rankCandidates([tie(2), tie(1)], new Set()).map((c) => c.userId)).toEqual([id(1), id(2)]);
  });

  it('decides who gets the last slot', () => {
    const others = Array.from({ length: 9 }, (_, i) => cand(i + 1, 500 - i));
    const r = run({ candidates: [...others, tie(20, { activeDays: 2 }), tie(21, { activeDays: 3 })] });
    expect(r.finalVips).toContain(id(21));
    expect(r.finalVips).not.toContain(id(20));
  });
});

describe('determinism', () => {
  it('gives the same result whatever order the input is in', () => {
    const vips = [vip(3), vip(15), vip(7)];
    const candidates = [...twenty, cand(21, 60, { activeDays: 5 }), cand(22, 60, { activeDays: 5 })];
    const a = run({ candidates, currentVips: vips, pinned: new Set([id(19)]) });
    const shuffled = [...candidates].reverse();
    const b = run({ candidates: shuffled, currentVips: [...vips].reverse(), pinned: new Set([id(19)]) });
    expect(b).toEqual({ ...a, ranked: a.ranked });
  });
});

describe('announcements', () => {
  it('pairs the best new VIP with the lowest-ranked removed VIP', () => {
    const vips = Array.from({ length: 10 }, (_, i) => vip(i + 1));
    // VIPs 1 and 2 drop to #15 and #14, VIP 3 left; 11, 12, 13 come in.
    const candidates = [cand(1, 42), cand(2, 45), ...twenty.slice(3)];
    const r = run({ candidates, currentVips: vips });
    expect(r.removed.map((x) => x.userId)).toEqual([id(3), id(1), id(2)]); // unranked first, then #15, #14
    expect(r.added.map((x) => x.userId)).toEqual([id(11), id(12), id(13)]);
    expect(pairAnnouncements(r.added, r.removed)).toEqual([
      { kind: 'replaced', added: id(11), removed: id(3) },
      { kind: 'replaced', added: id(12), removed: id(1) },
      { kind: 'replaced', added: id(13), removed: id(2) },
    ]);
  });

  it('lists extra additions and removals on their own', () => {
    const r1 = run({ candidates: [cand(1, 100), cand(2, 90)] });
    expect(pairAnnouncements(r1.added, r1.removed).map((l) => l.kind)).toEqual(['filled', 'filled']);
    const r2 = run({ candidates: [cand(1, 100, { eligibility: 'staff' })], currentVips: [vip(1)] });
    expect(pairAnnouncements(r2.added, r2.removed)).toEqual([{ kind: 'left', removed: id(1) }]);
  });

  it('pings only new VIPs and shows old ones by name', () => {
    const msg = formatVipUpdate(
      [
        { kind: 'replaced', added: id(1), removed: id(2) },
        { kind: 'filled', added: id(3) },
        { kind: 'left', removed: id(4) },
      ],
      new Map([
        [id(2), 'Old_Vip'],
        [id(4), '@everyone'],
      ]),
    );
    expect(msg?.content).toBe(
      [`⭐ **VIP update**`, `<@${id(1)}> → replaced Old\\_Vip`, `<@${id(3)}> → filled an open slot`, `@​everyone left VIP`].join('\n'),
    );
    expect(msg?.pingUserIds).toEqual([id(1), id(3)]);
  });

  it('posts nothing when nothing changed', () => {
    expect(formatVipUpdate([], new Map())).toBeNull();
  });

  it('escapes markdown in names', () => {
    expect(plainName('**bold** ~x~ `y`')).toBe('\\*\\*bold\\*\\* \\~x\\~ \\`y\\`');
  });
});
