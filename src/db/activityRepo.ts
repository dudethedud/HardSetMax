import type { RuntimeConfig } from '../config/configStore.js';
import { computeScores, rankScores, type MemberScore } from '../core/scoring.js';
import { addServerDays, completedServerDays, serverDayAt, serverDaysBetween, weekStartOf } from '../core/serverDay.js';
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

/** Scores over a list of server-days, with the same rules as VIP (weights, voice, adjustments). */
async function scoresFor(db: Db, config: RuntimeConfig, days: string[]): Promise<MemberScore[]> {
  const [activity, adjustments] = await Promise.all([
    db.activityDay.findMany({ where: { serverDay: { in: days } } }),
    db.activityAdjustment.findMany({ where: { serverDay: { in: days } } }),
  ]);
  return rankScores(computeScores(activity, adjustments, days, config.guild.voiceWeight).values());
}

export interface WeeklyStandings {
  /** This week so far: Monday to today (everyone started from 0 on Monday). */
  /** `restarted`: an admin ran /vip board-reset this week, so it counts from that moment. */
  thisWeek: { from: string; restarted: boolean; ranked: MemberScore[] };
  /** Last week's final totals, Monday to Sunday. */
  lastWeek: { from: string; to: string; ranked: MemberScore[] };
}

/**
 * Weekly points for the VIP board (owner-approved): they count from 0 each Monday
 * and last week's totals stay on show. Display only: VIP still uses the rolling window.
 * After a /vip board-reset this week counts from that moment (weeklyFrom minus the
 * points members already had that day).
 */
export async function loadWeeklyStandings(db: Db, config: RuntimeConfig, now = new Date()): Promise<WeeklyStandings> {
  const today = serverDayAt(now, config.boundary).key;
  const monday = weekStartOf(today);
  const lastFrom = addServerDays(monday, -7);
  const reset = config.guild.weeklyFrom && config.guild.weeklyFrom >= monday && config.guild.weeklyFrom <= today ? config.guild.weeklyFrom : null;
  const from = reset ?? monday;
  const span = (start: string, count: number) => Array.from({ length: count }, (_, i) => addServerDays(start, i));
  const [raw, lastWeek, baselines] = await Promise.all([
    scoresFor(db, config, span(from, serverDaysBetween(from, today) + 1)),
    scoresFor(db, config, span(lastFrom, 7)),
    reset ? db.weeklyBaseline.findMany() : Promise.resolve([]),
  ]);
  const base = new Map(baselines.map((b) => [b.userId, b.score]));
  const thisWeek = reset ? rankScores(raw.map((s) => ({ ...s, score: s.score - (base.get(s.userId) ?? 0) })).filter((s) => s.score > 0)) : raw;
  return { thisWeek: { from, restarted: !!reset, ranked: thisWeek }, lastWeek: { from: lastFrom, to: addServerDays(monday, -1), ranked: lastWeek } };
}

/**
 * /vip board-reset: this week's board starts everyone at 0 from now. Nothing is
 * deleted and VIP scores don't change. Call after flushing the activity buffer.
 */
export async function resetWeeklyBoard(db: Db, config: RuntimeConfig, guildId: string, actorId: string, now = new Date()): Promise<void> {
  const today = serverDayAt(now, config.boundary).key;
  const sofar = await scoresFor(db, config, [today]);
  await db.$transaction([
    db.weeklyBaseline.deleteMany(),
    db.weeklyBaseline.createMany({ data: sofar.map((s) => ({ userId: s.userId, score: s.score })) }),
    db.guildConfig.update({ where: { guildId }, data: { weeklyFrom: today } }),
    db.auditLog.create({ data: { action: 'board.reset', actorId, data: { from: today } } }),
  ]);
}

export function todayKey(config: RuntimeConfig, now = new Date()): string {
  return serverDayAt(now, config.boundary).key;
}

export async function namesFor(db: Db, userIds: string[]): Promise<Map<string, string>> {
  const rows = await db.memberName.findMany({ where: { userId: { in: userIds } } });
  return new Map(rows.map((r) => [r.userId, r.name]));
}
