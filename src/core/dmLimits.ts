// Limits for every DM the bot sends (pure), shared by check-ins and colour-removal
// DMs (docs/SPEC.md §10), so Discord never sees a burst of DMs.

/** At least this long between any two DMs. */
export const DM_MIN_GAP_MS = 3000;
/** At most this many DMs in any hour; over it, DMs are skipped (not queued for later). */
export const DM_HOURLY_CAP = 30;
/** A rate limit on DMs pauses all DMs this long. */
export const DM_PAUSE_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;

export type DmSlot = { kind: 'go' } | { kind: 'wait'; ms: number } | { kind: 'held'; reason: 'paused' | 'hourly limit' };

/** Whether a DM can go now, after a short wait, or not at all. `sent` = times of recent DMs (ms). */
export function dmSlot(sent: readonly number[], now: number, pausedUntil: number): DmSlot {
  if (now < pausedUntil) return { kind: 'held', reason: 'paused' };
  const lastHour = sent.filter((t) => now - t < HOUR_MS);
  if (lastHour.length >= DM_HOURLY_CAP) return { kind: 'held', reason: 'hourly limit' };
  const last = lastHour.length ? Math.max(...lastHour) : -Infinity;
  const gap = now - last;
  return gap < DM_MIN_GAP_MS ? { kind: 'wait', ms: DM_MIN_GAP_MS - gap } : { kind: 'go' };
}

/** Keeps only the DM times that still matter for the hourly limit. */
export function recentDms(sent: readonly number[], now: number): number[] {
  return sent.filter((t) => now - t < HOUR_MS);
}

// ---- Mass-removal brake (colours) ----

/** More than this many reppers losing their colour within the window trips the brake. */
export const BRAKE_MAX = 10;
export const BRAKE_WINDOW_MS = 5 * 60_000;
/** Removals stay paused until this long after the last such loss. */
export const BRAKE_HOLD_MS = 15 * 60_000;

export interface BrakeState {
  /** Times (ms) members would have lost their colour, within the window. */
  losses: number[];
  /** Live removals are paused until then (ms), or null. */
  until: number | null;
}

export const NO_BRAKE: BrakeState = { losses: [], until: null };

export function isBraked(s: BrakeState, now: number): boolean {
  return s.until !== null && now < s.until;
}

/**
 * A member is about to lose their colour live (their rep role went). Over 10 in 5 minutes
 * looks like another bot glitching (stripping and re-adding rep roles), so the brake
 * goes on; every further loss while it's on keeps it on 15 more minutes.
 */
export function brakeOnLoss(s: BrakeState, now: number): { state: BrakeState; braked: boolean; tripped: boolean } {
  const losses = [...s.losses.filter((t) => now - t < BRAKE_WINDOW_MS), now];
  const wasBraked = isBraked(s, now);
  const until = wasBraked || losses.length > BRAKE_MAX ? now + BRAKE_HOLD_MS : null;
  return { state: { losses, until }, braked: until !== null, tripped: until !== null && !wasBraked };
}
