import { describe, expect, it } from 'vitest';
import { checkinDue, checkinOrder, checkinText, dmGap, lastActiveAt, nextEvent, runDay, type CheckinFacts } from './checkins.js';

const DAY = 24 * 3600_000;
const now = new Date('2026-12-10T20:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const tracking = ago(60);
const facts = (over: Partial<CheckinFacts> = {}): CheckinFacts => ({ joinedAt: ago(300), lastMessageAt: ago(8), lastCheckinAt: null, optedOut: false, isBot: false, ...over });

describe('who gets a check-in', () => {
  it('quiet 7+ days: yes; quiet less: no', () => {
    expect(checkinDue(facts(), now, tracking)).toBe(true);
    expect(checkinDue(facts({ lastMessageAt: ago(6) }), now, tracking)).toBe(false);
  });

  it('never if they opted out, or for bots', () => {
    expect(checkinDue(facts({ optedOut: true }), now, tracking)).toBe(false);
    expect(checkinDue(facts({ isBot: true }), now, tracking)).toBe(false);
  });

  it('one per 14 days, and only one until they are active again', () => {
    // Got one 3 days ago: no.
    expect(checkinDue(facts({ lastMessageAt: ago(30), lastCheckinAt: ago(3) }), now, tracking)).toBe(false);
    // Got one 20 days ago and stayed quiet since: still no (one ever until active again).
    expect(checkinDue(facts({ lastMessageAt: ago(30), lastCheckinAt: ago(20) }), now, tracking)).toBe(false);
    // Came back after it (talked 10 days ago), quiet again, and it's been 15 days: yes.
    expect(checkinDue(facts({ lastMessageAt: ago(10), lastCheckinAt: ago(15) }), now, tracking)).toBe(true);
    // Came back but the last one was only 12 days ago: no (14-day limit).
    expect(checkinDue(facts({ lastMessageAt: ago(9), lastCheckinAt: ago(12) }), now, tracking)).toBe(false);
  });

  it('no message on record: quiet since the later of joining and when tracking started', () => {
    expect(lastActiveAt({ joinedAt: ago(300), lastMessageAt: null }, ago(5))).toEqual(ago(5));
    expect(lastActiveAt({ joinedAt: ago(2), lastMessageAt: null }, ago(5))).toEqual(ago(2));
    // Tracking started 5 days ago: nobody without a message is due yet.
    expect(checkinDue(facts({ lastMessageAt: null }), now, ago(5))).toBe(false);
    // A week after tracking started, long-time members who haven't talked since are due.
    expect(checkinDue(facts({ lastMessageAt: null }), now, ago(8))).toBe(true);
    // Joined 3 days ago and never talked: not yet.
    expect(checkinDue(facts({ lastMessageAt: null, joinedAt: ago(3) }), now, ago(30))).toBe(false);
  });

  it('people with messages on record go first, then whoever went quiet most recently', () => {
    const list = [
      { id: 'never-talked', facts: facts({ lastMessageAt: null }) },
      { id: 'quiet-30', facts: facts({ lastMessageAt: ago(30) }) },
      { id: 'quiet-8', facts: facts({ lastMessageAt: ago(8) }) },
    ];
    expect(checkinOrder(list, tracking).map((x) => x.id)).toEqual(['quiet-8', 'quiet-30', 'never-talked']);
  });
});

describe('the event and the message', () => {
  it('the next scheduled event that has not started; none = null', () => {
    const events = [
      { name: 'past', startAt: ago(1), scheduled: true },
      { name: 'live now', startAt: ago(0.01), scheduled: false },
      { name: 'later', startAt: new Date(now.getTime() + 5 * DAY), scheduled: true },
      { name: 'soon', startAt: new Date(now.getTime() + DAY), scheduled: true },
      { name: 'cancelled', startAt: new Date(now.getTime() + 2 * 3600_000), scheduled: false },
    ];
    expect(nextEvent(events, now)?.name).toBe('soon');
    expect(nextEvent(events.slice(0, 2), now)).toBeNull();
    expect(nextEvent([], now)).toBeNull();
  });

  it('the DM text, with the date as a Discord timestamp and the name made safe', () => {
    expect(checkinText('Movie Night', new Date('2026-12-12T03:00:00Z'))).toBe(
      "Hey! It's been a bit, we miss you at Soft Hearts ♡ **Movie Night** is on <t:1797044400:F>, come say hi!\n-# Don't want these? Tap below.",
    );
    expect(checkinText('**bold** _x_', new Date(0))).toContain('**\\*\\*bold\\*\\* \\_x\\_**');
  });

  it('DMs are 5 to 10 minutes apart, at random', () => {
    expect(dmGap(0)).toBe(5 * 60_000);
    expect(dmGap(0.5)).toBe(7.5 * 60_000);
    expect(dmGap(0.999)).toBeLessThan(10 * 60_000);
    expect(dmGap(5)).toBe(10 * 60_000); // never more than 10
  });

  it('runs once a day, after noon Edmonton (UTC-6)', () => {
    expect(runDay(new Date('2026-12-10T17:59:00Z'))).toEqual({ day: '2026-12-10', dueNow: false });
    expect(runDay(new Date('2026-12-10T18:00:00Z'))).toEqual({ day: '2026-12-10', dueNow: true });
    expect(runDay(new Date('2026-12-11T05:00:00Z'))).toEqual({ day: '2026-12-10', dueNow: true });
  });
});
