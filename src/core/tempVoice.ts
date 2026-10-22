// Temporary VIP voice channels (SPEC §8). Pure.
import { normalizeRoleName } from './crown.js';

export const EMPTY_GRACE_MS = 60_000;
export const MAX_USER_LIMIT = 99;
/** Discord allows 2 channel renames per 10 minutes. */
export const RENAMES_PER_WINDOW = 2;
export const RENAME_WINDOW_MS = 10 * 60_000;

export interface RoomState {
  humans: number;
  emptySince: Date | null;
  ownerIsVip: boolean;
}

/**
 * Empty for 60 s → delete. If the owner lost VIP, it goes as soon as it's empty.
 * Returns the new emptySince to save (unchanged if nothing changed).
 */
export function roomAction(s: RoomState, now: Date): { delete: boolean; emptySince: Date | null } {
  if (s.humans > 0) return { delete: false, emptySince: null };
  if (!s.ownerIsVip) return { delete: true, emptySince: s.emptySince ?? now };
  const since = s.emptySince ?? now;
  return { delete: now.getTime() - since.getTime() >= EMPTY_GRACE_MS, emptySince: since };
}

export function defaultRoomName(displayName: string): string {
  const name = displayName.replace(/\s+/g, ' ').trim() || 'VIP';
  const short = [...name].length > 24 ? `${[...name].slice(0, 23).join('')}…` : name;
  return `${short}'s room`;
}

export function checkRoomName(raw: string, blockedWords: readonly string[]): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.replace(/\s+/g, ' ').trim();
  const len = [...name].length;
  if (len < 1 || len > 32) return { ok: false, error: 'Name must be 1–32 characters.' };
  const norm = normalizeRoleName(name);
  if (norm && blockedWords.some((w) => normalizeRoleName(w) && norm.includes(normalizeRoleName(w)))) {
    return { ok: false, error: "That name contains a word that isn't allowed." };
  }
  return { ok: true, name };
}

export function parseUserLimit(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_USER_LIMIT ? n : null;
}

/** Renames within the last 10 minutes, if another one is allowed now. */
export function canRename(history: readonly number[], now: number): boolean {
  return history.filter((t) => t > now - RENAME_WINDOW_MS).length < RENAMES_PER_WINDOW;
}
