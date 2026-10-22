// Daily jobs at the server-day boundary (SPEC §2, §11). Every 15 s it checks
// whether the previous server-day's run exists; if not, it runs now. That one check
// covers the normal run at the boundary, catch-up after downtime (only the most
// recent missed day), clock changes and DST.
import type { ConfigStore } from '../config/configStore.js';
import { addServerDays, serverDayAt } from '../core/serverDay.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';

/** Runs the job for `period` (the server-day that just closed). Must claim it itself. */
export type DailyJob = (period: string) => Promise<unknown>;

const CHECK_MS = 15_000;

export class DailyScheduler {
  #jobs = new Map<string, DailyJob>();
  #running = new Set<string>();
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigStore,
    private readonly clock: Clock,
    private readonly log: Logger,
    /** False in database-down mode: jobs wait (and catch up) until it's back. */
    private readonly active: () => boolean = () => true,
  ) {}

  register(name: string, job: DailyJob): void {
    this.#jobs.set(name, job);
  }

  /** The server-day whose run is due now: the one that most recently closed. */
  duePeriod(now = this.clock.now()): string {
    return addServerDays(serverDayAt(now, this.config.current.boundary).key, -1);
  }

  start(): void {
    void this.check();
    this.#timer = setInterval(() => void this.check(), CHECK_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async check(): Promise<void> {
    if (!this.active()) return;
    const period = this.duePeriod();
    for (const [name, job] of this.#jobs) {
      if (this.#running.has(name)) continue;
      this.#running.add(name);
      try {
        await job(period);
      } catch (err) {
        this.log.error({ err, job: name, period }, 'scheduled job failed; will retry');
      } finally {
        this.#running.delete(name);
      }
    }
  }
}
