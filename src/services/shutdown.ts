// Graceful shutdown (SPEC §11). Railway sends SIGTERM on redeploy: flush pending
// writes, disconnect from Discord, close the DB, and only then release
// gateway-leader so the new copy can connect.
import type { Logger } from '../logger.js';

export interface ShutdownStep {
  name: string;
  run: () => Promise<void> | void;
}

export interface Shutdown {
  /** Steps run in the order added. Later phases add their flush steps first. */
  add(step: ShutdownStep): void;
  run(reason: string, exitCode?: number): Promise<void>;
}

export function createShutdown(log: Logger, { timeoutMs = 15_000, exit = (code: number) => process.exit(code) } = {}): Shutdown {
  const steps: ShutdownStep[] = [];
  let running: Promise<void> | null = null;

  return {
    add(step) {
      steps.push(step);
    },
    run(reason, exitCode = 0) {
      running ??= (async () => {
        log.info({ reason }, 'shutting down');
        const timer = setTimeout(() => {
          log.error('shutdown timed out; forcing exit');
          exit(1);
        }, timeoutMs);
        timer.unref();
        let code = exitCode;
        for (const step of steps) {
          try {
            await step.run();
            log.info(`shutdown: ${step.name} done`);
          } catch (err) {
            code = 1;
            log.error({ err }, `shutdown: ${step.name} failed`);
          }
        }
        clearTimeout(timer);
        exit(code);
      })();
      return running;
    },
  };
}
