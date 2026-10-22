// Data pruning (PHASES Phase 10, SPEC §2 "Buckets older than 60 days are pruned").
// Deletes day-by-day activity and short-lived records older than 60 days, once a
// day. Kept forever (owner-approved): the audit log, VIP stints, badges and Crown
// history, which are small and needed for badges and history.
import { addServerDays, serverDayAt } from '../core/serverDay.js';
import type { ConfigStore } from '../config/configStore.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import { claimJob, completeJob, failJob } from './jobs.js';

export const PRUNE_JOB = 'prune';
export const KEEP_DAYS = 60;

export async function pruneOldData(db: Db, config: ConfigStore, now: Date): Promise<Record<string, number>> {
  const today = serverDayAt(now, config.current.boundary).key;
  const oldestDay = addServerDays(today, -KEEP_DAYS);
  const oldest = new Date(now.getTime() - KEEP_DAYS * 86_400_000);
  const counts = await db.$transaction([
    db.activityDay.deleteMany({ where: { serverDay: { lt: oldestDay } } }),
    db.activityAdjustment.deleteMany({ where: { serverDay: { lt: oldestDay } } }),
    db.pollPost.deleteMany({ where: { serverDay: { lt: oldestDay } } }),
    db.voiceSession.deleteMany({ where: { endedAt: { lt: oldest } } }),
    // `timeout-days` is at most 60, so older timeouts can't affect eligibility.
    db.timeoutEvent.deleteMany({ where: { endedAt: { lt: oldest } } }),
    db.aiUsage.deleteMany({ where: { providerDay: { lt: oldest.toISOString().slice(0, 10) } } }),
    db.modalDraft.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  const [activityDays, adjustments, pollPosts, voiceSessions, timeouts, aiUsage, drafts] = counts.map((c) => c.count);
  return { activityDays: activityDays!, adjustments: adjustments!, pollPosts: pollPosts!, voiceSessions: voiceSessions!, timeouts: timeouts!, aiUsage: aiUsage!, drafts: drafts! };
}

export async function runPruneJob(db: Db, config: ConfigStore, clock: Clock, log: Logger, period: string): Promise<void> {
  const now = clock.now();
  if (!(await claimJob(db, PRUNE_JOB, period, now))) return;
  try {
    const deleted = await pruneOldData(db, config, now);
    await db.$transaction((tx) => completeJob(tx, PRUNE_JOB, period, deleted, now));
    log.info({ deleted }, 'old data pruned');
  } catch (err) {
    await failJob(db, PRUNE_JOB, period, err instanceof Error ? err.message : String(err), clock.now());
    throw err;
  }
}
