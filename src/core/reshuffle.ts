// The daily VIP reshuffle (SPEC §4). Pure: the same input always gives the same
// output, so `/vip preview` and the real reshuffle always agree.
import { compareUserIds } from './scoring.js';
import { addServerDays, serverDaysBetween } from './serverDay.js';

/** Why someone can't be VIP right now (SPEC §3 "Eligibility"). */
export type Eligibility = 'eligible' | 'left' | 'bot' | 'staff' | 'timed-out' | 'blocked';

export interface Candidate {
  userId: string;
  score: number;
  activeDays: number;
  lastDayScore: number;
  /** Most recent server-day with counted activity, any time back; null if never. */
  lastActiveDay: string | null;
  eligibility: Eligibility;
}

export interface CurrentVip {
  userId: string;
  /** Server-day key of the reshuffle (or admin action) that gave them VIP. */
  since: string;
}

export interface ReshuffleConfig {
  slots: number;
  buffer: number;
  minHoldDays: number;
  inactivityDays: number;
  minScore: number;
}

export interface ReshuffleInput {
  /** Server-day key of the day the reshuffle starts (it runs at that day's boundary). */
  today: string;
  /** Every member with a score or VIP. VIPs missing from this list count as having left. */
  candidates: readonly Candidate[];
  currentVips: readonly CurrentVip[];
  pinned: ReadonlySet<string>;
  config: ReshuffleConfig;
}

export type AddReason = { kind: 'ranked'; rank: number; score: number } | { kind: 'pinned' };

export type RemoveReason =
  | { kind: 'ineligible'; eligibility: Exclude<Eligibility, 'eligible'> }
  | { kind: 'inactive'; days: number }
  | { kind: 'dropped'; rank: number | null };

export interface Change<R> {
  userId: string;
  /** Rank among eligible members, or null if not eligible. */
  rank: number | null;
  score: number;
  reason: R;
}

export interface ReshuffleResult {
  /** Best rank first (pinned additions without a rank last). */
  added: Change<AddReason>[];
  /** Worst rank first (unranked first). */
  removed: Change<RemoveReason>[];
  /** VIPs after the reshuffle, by user ID. */
  finalVips: string[];
  /** Eligible members, best first. Index + 1 = rank. */
  ranked: Candidate[];
}

/**
 * Ranking with the SPEC §4 tie-breakers: higher score, then current VIPs before
 * non-VIPs, then more active days, then higher last-day score, then smaller user ID.
 */
export function rankCandidates(candidates: readonly Candidate[], currentVips: ReadonlySet<string>): Candidate[] {
  return candidates
    .filter((c) => c.eligibility === 'eligible')
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(currentVips.has(b.userId)) - Number(currentVips.has(a.userId)) ||
        b.activeDays - a.activeDays ||
        b.lastDayScore - a.lastDayScore ||
        compareUserIds(a.userId, b.userId),
    );
}

/** No counted activity on any of the last `days` complete server-days. */
export function isInactive(c: Pick<Candidate, 'lastActiveDay'>, today: string, days: number): boolean {
  return c.lastActiveDay === null || c.lastActiveDay < addServerDays(today, -days);
}

export function computeReshuffle({ today, candidates, currentVips, pinned, config }: ReshuffleInput): ReshuffleResult {
  const vipIds = new Set(currentVips.map((v) => v.userId));
  const byId = new Map(candidates.map((c) => [c.userId, c]));
  const ranked = rankCandidates(candidates, vipIds);
  const rankOf = new Map(ranked.map((c, i) => [c.userId, i + 1]));

  const kept: string[] = [];
  const removed: Change<RemoveReason>[] = [];
  const remove = (userId: string, reason: RemoveReason) =>
    removed.push({ userId, rank: rankOf.get(userId) ?? null, score: byId.get(userId)?.score ?? 0, reason });

  for (const vip of currentVips) {
    const c = byId.get(vip.userId);
    const eligibility = c?.eligibility ?? 'left';
    // Pinned VIPs keep their slot unless they leave the server (step 4).
    if (eligibility === 'left') remove(vip.userId, { kind: 'ineligible', eligibility });
    else if (pinned.has(vip.userId)) kept.push(vip.userId);
    // Step 2: forced removals.
    else if (eligibility !== 'eligible') remove(vip.userId, { kind: 'ineligible', eligibility });
    else if (isInactive(c!, today, config.inactivityDays)) remove(vip.userId, { kind: 'inactive', days: config.inactivityDays });
    // Step 3: rank removals, only below the buffer and after the minimum hold.
    else if ((rankOf.get(vip.userId) ?? Infinity) > config.slots + config.buffer && serverDaysBetween(vip.since, today) >= config.minHoldDays) {
      remove(vip.userId, { kind: 'dropped', rank: rankOf.get(vip.userId) ?? null });
    } else kept.push(vip.userId);
  }

  const added: Change<AddReason>[] = [];
  // Pinned members who aren't VIP yet always get a slot.
  for (const userId of [...pinned].sort(compareUserIds)) {
    const c = byId.get(userId);
    if (vipIds.has(userId) || !c || c.eligibility === 'left' || c.eligibility === 'bot') continue;
    added.push({ userId, rank: rankOf.get(userId) ?? null, score: c.score, reason: { kind: 'pinned' } });
  }

  // Step 5: fill open slots. Never removes anyone to make room when pins push the
  // count over `slots`; it just doesn't fill until there's space.
  let open = config.slots - kept.length - added.length;
  const removedIds = new Set(removed.map((r) => r.userId));
  for (const c of ranked) {
    if (open <= 0) break;
    if (vipIds.has(c.userId) || removedIds.has(c.userId) || added.some((a) => a.userId === c.userId)) continue;
    if (c.score < config.minScore || isInactive(c, today, config.inactivityDays)) continue;
    const rank = rankOf.get(c.userId)!;
    added.push({ userId: c.userId, rank, score: c.score, reason: { kind: 'ranked', rank, score: c.score } });
    open--;
  }

  added.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || compareUserIds(a.userId, b.userId));
  removed.sort((a, b) => (b.rank ?? Infinity) - (a.rank ?? Infinity) || compareUserIds(a.userId, b.userId));
  const finalVips = [...kept, ...added.map((a) => a.userId)].sort(compareUserIds);
  return { added, removed, finalVips, ranked };
}

export type AnnouncementLine =
  | { kind: 'replaced'; added: string; removed: string }
  | { kind: 'filled'; added: string }
  | { kind: 'left'; removed: string };

/**
 * Pairs by rank (SPEC §4 "Announcement"): the highest new VIP replaces the
 * lowest-ranked removed VIP, and so on. Extra additions fill open slots; extra
 * removals are listed on their own.
 */
export function pairAnnouncements(added: readonly Change<AddReason>[], removed: readonly Change<RemoveReason>[]): AnnouncementLine[] {
  const lines: AnnouncementLine[] = [];
  for (let i = 0; i < Math.max(added.length, removed.length); i++) {
    const a = added[i];
    const r = removed[i];
    if (a && r) lines.push({ kind: 'replaced', added: a.userId, removed: r.userId });
    else if (a) lines.push({ kind: 'filled', added: a.userId });
    else if (r) lines.push({ kind: 'left', removed: r.userId });
  }
  return lines;
}

export function describeAdd(r: AddReason): string {
  return r.kind === 'pinned' ? 'pinned' : `ranked #${r.rank} (score ${formatScore(r.score)})`;
}

const INELIGIBLE_TEXT: Record<Exclude<Eligibility, 'eligible'>, string> = {
  left: 'left the server',
  bot: 'is a bot',
  staff: 'has a staff role',
  'timed-out': 'timed out',
  blocked: 'blocked from VIP',
};

export function describeRemove(r: RemoveReason): string {
  if (r.kind === 'ineligible') return INELIGIBLE_TEXT[r.eligibility];
  if (r.kind === 'inactive') return `inactive ${r.days} days`;
  return r.rank === null ? 'dropped out of the ranking' : `dropped to #${r.rank}`;
}

export function formatScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Warm-up (owner-approved): scheduled reshuffles wait until the bot has a full
 * score window of activity, so the first VIPs aren't picked from a day or two of
 * data. `firstDay` is the earliest server-day with any activity saved.
 */
export function warmupDaysLeft(firstDay: string | null, today: string, windowDays: number, daysBetween: (a: string, b: string) => number): number {
  const tracked = firstDay ? daysBetween(firstDay, today) : 0;
  return Math.max(0, windowDays - tracked);
}
