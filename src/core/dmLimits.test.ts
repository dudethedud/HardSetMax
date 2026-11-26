import { describe, expect, it } from 'vitest';
import { BRAKE_HOLD_MS, brakeOnLoss, dmSlot, isBraked, NO_BRAKE, recentDms, type BrakeState } from './dmLimits.js';

const MIN = 60_000;

describe('DM limits', () => {
  it('at least 3 seconds between DMs', () => {
    expect(dmSlot([], 1_000_000, 0)).toEqual({ kind: 'go' });
    expect(dmSlot([1_000_000], 1_001_000, 0)).toEqual({ kind: 'wait', ms: 2000 });
    expect(dmSlot([1_000_000], 1_003_000, 0)).toEqual({ kind: 'go' });
  });

  it('at most 30 an hour: the 31st is skipped, not queued', () => {
    const now = 10 * 60 * MIN;
    // 30 DMs in the last half hour, one a minute.
    const sent = Array.from({ length: 30 }, (_, i) => now - 30 * MIN + i * MIN);
    expect(dmSlot(sent, now, 0)).toEqual({ kind: 'held', reason: 'hourly limit' });
    // An hour after the oldest, there's room again.
    expect(dmSlot(sent, now + 30 * MIN + 1, 0)).toEqual({ kind: 'go' });
    expect(recentDms(sent, now + 30 * MIN + 1)).toHaveLength(29);
  });

  it('a rate limit pauses every DM until the pause is over', () => {
    expect(dmSlot([], 5000, 6000)).toEqual({ kind: 'held', reason: 'paused' });
    expect(dmSlot([], 6000, 6000)).toEqual({ kind: 'go' });
  });
});

describe('mass-removal brake', () => {
  const lose = (s: BrakeState, times: number[]) => times.reduce((acc, t) => brakeOnLoss(acc.state, t), { state: s, braked: false, tripped: false });

  it('up to 10 colour losses in 5 minutes are normal', () => {
    const r = lose(NO_BRAKE, Array.from({ length: 10 }, (_, i) => i * 1000));
    expect(r.braked).toBe(false);
  });

  it('the 11th within 5 minutes trips it (once), and it holds 15 minutes after the last loss', () => {
    let r = lose(NO_BRAKE, Array.from({ length: 10 }, (_, i) => i * 1000));
    r = brakeOnLoss(r.state, 11_000);
    expect(r).toMatchObject({ braked: true, tripped: true });
    r = brakeOnLoss(r.state, 12_000);
    expect(r).toMatchObject({ braked: true, tripped: false });
    expect(isBraked(r.state, 12_000 + BRAKE_HOLD_MS - 1)).toBe(true);
    expect(isBraked(r.state, 12_000 + BRAKE_HOLD_MS)).toBe(false);
  });

  it('losses spread over more than 5 minutes never trip it', () => {
    const r = lose(NO_BRAKE, Array.from({ length: 30 }, (_, i) => i * MIN));
    expect(r.braked).toBe(false);
  });
});
