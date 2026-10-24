// Whether a message counts toward activity (SPEC §2 "What counts" and "Spam
// filter"). Pure: the caller keeps each user's SpamState in memory between calls.
import { distinctAlnumCount, fingerprint, isEmojiOrStickerOnly, isOnlyMentionsLinksEmoji, similarity, trimmedLength } from './messageText.js';

export interface MessageRulesConfig {
  cooldownSec: number;
  minLength: number;
  repeatHistory: number;
  repeatMinutes: number;
  repeatSimilarity: number;
  minDistinctChars: number;
  burstCount: number;
  burstSeconds: number;
  burstMuteMinutes: number;
}

export interface SpamState {
  /** Fingerprints of the user's recent messages, newest last. */
  recent: { fp: ReadonlySet<number>; at: number }[];
  /** Times of the user's recent messages, for the burst check. */
  burst: number[];
  /** Nothing counts until this time (ms) after a burst. */
  mutedUntil: number;
  /** When a message last counted, for the cooldown. */
  lastCountedAt: number | null;
}

export type MessageOutcome =
  | 'counted'
  /** Not counted, not spam: short, emoji/sticker only, or within the cooldown. */
  | 'too-short'
  | 'emoji-only'
  | 'cooldown'
  /** A command for another bot, like !rank or .work: not chat. */
  | 'bot-command'
  /** Flagged by the spam filter; counted in `filteredMessages`. */
  | 'filtered-burst'
  | 'filtered-low-effort'
  | 'filtered-repeat';

/** Prefixes other bots use for text commands. */
const COMMAND_RE = /^[!?.$%+~;,-][a-z]/i;

/** "!rank", "?help", ".work", "-play song": a command for another bot. */
export function isBotCommand(text: string): boolean {
  return COMMAND_RE.test(text.trimStart());
}

export function isFiltered(outcome: MessageOutcome): boolean {
  return outcome.startsWith('filtered-');
}

export function emptySpamState(): SpamState {
  return { recent: [], burst: [], mutedUntil: 0, lastCountedAt: null };
}

export interface MessageInput {
  text: string;
  hasStickers: boolean;
  /** Message time, ms since epoch. */
  at: number;
}

/**
 * Checks, in order: burst (every message counts toward it), length,
 * emoji/sticker only, low effort, repeat, cooldown. Messages from bots, in DMs or
 * in ignored channels never get here.
 */
export function evaluateMessage(
  prev: SpamState,
  { text, hasStickers, at }: MessageInput,
  cfg: MessageRulesConfig,
): { state: SpamState; outcome: MessageOutcome } {
  const burst = [...prev.burst.filter((t) => t > at - cfg.burstSeconds * 1000), at];
  let mutedUntil = prev.mutedUntil;
  if (burst.length >= cfg.burstCount) mutedUntil = Math.max(mutedUntil, at + cfg.burstMuteMinutes * 60_000);

  const fresh = prev.recent.filter((r) => r.at > at - cfg.repeatMinutes * 60_000);
  const state: SpamState = { recent: fresh, burst, mutedUntil, lastCountedAt: prev.lastCountedAt };
  const done = (outcome: MessageOutcome, s: SpamState = state) => ({ state: s, outcome });

  if (at < mutedUntil) return done('filtered-burst');
  if (isBotCommand(text)) return done('bot-command');
  if (trimmedLength(text) < cfg.minLength && !hasStickers) return done('too-short');
  if (isEmojiOrStickerOnly(text, hasStickers)) return done('emoji-only');
  if (trimmedLength(text) < cfg.minLength) return done('too-short');
  if (isOnlyMentionsLinksEmoji(text) || distinctAlnumCount(text) < cfg.minDistinctChars) return done('filtered-low-effort');

  const fp = fingerprint(text);
  const isRepeat = fresh.some((r) => similarity(r.fp, fp) >= cfg.repeatSimilarity);
  const recent = [...fresh, { fp, at }].slice(-cfg.repeatHistory);
  const withFp = { ...state, recent };
  if (isRepeat) return done('filtered-repeat', withFp);

  if (prev.lastCountedAt !== null && at - prev.lastCountedAt < cfg.cooldownSec * 1000) return done('cooldown', withFp);
  return done('counted', { ...withFp, lastCountedAt: at });
}

/** True when a user's state holds nothing that can still affect a future message. */
export function isSpamStateIdle(s: SpamState, now: number, cfg: MessageRulesConfig): boolean {
  return (
    now >= s.mutedUntil &&
    s.burst.every((t) => t <= now - cfg.burstSeconds * 1000) &&
    s.recent.every((r) => r.at <= now - cfg.repeatMinutes * 60_000) &&
    (s.lastCountedAt === null || s.lastCountedAt <= now - cfg.cooldownSec * 1000)
  );
}
