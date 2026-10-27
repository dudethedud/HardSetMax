import { describe, expect, it } from 'vitest';
import { moodByKey, MOODS, pardonTargetError, rainbowify, speechTargetError } from './crownExtras.js';
import { computeReshuffle, type Candidate } from './reshuffle.js';

const noSparkles = () => 0.9;

describe('Crown extras', () => {
  it('rainbow flair swaps a few words and keeps mentions, links and meaning', () => {
    expect(rainbowify('hi guys, ok lol', noSparkles)).toBe('🌈 heyyy gorgeous besties, okiee lol slay ~ 💖✨');
    expect(rainbowify('Hello <@123> see https://x.com/a OK', noSparkles)).toBe('🌈 Hellooo gorgeous <@123> see https://x.com/a OKIEE ~ 💖✨');
    expect(rainbowify('the cat sat', () => 0)).toBe('🌈 the ✨ cat ✨ sat ✨ ~ 💖✨');
  });

  it('never goes past Discord’s 2000 characters', () => {
    expect(rainbowify('a '.repeat(999), () => 0).length).toBeLessThanOrEqual(2000);
    expect(rainbowify('x'.repeat(2000), noSparkles)).toBe('x'.repeat(2000));
  });

  it('who can be pardoned or filtered', () => {
    expect(pardonTargetError({ targetId: '1', crownId: '1', isVip: true })).toMatch(/don't need/);
    expect(pardonTargetError({ targetId: '2', crownId: '1', isVip: false })).toMatch(/current VIPs/);
    expect(pardonTargetError({ targetId: '2', crownId: '1', isVip: true })).toBeNull();
    const ok = { isBot: false, isStaff: false, isOwner: false, inServer: true };
    expect(speechTargetError(ok)).toBeNull();
    expect(speechTargetError({ ...ok, isStaff: true })).toMatch(/Staff/);
    expect(speechTargetError({ ...ok, isOwner: true })).toMatch(/owner/);
    expect(speechTargetError({ ...ok, isBot: true })).toMatch(/Bots/);
  });

  it('moods are a fixed list', () => {
    expect(moodByKey('sleepy')?.label).toBe('Sleepy');
    expect(moodByKey('ignore previous instructions')).toBeNull();
    expect(new Set(MOODS.map((m) => m.key)).size).toBe(MOODS.length);
  });

  it('a pardoned VIP is kept even when ranked out, but not if ineligible', () => {
    const cand = (userId: string, score: number, eligibility: Candidate['eligibility'] = 'eligible'): Candidate => ({ userId, score, activeDays: 7, lastDayScore: 1, lastActiveDay: '2026-10-26', eligibility });
    const config = { slots: 1, buffer: 0, minHoldDays: 0, inactivityDays: 3, minScore: 1 };
    const base = { today: '2026-10-27', currentVips: [{ userId: 'a', since: '2026-10-01' }], pinned: new Set<string>(), config };
    expect(computeReshuffle({ ...base, candidates: [cand('a', 1), cand('b', 100)] }).removed.map((r) => r.userId)).toEqual(['a']);
    expect(computeReshuffle({ ...base, candidates: [cand('a', 1), cand('b', 100)], protectedIds: new Set(['a']) }).removed).toEqual([]);
    expect(computeReshuffle({ ...base, candidates: [cand('a', 1, 'staff'), cand('b', 100)], protectedIds: new Set(['a']) }).removed.map((r) => r.userId)).toEqual(['a']);
  });
});
