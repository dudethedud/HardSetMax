import type { RuntimeConfig } from '../config/configStore.js';
import { computeScores, rankScores, type MemberScore } from '../core/scoring.js';
import { completedServerDays, serverDayAt } from '../core/serverDay.js';
import type { Db } from './prisma.js';

export interface Standings {
  /** Server-day keys in the score window, oldest first. */
  window: string[];
  /** Everyone with a score in the window, best first. */
  ranked: MemberScore[];
}

/** Current standings: the last `windowDays` complete server-days (SPEC §2). */
export async function loadStandings(db: Db, config: RuntimeConfig, now = new Date()): Promise<Standings> {
  const window = completedServerDays(now, config.guild.windowDays, config.boundary);
  const [days, adjustments] = await Promise.all([
    db.activityDay.findMany({ where: { serverDay: { in: window } } }),
    db.activityAdjustment.findMany({ where: { serverDay: { in: window } } }),
  ]);
  return { window, ranked: rankScores(computeScores(days, adjustments, window, config.guild.voiceWeight).values()) };
}

export function todayKey(config: RuntimeConfig, now = new Date()): string {
  return serverDayAt(now, config.boundary).key;
}

export async function namesFor(db: Db, userIds: string[]): Promise<Map<string, string>> {
  const rows = await db.memberName.findMany({ where: { userId: { in: userIds } } });
  return new Map(rows.map((r) => [r.userId, r.name]));
}
