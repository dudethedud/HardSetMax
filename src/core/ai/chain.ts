// The AI provider chain (SPEC §9a "Cost and limits"). Pure.
import { calendarDayIn, nextMidnightIn } from '../serverDay.js';

export interface ProviderState {
  name: string;
  order: number;
  enabled: boolean;
  dailyCap: number;
  resetTimezone: string;
  cooldownUntil: Date | null;
  /** Whether its API key is set. */
  hasKey: boolean;
}

/**
 * Providers to try for this request, in order: enabled, keyed, under cap, not cooling down.
 * `reserve` (0–1) is the share of each cap kept back for others (VIPs): this request can't use it.
 */
export function usableProviders<P extends ProviderState>(providers: readonly P[], usedToday: (p: P) => number, now: Date, reserve = 0): P[] {
  return [...providers]
    .sort((a, b) => a.order - b.order)
    .filter((p) => p.enabled && p.hasKey && usedToday(p) < Math.ceil(p.dailyCap * (1 - reserve)) && (!p.cooldownUntil || p.cooldownUntil <= now));
}

/** The provider's own day, for counting usage against its daily cap. */
export function providerDay(p: Pick<ProviderState, 'resetTimezone'>, now: Date): string {
  return calendarDayIn(now, p.resetTimezone);
}

export const COOLDOWN_MS = 5 * 60_000;

export interface Failure {
  /** HTTP status, or null for a network error/timeout. */
  status: number | null;
  /** Response body (may mention which limit was hit). */
  body: string;
}

/** True when a 429 says the provider's daily allowance is used up. */
export function isDailyLimit(f: Failure): boolean {
  return f.status === 429 && /(per[ _-]?day|daily|\bRPD\b|\bTPD\b|requests per day|tokens per day|neurons)/i.test(f.body);
}

/** How long to skip a provider after it failed. */
export function cooldownAfter(f: Failure, p: Pick<ProviderState, 'resetTimezone'>, now: Date): Date {
  return isDailyLimit(f) ? nextMidnightIn(now, p.resetTimezone) : new Date(now.getTime() + COOLDOWN_MS);
}
