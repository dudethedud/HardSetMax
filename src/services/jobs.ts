// Scheduled jobs (SPEC §11): each run is a JobRun row with a unique (job, period),
// claimed under a Postgres advisory lock, so a job runs exactly once per period
// even if two copies of the bot overlap. A job that finds its period unclaimed
// after its time has passed runs immediately (catch-up).
import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../db/prisma.js';

type Tx = Prisma.TransactionClient;

/** A "running" claim older than this is treated as a crashed run. */
const STALE_RUNNING_MS = 10 * 60_000;
/** Wait this long before retrying a failed run. */
const RETRY_FAILED_MS = 5 * 60_000;

/** Claims (job, period) for this copy. False if it already ran, is running, or failed just now. */
export async function claimJob(db: Db, job: string, period: string, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`job:${job}`}))`;
    const row = await tx.jobRun.findUnique({ where: { job_period: { job, period } } });
    if (row?.status === 'succeeded') return false;
    if (row?.status === 'running' && now.getTime() - row.startedAt.getTime() < STALE_RUNNING_MS) return false;
    if (row?.status === 'failed' && row.finishedAt && now.getTime() - row.finishedAt.getTime() < RETRY_FAILED_MS) return false;
    await tx.jobRun.upsert({
      where: { job_period: { job, period } },
      create: { job, period, status: 'running', startedAt: now },
      update: { status: 'running', startedAt: now, finishedAt: null },
    });
    return true;
  });
}

/** Marks the run done. Call inside the transaction that saves the job's results. */
export function completeJob(tx: Tx, job: string, period: string, detail: Prisma.InputJsonValue, now: Date) {
  return tx.jobRun.update({ where: { job_period: { job, period } }, data: { status: 'succeeded', finishedAt: now, detail } });
}

export async function failJob(db: Db, job: string, period: string, error: string, now: Date): Promise<void> {
  await db.jobRun.update({ where: { job_period: { job, period } }, data: { status: 'failed', finishedAt: now, detail: { error } } });
}
