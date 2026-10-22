// Scores and ranking (SPEC §2 "Score", §4 tie-breakers).

export interface DayActivity {
  userId: string;
  serverDay: string;
  weightedMessages: number;
  voiceMinutes: number;
}

export interface Adjustment {
  userId: string;
  serverDay: string;
  amount: number;
}

export interface MemberScore {
  userId: string;
  score: number;
  /** Days in the window with any counted activity (adjustments don't count). */
  activeDays: number;
  /** Score on the most recent day of the window. */
  lastDayScore: number;
}

export function dayScore(day: Pick<DayActivity, 'weightedMessages' | 'voiceMinutes'>, voiceWeight: number): number {
  return day.weightedMessages + day.voiceMinutes * voiceWeight;
}

/**
 * Scores over `windowDays` (server-day keys, oldest first). Rows outside the window
 * are ignored.
 */
export function computeScores(
  days: readonly DayActivity[],
  adjustments: readonly Adjustment[],
  windowDays: readonly string[],
  voiceWeight: number,
): Map<string, MemberScore> {
  const inWindow = new Set(windowDays);
  const lastDay = windowDays.at(-1);
  const scores = new Map<string, MemberScore>();
  const get = (userId: string) => {
    let s = scores.get(userId);
    if (!s) scores.set(userId, (s = { userId, score: 0, activeDays: 0, lastDayScore: 0 }));
    return s;
  };

  for (const d of days) {
    if (!inWindow.has(d.serverDay)) continue;
    const s = get(d.userId);
    const points = dayScore(d, voiceWeight);
    s.score += points;
    if (d.weightedMessages > 0 || d.voiceMinutes > 0) s.activeDays++;
    if (d.serverDay === lastDay) s.lastDayScore += points;
  }
  for (const a of adjustments) {
    if (!inWindow.has(a.serverDay)) continue;
    const s = get(a.userId);
    s.score += a.amount;
    if (a.serverDay === lastDay) s.lastDayScore += a.amount;
  }
  return scores;
}

/** Smaller Discord ID first; IDs are numeric strings, so compare as numbers. */
export function compareUserIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Highest score first. Ties: more active days, then higher score on the most
 * recent day, then smaller user ID, so the order is always the same for the same
 * data. (The reshuffle adds "current VIPs first" ahead of these in Phase 3.)
 */
export function compareScores(a: MemberScore, b: MemberScore): number {
  return b.score - a.score || b.activeDays - a.activeDays || b.lastDayScore - a.lastDayScore || compareUserIds(a.userId, b.userId);
}

export function rankScores(scores: Iterable<MemberScore>): MemberScore[] {
  return [...scores].sort(compareScores);
}
