import { describe, expect, it } from 'vitest';
import {
  baseName,
  daysLeft,
  diffInvites,
  edmontonTime,
  evaluateJoin,
  flagsForJoin,
  lastSundayPost,
  leaderboardLines,
  leaveRateFlag,
  raffleCsv,
  rankInviters,
  similarNames,
  type EvalContext,
  type FlagJoin,
  type JoinFacts,
} from './inviteEvent.js';

const DAY = 24 * 3600_000;
const m = (entries: [string, number][]) => new Map(entries);

describe('which invite a join used', () => {
  it('exactly one code went up by one', () => {
    expect(diffInvites(m([['a', 3], ['b', 1]]), m([['a', 4], ['b', 1]]))).toEqual({ kind: 'code', code: 'a' });
  });

  it('a new code we had not seen yet counts from 0', () => {
    expect(diffInvites(m([['a', 3]]), m([['a', 3], ['new', 1]]))).toEqual({ kind: 'code', code: 'new' });
  });

  it('two codes up, or one code up by two: ambiguous, never guessed', () => {
    expect(diffInvites(m([['a', 1], ['b', 1]]), m([['a', 2], ['b', 2]]))).toEqual({ kind: 'ambiguous' });
    expect(diffInvites(m([['a', 1]]), m([['a', 3]]))).toEqual({ kind: 'ambiguous' });
    expect(diffInvites(m([['a', 1]]), m([['a', 2]]), { before: 5, after: 6 })).toEqual({ kind: 'ambiguous' });
  });

  it('only the vanity link went up', () => {
    expect(diffInvites(m([['a', 1]]), m([['a', 1]]), { before: 5, after: 6 })).toEqual({ kind: 'vanity' });
  });

  it('nothing went up (discovery, an expired one-use link, or unknown)', () => {
    expect(diffInvites(m([['a', 1]]), m([['a', 1]]))).toEqual({ kind: 'none' });
    // A code that disappeared (used up and deleted) isn't counted as "up".
    expect(diffInvites(m([['a', 1], ['gone', 0]]), m([['a', 1]]))).toEqual({ kind: 'none' });
  });
});

describe('validity rules', () => {
  const start = new Date('2026-11-22T12:00:00Z');
  const end = new Date('2026-12-25T18:00:00Z');
  const joined = new Date('2026-12-01T12:00:00Z');
  const facts = (over: Partial<JoinFacts> = {}): JoinFacts => ({
    inviterId: 'inviter',
    inviteeId: 'invitee',
    source: 'invite',
    joinedAt: joined,
    leftAt: null,
    accountCreatedAt: new Date(joined.getTime() - 60 * DAY),
    isBot: false,
    rejoin: false,
    validatedAt: null,
    overrideStatus: null,
    overrideReason: null,
    ...over,
  });
  const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({
    now: new Date(joined.getTime() + 8 * DAY),
    eventStart: start,
    eventEnd: end,
    frozenAt: null,
    hasLevel3: true,
    inviterDisqualified: false,
    ...over,
  });

  it('valid when every rule passes, stamped with when', () => {
    expect(evaluateJoin(facts(), ctx())).toEqual({ status: 'valid', reason: null, validatedAt: ctx().now });
  });

  it('rule 1: accounts under 30 days old are invalid', () => {
    expect(evaluateJoin(facts({ accountCreatedAt: new Date(joined.getTime() - 29 * DAY) }), ctx())).toMatchObject({ status: 'invalid', reason: 'account too new' });
  });

  it('rule 2: waits 7 days; leaving within them is "left"', () => {
    expect(evaluateJoin(facts(), ctx({ now: new Date(joined.getTime() + 6 * DAY) }))).toMatchObject({ status: 'pending' });
    expect(evaluateJoin(facts({ leftAt: new Date(joined.getTime() + 3 * DAY) }), ctx())).toMatchObject({ status: 'left' });
  });

  it('rule 3: pending until they have the level 3 role', () => {
    expect(evaluateJoin(facts(), ctx({ hasLevel3: false }))).toMatchObject({ status: 'pending', reason: 'needs the level 3 role' });
  });

  it('rule 4: people who were in the server before never count', () => {
    expect(evaluateJoin(facts({ rejoin: true }), ctx())).toMatchObject({ status: 'invalid', reason: 'joined the server before' });
  });

  it('a valid invitee who leaves before the end goes back to "left"; after the end it stays valid', () => {
    const validated = new Date(joined.getTime() + 8 * DAY);
    expect(evaluateJoin(facts({ validatedAt: validated, leftAt: new Date('2026-12-20T00:00:00Z') }), ctx())).toMatchObject({ status: 'left' });
    expect(evaluateJoin(facts({ validatedAt: validated, leftAt: new Date('2026-12-26T00:00:00Z') }), ctx())).toMatchObject({ status: 'valid' });
    // Once valid, losing the level role doesn't undo it.
    expect(evaluateJoin(facts({ validatedAt: validated }), ctx({ hasLevel3: false }))).toMatchObject({ status: 'valid', validatedAt: validated });
  });

  it('self-invites, bots and joins with no inviter are always invalid', () => {
    expect(evaluateJoin(facts({ inviteeId: 'inviter' }), ctx())).toMatchObject({ status: 'invalid', reason: 'self-invite' });
    expect(evaluateJoin(facts({ isBot: true }), ctx())).toMatchObject({ status: 'invalid', reason: 'bot account' });
    expect(evaluateJoin(facts({ inviterId: null, source: 'vanity' }), ctx())).toMatchObject({ status: 'invalid', reason: 'vanity join (no inviter)' });
  });

  it('only joins between the start and the end (or an early freeze) count', () => {
    expect(evaluateJoin(facts({ joinedAt: new Date(start.getTime() - 1000) }), ctx())).toMatchObject({ status: 'invalid', reason: 'joined outside the event' });
    expect(evaluateJoin(facts(), ctx({ frozenAt: new Date(joined.getTime() - 1000) }))).toMatchObject({ status: 'invalid', reason: 'joined outside the event' });
  });

  it('joins in the last week keep being checked after the end', () => {
    const late = new Date(end.getTime() - 2 * DAY);
    expect(evaluateJoin(facts({ joinedAt: late, accountCreatedAt: new Date(late.getTime() - 90 * DAY) }), ctx({ now: new Date(late.getTime() + 7 * DAY + 1000) }))).toMatchObject({ status: 'valid' });
  });

  it('disqualified inviters and staff overrides win', () => {
    expect(evaluateJoin(facts(), ctx({ inviterDisqualified: true }))).toMatchObject({ status: 'disqualified' });
    expect(evaluateJoin(facts({ overrideStatus: 'invalid', overrideReason: 'same person' }), ctx())).toMatchObject({ status: 'invalid', reason: 'same person' });
    expect(evaluateJoin(facts({ overrideStatus: 'valid', isBot: true }), ctx())).toMatchObject({ status: 'valid' });
  });
});

describe('alt / fraud flags', () => {
  const now = new Date('2026-12-01T12:00:00Z');
  const j = (id: string, name: string, over: Partial<FlagJoin> = {}): FlagJoin => ({
    inviteeId: id,
    inviteeName: name,
    joinedAt: now,
    accountCreatedAt: new Date(now.getTime() - 400 * DAY),
    defaultAvatar: false,
    leftAt: null,
    ...over,
  });

  it('similar names: same base with numbers, or one letter off for longer names', () => {
    expect(baseName('Luna_22')).toBe('luna');
    expect(similarNames('luna_22', 'Luna99')).toBe(true);
    expect(similarNames('starlight', 'starlite')).toBe(false);
    expect(similarNames('moonbeam', 'moonbeams')).toBe(true);
    expect(similarNames('ab1', 'ab2')).toBe(false); // too short to tell
    expect(similarNames('sakura', 'bubbles')).toBe(false);
  });

  it('5+ joins in an hour', () => {
    const joins = ['a', 'b', 'c', 'd', 'e'].map((n, i) => j(n, `person${n}${i}x`));
    expect(flagsForJoin({ id: 'inv', name: 'inviter' }, joins, joins[4]!, now).map((f) => f.reason)).toContain('5 joins within 1 hour');
    expect(flagsForJoin({ id: 'inv', name: 'inviter' }, joins.slice(0, 4), joins[3]!, now).some((f) => f.key.startsWith('burst'))).toBe(false);
  });

  it('default avatar with a young account', () => {
    const fresh = j('x', 'someone', { defaultAvatar: true, accountCreatedAt: new Date(now.getTime() - 40 * DAY) });
    expect(flagsForJoin({ id: 'inv', name: 'inviter' }, [fresh], fresh, now)[0]).toMatchObject({ key: 'newdefault:x', inviteeIds: ['x'] });
  });

  it('a name like the inviter’s or like other invitees’', () => {
    const twin = j('x', 'kitty_02');
    expect(flagsForJoin({ id: 'inv', name: 'Kitty' }, [twin], twin, now)[0]!.reason).toMatch(/similar to the inviter's/);
    const first = j('y', 'blossom1');
    const second = j('z', 'blossom22');
    expect(flagsForJoin({ id: 'inv', name: 'inviter' }, [first, second], second, now)[0]).toMatchObject({ key: 'name:z', inviteeIds: ['z', 'y'] });
  });

  it('over 50% left after 5+ joins', () => {
    const joins = ['a', 'b', 'c', 'd', 'e'].map((n, i) => j(n, `p${n}${i}aa`, { leftAt: i < 3 ? now : null }));
    expect(leaveRateFlag('inv', joins)[0]!.reason).toBe('3 of 5 invitees left (60%)');
    expect(leaveRateFlag('inv', joins.slice(0, 4))).toEqual([]);
  });
});

describe('leaderboard and raffle', () => {
  it('most valid invites first; ties go to whoever got there first; disqualified left out', () => {
    const t = (d: number) => new Date(Date.UTC(2026, 11, d));
    const rows = [
      { inviterId: 'a', validatedAt: t(1) },
      { inviterId: 'a', validatedAt: t(5) },
      { inviterId: 'b', validatedAt: t(2) },
      { inviterId: 'b', validatedAt: t(3) },
      { inviterId: 'c', validatedAt: t(1) },
      { inviterId: 'x', validatedAt: t(1) },
      { inviterId: 'x', validatedAt: t(1) },
      { inviterId: 'x', validatedAt: t(1) },
    ];
    const ranked = rankInviters(rows, new Set(['x']));
    expect(ranked.map((r) => [r.inviterId, r.count])).toEqual([['b', 2], ['a', 2], ['c', 1]]);
    expect(leaderboardLines(ranked, 5)).toEqual(['🥇 <@b> ── **2** invites', '🥈 <@a> ── **2** invites', '🥉 <@c> ── **1** invite']);
  });

  it('places 4 and 5 are numbered', () => {
    const ranked = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ inviterId: id, count: 10 - i }));
    expect(leaderboardLines(ranked, 5).slice(3)).toEqual(['4. <@d> ── **7** invites', '5. <@e> ── **6** invites']);
  });

  it('raffle CSV: one line per entry, names quoted safely', () => {
    expect(raffleCsv([{ name: 'luna', count: 2 }, { name: 'a "b", c', count: 1 }])).toBe('"luna"\n"luna"\n"a ""b"", c"\n');
  });
});

describe('event time', () => {
  it('the end is Dec 25 12:00 in Edmonton (UTC-6 all year from 2026)', () => {
    expect(edmontonTime('2026-12-25T12:00').toISOString()).toBe('2026-12-25T18:00:00.000Z');
    expect(() => edmontonTime('nope')).toThrow();
  });

  it('days left', () => {
    const end = edmontonTime('2026-12-25T12:00');
    expect(daysLeft(new Date(end.getTime() - 2.5 * DAY), end)).toBe(3);
    expect(daysLeft(new Date(end.getTime() + DAY), end)).toBe(0);
  });

  it('the latest Sunday 6 PM in Edmonton', () => {
    // Sunday Nov 29 2026, 18:30 Edmonton = 00:30 UTC Monday.
    expect(lastSundayPost(new Date('2026-11-30T00:30:00Z'))).toEqual({ at: new Date('2026-11-30T00:00:00Z'), day: '2026-11-29' });
    // Sunday 17:00 Edmonton: still last week's.
    expect(lastSundayPost(new Date('2026-11-29T23:00:00Z')).day).toBe('2026-11-22');
    // A Wednesday.
    expect(lastSundayPost(new Date('2026-12-02T20:00:00Z')).day).toBe('2026-11-29');
  });
});
