// Christmas invite event (pure). docs/SPEC.md §8: which invite a join used, whether
// an invite is valid, alt/fraud flags, the leaderboard, the raffle list and the
// Sunday 6 PM schedule.
import { DateTime } from 'luxon';

// Edmonton time. Alberta is on UTC-6 all year from 2026 (tz 2026e); a fixed offset
// keeps the end and the Sunday posts right on hosts whose Node has older time zone
// data (which would still say UTC-7 in winter). docs/DECISIONS.md.
export const EVENT_ZONE = 'UTC-6';
const DAY_MS = 24 * 3600_000;
export const MIN_ACCOUNT_AGE_DAYS = 30;
export const STAY_DAYS = 7;

// ---- Which invite was used ----

export type InviteUse =
  | { kind: 'code'; code: string }
  /** More than one use went up (or one code went up by more than 1): two joins at once. */
  | { kind: 'ambiguous' }
  | { kind: 'vanity' }
  | { kind: 'none' };

/**
 * Compares invite use counts from before and after a join. New codes (made and
 * used before we saw them) count from 0. Exactly one code going up by exactly one
 * is the answer; anything else is never guessed.
 */
export function diffInvites(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, vanity?: { before: number | null; after: number | null }): InviteUse {
  const raised: { code: string; by: number }[] = [];
  for (const [code, uses] of after) {
    const by = uses - (before.get(code) ?? 0);
    if (by > 0) raised.push({ code, by });
  }
  const vanityBy = vanity && vanity.after !== null ? vanity.after - (vanity.before ?? vanity.after) : 0;
  const total = raised.length + (vanityBy > 0 ? 1 : 0);
  if (total > 1 || raised.some((r) => r.by > 1) || vanityBy > 1) return { kind: 'ambiguous' };
  if (raised.length === 1) return { kind: 'code', code: raised[0]!.code };
  if (vanityBy === 1) return { kind: 'vanity' };
  return { kind: 'none' };
}

// ---- Validity ----

export type InviteStatus = 'pending' | 'valid' | 'invalid' | 'left' | 'disqualified';
export const STATUSES: readonly InviteStatus[] = ['pending', 'valid', 'invalid', 'left', 'disqualified'];
export const isStatus = (s: string): s is InviteStatus => (STATUSES as readonly string[]).includes(s);

export interface JoinFacts {
  inviterId: string | null;
  inviteeId: string;
  source: string;
  joinedAt: Date;
  leftAt: Date | null;
  accountCreatedAt: Date;
  isBot: boolean;
  rejoin: boolean;
  validatedAt: Date | null;
  overrideStatus: string | null;
  overrideReason: string | null;
}

export interface EvalContext {
  now: Date;
  eventStart: Date;
  eventEnd: Date;
  /** Counting of new joins stopped early (freeze); otherwise the end time. */
  frozenAt: Date | null;
  /** The invitee has the level 3 role now; null when not in the server. */
  hasLevel3: boolean | null;
  inviterDisqualified: boolean;
}

export interface Evaluation {
  status: InviteStatus;
  reason: string | null;
  /** Set when it becomes valid for the first time. */
  validatedAt: Date | null;
}

/** The last moment a join counts: the freeze, or the end, whichever is first. */
export function joinCutoff(eventEnd: Date, frozenAt: Date | null): Date {
  return frozenAt && frozenAt < eventEnd ? frozenAt : eventEnd;
}

/**
 * An invite's status from its facts (re-run every hour). Order matters: staff
 * overrides, then disqualification, then rules that can never change (invalid),
 * then leaving, then waiting.
 */
export function evaluateJoin(j: JoinFacts, ctx: EvalContext): Evaluation {
  const keep = (status: InviteStatus, reason: string | null): Evaluation => ({ status, reason, validatedAt: j.validatedAt });
  if (j.overrideStatus && isStatus(j.overrideStatus)) {
    return { status: j.overrideStatus, reason: j.overrideReason ?? 'set by staff', validatedAt: j.overrideStatus === 'valid' ? (j.validatedAt ?? ctx.now) : j.validatedAt };
  }
  if (ctx.inviterDisqualified) return keep('disqualified', 'inviter disqualified');
  if (!j.inviterId || (j.source !== 'invite' && j.source !== 'personal')) return keep('invalid', `${j.source} join (no inviter)`);
  if (j.isBot) return keep('invalid', 'bot account');
  if (j.inviterId === j.inviteeId) return keep('invalid', 'self-invite');
  if (j.rejoin) return keep('invalid', 'joined the server before');
  if (j.joinedAt < ctx.eventStart || j.joinedAt > joinCutoff(ctx.eventEnd, ctx.frozenAt)) return keep('invalid', 'joined outside the event');
  if (j.joinedAt.getTime() - j.accountCreatedAt.getTime() < MIN_ACCOUNT_AGE_DAYS * DAY_MS) return keep('invalid', 'account too new');
  const settledAt = j.joinedAt.getTime() + STAY_DAYS * DAY_MS;
  // Rule 2, and a valid invitee leaving before the end stops counting.
  if (j.leftAt && (j.leftAt.getTime() < settledAt || j.leftAt < ctx.eventEnd)) return keep('left', j.leftAt.getTime() < settledAt ? `left within ${STAY_DAYS} days` : 'left before the event ended');
  // Once valid it stays valid while they're in the server (e.g. if the level role is later removed).
  if (j.validatedAt) return keep('valid', null);
  if (ctx.now.getTime() < settledAt) return keep('pending', `waiting for ${STAY_DAYS} days in the server`);
  if (!ctx.hasLevel3) return keep('pending', 'needs the level 3 role');
  return { status: 'valid', reason: null, validatedAt: ctx.now };
}

// ---- Alt / fraud flags ----

/** A name's "base": lowercase letters only, without trailing numbers or separators. */
export function baseName(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\d+$/, '');
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** Same base name (e.g. "luna_22" and "Luna99"), or one letter apart for longer names. */
export function similarNames(a: string, b: string): boolean {
  const x = baseName(a);
  const y = baseName(b);
  if (x.length < 3 || y.length < 3) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 5 && levenshtein(x, y) <= 1;
}

export interface FlagJoin {
  inviteeId: string;
  inviteeName: string;
  joinedAt: Date;
  accountCreatedAt: Date;
  defaultAvatar: boolean;
  leftAt: Date | null;
}

export interface Flag {
  /** Stable key, so each flag is posted once. */
  key: string;
  reason: string;
  inviteeIds: string[];
}

/** Flags for staff after a join by `latest` from `inviter` (whose earlier joins are `joins`, latest included). */
export function flagsForJoin(inviter: { id: string; name: string }, joins: readonly FlagJoin[], latest: FlagJoin, now: Date): Flag[] {
  const flags: Flag[] = [];
  const hourAgo = now.getTime() - 3600_000;
  const recent = joins.filter((j) => j.joinedAt.getTime() >= hourAgo);
  if (recent.length >= 5) {
    flags.push({ key: `burst:${inviter.id}:${Math.floor(now.getTime() / DAY_MS)}`, reason: `${recent.length} joins within 1 hour`, inviteeIds: recent.map((j) => j.inviteeId) });
  }
  if (latest.defaultAvatar && latest.joinedAt.getTime() - latest.accountCreatedAt.getTime() < 90 * DAY_MS) {
    flags.push({ key: `newdefault:${latest.inviteeId}`, reason: 'default avatar and an account under 90 days old', inviteeIds: [latest.inviteeId] });
  }
  const twins = joins.filter((j) => j.inviteeId !== latest.inviteeId && similarNames(j.inviteeName, latest.inviteeName));
  if (similarNames(latest.inviteeName, inviter.name) || twins.length) {
    const who = similarNames(latest.inviteeName, inviter.name) ? "the inviter's" : 'other invitees from the same inviter';
    flags.push({ key: `name:${latest.inviteeId}`, reason: `username "${latest.inviteeName}" is very similar to ${who}`, inviteeIds: [latest.inviteeId, ...twins.map((j) => j.inviteeId)] });
  }
  flags.push(...leaveRateFlag(inviter.id, joins));
  return flags;
}

/** Over 50% of an inviter's invitees left, after 5+ joins (checked on joins and on leaves). */
export function leaveRateFlag(inviterId: string, joins: readonly FlagJoin[]): Flag[] {
  const left = joins.filter((j) => j.leftAt);
  if (joins.length < 5 || left.length / joins.length <= 0.5) return [];
  return [{ key: `leaverate:${inviterId}`, reason: `${left.length} of ${joins.length} invitees left (${Math.round((left.length / joins.length) * 100)}%)`, inviteeIds: left.map((j) => j.inviteeId) }];
}

// ---- Leaderboard and raffle ----

export interface ValidRow {
  inviterId: string;
  validatedAt: Date;
}

/** Valid invites per inviter, most first; ties go to whoever reached their count first. */
export function rankInviters(rows: readonly ValidRow[], excluded: ReadonlySet<string> = new Set()): { inviterId: string; count: number; reachedAt: Date }[] {
  const by = new Map<string, Date[]>();
  for (const r of rows) {
    if (excluded.has(r.inviterId)) continue;
    const list = by.get(r.inviterId) ?? [];
    list.push(r.validatedAt);
    by.set(r.inviterId, list);
  }
  return [...by]
    .map(([inviterId, times]) => ({ inviterId, count: times.length, reachedAt: new Date(Math.max(...times.map((t) => t.getTime()))) }))
    .sort((a, b) => b.count - a.count || a.reachedAt.getTime() - b.reachedAt.getTime() || a.inviterId.localeCompare(b.inviterId));
}

const MEDALS = ['🥇', '🥈', '🥉'];
export function leaderboardLines(ranked: readonly { inviterId: string; count: number }[], limit: number): string[] {
  return ranked.slice(0, limit).map((r, i) => `${MEDALS[i] ?? `${i + 1}.`} <@${r.inviterId}> ── **${r.count}** invite${r.count === 1 ? '' : 's'}`);
}

/** CSV for wheelofnames.com: one line per raffle entry (each valid invite). Names are quoted and commas/quotes escaped. */
export function raffleCsv(entries: readonly { name: string; count: number }[]): string {
  const cell = (s: string) => `"${s.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
  return entries.flatMap((e) => Array.from({ length: e.count }, () => cell(e.name))).join('\n') + '\n';
}

// ---- Time ----

/** Whole days left until `end` (0 once it's passed). */
export function daysLeft(now: Date, end: Date): number {
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}

/** The most recent Sunday 6 PM Edmonton at or before `now`, and its date (to post each Sunday once). */
export function lastSundayPost(now: Date): { at: Date; day: string } {
  const local = DateTime.fromJSDate(now, { zone: EVENT_ZONE });
  // luxon weekday: 7 = Sunday.
  let sunday = local.minus({ days: local.weekday % 7 }).set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
  if (sunday > local) sunday = sunday.minus({ weeks: 1 });
  return { at: sunday.toJSDate(), day: sunday.toISODate()! };
}

/** "2026-12-25T12:00" in Edmonton time, as an instant. */
export function edmontonTime(iso: string): Date {
  const dt = DateTime.fromISO(iso, { zone: EVENT_ZONE });
  if (!dt.isValid) throw new Error(`not a valid date/time: ${iso}`);
  return dt.toJSDate();
}
