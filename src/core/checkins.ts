// Check-in DMs for quiet members (pure). docs/SPEC.md §9: who is due one, which
// event to mention, the order they're sent in, and the message itself.
import { DateTime } from 'luxon';
import { EVENT_ZONE } from './inviteEvent.js';

const DAY_MS = 24 * 3600_000;
/** Quiet this long before a check-in. */
export const INACTIVE_DAYS = 7;
/** At most one check-in per member this often. */
export const COOLDOWN_DAYS = 14;
/** Per daily run, to stay well clear of Discord's spam filter. */
export const MAX_PER_RUN = 20;
/**
 * Time between check-in DMs: 5 minutes plus a random 0–5 more, so 20 DMs are spread
 * over about 2½ hours instead of arriving as a steady burst (what spam filters look for).
 */
export const DM_GAP_MS = 5 * 60_000;
export const DM_GAP_JITTER_MS = 5 * 60_000;

/** The wait before the next DM, from a random number in [0, 1). */
export function dmGap(random: number): number {
  return DM_GAP_MS + Math.floor(Math.min(Math.max(random, 0), 1) * DM_GAP_JITTER_MS);
}

/** The daily run starts after this hour (Edmonton), so DMs arrive at a friendly time. */
export const RUN_AFTER_HOUR = 12;

export interface CheckinFacts {
  joinedAt: Date | null;
  lastMessageAt: Date | null;
  lastCheckinAt: Date | null;
  optedOut: boolean;
  isBot: boolean;
}

/**
 * When they were last active: their last message, or, with none on record, the later
 * of when they joined and when the bot started noticing messages (it can't know
 * anything older).
 */
export function lastActiveAt(f: Pick<CheckinFacts, 'joinedAt' | 'lastMessageAt'>, trackingStartedAt: Date): Date {
  if (f.lastMessageAt) return f.lastMessageAt;
  return f.joinedAt && f.joinedAt > trackingStartedAt ? f.joinedAt : trackingStartedAt;
}

/** Quiet 7+ days, not opted out, no check-in in 14 days, and none at all since they were last active. */
export function checkinDue(f: CheckinFacts, now: Date, trackingStartedAt: Date): boolean {
  if (f.optedOut || f.isBot) return false;
  const active = lastActiveAt(f, trackingStartedAt);
  if (now.getTime() - active.getTime() < INACTIVE_DAYS * DAY_MS) return false;
  if (f.lastCheckinAt) {
    // One check-in until they've been active again.
    if (f.lastCheckinAt >= active) return false;
    if (now.getTime() - f.lastCheckinAt.getTime() < COOLDOWN_DAYS * DAY_MS) return false;
  }
  return true;
}

/** Who goes first when more than 20 are due: people with messages on record, then whoever went quiet most recently. */
export function checkinOrder<T extends { facts: CheckinFacts }>(due: readonly T[], trackingStartedAt: Date): T[] {
  return [...due].sort(
    (a, b) =>
      Number(!!b.facts.lastMessageAt) - Number(!!a.facts.lastMessageAt) ||
      lastActiveAt(b.facts, trackingStartedAt).getTime() - lastActiveAt(a.facts, trackingStartedAt).getTime(),
  );
}

export interface ScheduledEventInfo {
  name: string;
  startAt: Date | null;
  /** Discord's status: only "scheduled" events that haven't started count as upcoming. */
  scheduled: boolean;
}

/** The next upcoming scheduled event, or null (then no check-ins are sent). */
export function nextEvent<T extends ScheduledEventInfo>(events: readonly T[], now: Date): T | null {
  return [...events].filter((e) => e.scheduled && e.startAt && e.startAt > now).sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime())[0] ?? null;
}

/** The check-in DM. The date is a Discord timestamp, so everyone sees it in their own time zone. */
export function checkinText(eventName: string, startAt: Date): string {
  const name = eventName.replace(/[*_~`|>\\]/g, (c) => `\\${c}`).replace(/\s+/g, ' ').trim();
  return `Hey! It's been a bit, we miss you at Soft Hearts ♡ **${name}** is on <t:${Math.floor(startAt.getTime() / 1000)}:F>, come say hi!\n-# Don't want these? Tap below.`;
}

/** The Edmonton date (to run once a day) and whether it's late enough in the day to run. */
export function runDay(now: Date): { day: string; dueNow: boolean } {
  const local = DateTime.fromJSDate(now, { zone: EVENT_ZONE });
  return { day: local.toISODate()!, dueNow: local.hour >= RUN_AFTER_HOUR };
}
