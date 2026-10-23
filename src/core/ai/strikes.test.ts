import { describe, expect, it } from 'vitest';
import { extractStrike, reachedStrikeLimit } from './strikes.js';

describe('extractStrike', () => {
  it('finds and removes the tag, whatever its case or spacing', () => {
    expect(extractStrike('nuh uh im a good boy lets keep it nice [[STRIKE]]')).toEqual({ text: 'nuh uh im a good boy lets keep it nice', strike: true });
    expect(extractStrike('[[ strike ]] no thanks')).toEqual({ text: 'no thanks', strike: true });
    expect(extractStrike('hiii :3')).toEqual({ text: 'hiii :3', strike: false });
  });
});

describe('reachedStrikeLimit', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  it('counts strikes in the last 24 hours only', () => {
    expect(reachedStrikeLimit([hoursAgo(0)], now, 2)).toBe(false);
    expect(reachedStrikeLimit([hoursAgo(0), hoursAgo(5)], now, 2)).toBe(true);
    expect(reachedStrikeLimit([hoursAgo(0), hoursAgo(25)], now, 2)).toBe(false);
    expect(reachedStrikeLimit([hoursAgo(0)], now, 1)).toBe(true);
  });
});
