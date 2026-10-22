// The one definition of a "server-day" (SPEC §2). Every date/day calculation in the
// bot goes through this file; nothing else uses UTC dates or its own "midnight".
//
// A server-day starts at the boundary time (e.g. "00:00") in the server's timezone
// and ends at the next boundary. It is named by the local date it starts on, so
// with the default 00:00 boundary the key is just the local calendar date.
import { DateTime, IANAZone } from 'luxon';

export interface DayBoundary {
  /** IANA timezone, e.g. "America/Edmonton". */
  timezone: string;
  /** Local time of day the server-day starts, "HH:mm" (24 h). */
  time: string;
}

export interface ServerDay {
  /** "YYYY-MM-DD": the local date this server-day starts on. */
  key: string;
  start: Date;
  /** Exclusive: the start of the next server-day. */
  end: Date;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimezone(timezone: string): boolean {
  return IANAZone.isValidZone(timezone);
}

export function isValidBoundaryTime(time: string): boolean {
  return TIME_RE.test(time);
}

function parseTime(time: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(time);
  if (!m) throw new Error(`Invalid boundary time "${time}", expected HH:mm`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function assertZone(timezone: string): void {
  if (!isValidTimezone(timezone)) throw new Error(`Invalid timezone "${timezone}"`);
}

function parseKey(key: string, timezone: string): DateTime {
  const d = KEY_RE.test(key) ? DateTime.fromISO(key, { zone: timezone }) : null;
  if (!d?.isValid) throw new Error(`Invalid server-day key "${key}", expected YYYY-MM-DD`);
  return d;
}

/**
 * The instant the boundary happens on a local date.
 *
 * If the boundary time doesn't exist that day (it falls in the spring-forward gap,
 * e.g. 02:30), it happens at the first valid time after the gap (03:00). If it
 * happens twice (fall-back), the first occurrence is used.
 */
function boundaryOnDate(date: DateTime, b: DayBoundary): DateTime {
  const { hour, minute } = parseTime(b.time);
  const wanted = hour * 60 + minute;
  // Luxon resolves ambiguous times to the first occurrence, and pushes times in a
  // gap forward by the gap's length (02:30 → 03:30).
  let t = date.set({ hour, minute, second: 0, millisecond: 0 });
  // Walk back to the end of the gap: the earliest instant that day whose local
  // time is at or after the boundary. Only loops on spring-forward days.
  for (;;) {
    const prev = t.minus({ minutes: 1 });
    if (!prev.hasSame(t, 'day') || prev.hour * 60 + prev.minute < wanted) return t;
    t = prev;
  }
}

/** The server-day with this key. */
export function serverDayByKey(key: string, b: DayBoundary): ServerDay {
  assertZone(b.timezone);
  const date = parseKey(key, b.timezone);
  return {
    key,
    start: boundaryOnDate(date, b).toJSDate(),
    end: boundaryOnDate(date.plus({ days: 1 }), b).toJSDate(),
  };
}

/** The server-day an instant belongs to. */
export function serverDayAt(instant: Date, b: DayBoundary): ServerDay {
  assertZone(b.timezone);
  const local = DateTime.fromJSDate(instant, { zone: b.timezone });
  const today = local.startOf('day');
  const date = local < boundaryOnDate(today, b) ? today.minus({ days: 1 }) : today;
  return serverDayByKey(date.toISODate()!, b);
}

/** The key of the server-day `days` after (or before, if negative) `key`. */
export function addServerDays(key: string, days: number): string {
  // Keys are plain dates; adding days doesn't depend on the timezone.
  return parseKey(key, 'UTC').plus({ days }).toISODate()!;
}

/**
 * The last `count` complete server-days before the one containing `now`, oldest
 * first. This is the scoring window (SPEC §2, "Score").
 */
export function completedServerDays(now: Date, count: number, b: DayBoundary): string[] {
  const current = serverDayAt(now, b).key;
  return Array.from({ length: count }, (_, i) => addServerDays(current, i - count));
}

/** Whole server-days from `from` to `to` (negative if `to` is earlier). */
export function serverDaysBetween(from: string, to: string): number {
  return Math.round(parseKey(to, 'UTC').diff(parseKey(from, 'UTC'), 'days').days);
}
