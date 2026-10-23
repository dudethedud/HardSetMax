import { describe, expect, it } from 'vitest';
import { DEFAULT_COLOURS, decidePoll, pollThreadName, type PollContext } from './polls.js';
import { parseHexColour } from './vipRules.js';

const base: PollContext = { isStaffOrAdmin: false, isVip: true, userPollsToday: 0, vipPollsToday: 0, cap: 2, hasExtraAllowance: false };

describe('decidePoll', () => {
  it("a VIP's first poll is accepted and locks them", () => {
    expect(decidePoll(base)).toEqual({ accept: true, kind: 'vip', lockUser: true, lockRole: false });
  });

  it('the poll that reaches the cap also locks the VIP role', () => {
    expect(decidePoll({ ...base, vipPollsToday: 1 })).toEqual({ accept: true, kind: 'vip', lockUser: true, lockRole: true });
  });

  it("a VIP's second poll is rejected", () => {
    expect(decidePoll({ ...base, userPollsToday: 1, vipPollsToday: 1 })).toMatchObject({ accept: false, reason: 'already-posted' });
  });

  it('a third VIP poll on the server is rejected', () => {
    expect(decidePoll({ ...base, vipPollsToday: 2 })).toMatchObject({ accept: false, reason: 'cap-reached', lockRole: true });
  });

  it('three VIPs racing: only the first two are accepted', () => {
    let total = 0;
    const results = [1, 2, 3].map(() => {
      const d = decidePoll({ ...base, vipPollsToday: total });
      if (d.accept) total++;
      return d.accept;
    });
    expect(results).toEqual([true, true, false]);
  });

  it('one VIP posting twice quickly: only the first is accepted', () => {
    const first = decidePoll(base);
    const second = decidePoll({ ...base, userPollsToday: 1, vipPollsToday: 1 });
    expect([first.accept, second.accept]).toEqual([true, false]);
  });

  it('/vip poll-unlock gives one more poll even past the cap, without counting toward it', () => {
    expect(decidePoll({ ...base, userPollsToday: 1, vipPollsToday: 2, hasExtraAllowance: true })).toEqual({
      accept: true,
      kind: 'extra',
      lockUser: true,
      lockRole: true,
    });
  });

  it('staff and admins have no limits or locks', () => {
    expect(decidePoll({ ...base, isStaffOrAdmin: true, isVip: false, userPollsToday: 9, vipPollsToday: 9 })).toEqual({
      accept: true,
      kind: 'staff',
      lockUser: false,
      lockRole: false,
    });
  });

  it('non-VIPs are rejected', () => {
    expect(decidePoll({ ...base, isVip: false })).toMatchObject({ accept: false, reason: 'not-vip' });
  });
});

describe('poll helpers', () => {
  it('thread names fit Discord limits', () => {
    expect(pollThreadName('  Best   pizza? ')).toBe('Best pizza?');
    expect(pollThreadName('')).toBe('Poll discussion');
    expect(pollThreadName('x'.repeat(150))).toHaveLength(100);
  });

  it('default colours are valid, unique and not near-black', () => {
    expect(new Set(DEFAULT_COLOURS.map((c) => c.name)).size).toBe(10);
    for (const c of DEFAULT_COLOURS) {
      const n = parseHexColour(c.hex);
      expect(n).not.toBeNull();
      const [r, g, b] = [(n! >> 16) & 255, (n! >> 8) & 255, n! & 255];
      expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThan(60);
    }
  });
});
