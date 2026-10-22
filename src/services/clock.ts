// The bot's clock for scheduling. CLOCK_OFFSET_MINUTES shifts it for testing the
// day boundary on a test server (PHASES.md Phase 4); it's 0 in production.
export interface Clock {
  now(): Date;
  readonly offsetMinutes: number;
}

export function createClock(offsetMinutes = 0): Clock {
  return { offsetMinutes, now: () => new Date(Date.now() + offsetMinutes * 60_000) };
}
