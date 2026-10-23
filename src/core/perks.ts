// VIP and Crown perks: shoutouts, the Crown's decree, titles and nickname. Pure.
import { normalizeRoleName } from './crown.js';

/** The Crown holder's titles, handed out for their week. Cosmetic roles only. */
export const TITLE_SLOTS = [
  { slot: 'champion', name: '🛡️ Champion' },
  { slot: 'advisor', name: '📜 Advisor' },
  { slot: 'jester', name: '🃏 Jester' },
] as const;
export type TitleSlot = (typeof TITLE_SLOTS)[number]['slot'];

export const isTitleSlot = (s: string): s is TitleSlot => TITLE_SLOTS.some((t) => t.slot === s);

export const CROWN_NICK_PREFIX = '👑 ';
/** Discord's nickname limit, in characters. */
const NICK_MAX = 32;

/** "👑 Name", cut to fit Discord's 32-character nickname limit. */
export function crownNickname(displayName: string): string {
  const room = NICK_MAX - [...CROWN_NICK_PREFIX].length;
  const name = [...displayName.trim()];
  return CROWN_NICK_PREFIX + (name.length > room ? `${name.slice(0, room - 1).join('')}…` : name.join(''));
}

/** The Crown's temporary voice channel name. */
export function crownRoomName(displayName: string): string {
  const name = displayName.replace(/\s+/g, ' ').trim() || 'Crown';
  const short = [...name].length > 24 ? `${[...name].slice(0, 23).join('')}…` : name;
  return `👑 ${short}'s Hall`;
}

export type CleanText = { ok: true; text: string } | { ok: false; error: string };

/**
 * Member-written text the bot posts publicly (shoutouts, decrees). Mentions are
 * removed and @everyone/@here are broken up, on top of the bot sending with no
 * allowed mentions. Each word is checked against the blocked words.
 */
export function cleanPublicText(raw: string, blockedWords: readonly string[], maxLength: number): CleanText {
  const text = raw
    .replace(/<@[!&]?\d+>|<#\d+>/g, '')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const length = [...text].length;
  if (length < 1) return { ok: false, error: 'Write something first.' };
  if (length > maxLength) return { ok: false, error: `Keep it under ${maxLength} characters.` };
  const blocked = blockedWords.map(normalizeRoleName).filter(Boolean);
  const words = text.split(/\s+/).map(normalizeRoleName).filter(Boolean);
  if (words.some((w) => blocked.some((b) => w.includes(b)))) return { ok: false, error: "That contains a word that isn't allowed." };
  return { ok: true, text };
}

export interface TitleTarget {
  targetId: string;
  crownId: string;
  isBot: boolean;
  /** Staff role or Administrator. */
  isStaff: boolean;
  inServer: boolean;
}

/** Who the Crown can give a title to. Returns why not, or null. */
export function titleTargetError(t: TitleTarget): string | null {
  if (!t.inServer) return "They're not in the server.";
  if (t.isBot) return "Bots can't hold titles.";
  if (t.targetId === t.crownId) return "You can't give yourself a title. You already have the Crown!";
  if (t.isStaff) return "Staff can't hold titles.";
  return null;
}

/**
 * The profile card's "where you stand" line. VIPs keep their slot down to rank
 * slots + buffer; everyone else needs to reach rank `slots`.
 */
export function standingLine(scores: readonly number[], rankIndex: number, isVip: boolean, slots: number, buffer: number): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const mine = rankIndex >= 0 ? scores[rankIndex]! : 0;
  if (isVip) {
    const keep = slots + buffer;
    const below = scores[keep];
    if (rankIndex >= 0 && rankIndex < keep) return below === undefined ? '🟢 Safe: nobody is close behind you.' : `🟢 ${fmt(Math.max(0, mine - below))} points ahead of rank #${keep + 1}.`;
    return `🔴 Below rank #${keep}: stay active or you may lose VIP at the next reshuffle.`;
  }
  if (rankIndex >= 0 && rankIndex < slots) return `🟢 You're in the top ${slots}. Keep it up for the next reshuffle!`;
  const target = scores[slots - 1];
  return target === undefined ? `🟢 Fewer than ${slots} members are ranked, so any activity counts.` : `⬆️ ${fmt(Math.max(0, target - mine))} points to reach rank #${slots}.`;
}
