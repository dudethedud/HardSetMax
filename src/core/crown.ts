// Crown of the week and the Crown holder's custom role (SPEC §6). Pure.
import type { ReshuffleResult } from './reshuffle.js';
import { parseHexColour, formatHexColour } from './vipRules.js';

/** The highest-ranked member of the new VIP list, or null if there are no ranked VIPs. */
export function pickCrown(result: Pick<ReshuffleResult, 'ranked' | 'finalVips'>): string | null {
  const vips = new Set(result.finalVips);
  return result.ranked.find((c) => vips.has(c.userId))?.userId ?? null;
}

// Common lookalikes (owner-approved), so "M0der@tor" counts as "moderator".
const LOOKALIKES: Record<string, string> = { '0': 'o', '1': 'i', l: 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', $: 's', '7': 't' };

/** Lowercased, lookalikes mapped to letters, everything but letters/digits removed. */
export function normalizeRoleName(name: string): string {
  return [...name.toLowerCase()]
    .map((ch) => LOOKALIKES[ch] ?? ch)
    .filter((ch) => /[\p{L}\p{N}]/u.test(ch))
    .join('');
}

/** Darker than 50 on a 0–255 brightness scale: unreadable on dark mode (owner-approved). */
export function isNearBlack(colour: number): boolean {
  const r = (colour >> 16) & 255;
  const g = (colour >> 8) & 255;
  const b = colour & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 50;
}

const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|‍|️|⃣)+$/u;

export interface CustomRoleInput {
  name: string;
  hex: string;
  emoji: string;
}

export interface CustomRoleContext {
  /** Names of every role in the server except this member's own custom role. */
  otherRoleNames: readonly string[];
  staffRoleNames: readonly string[];
  blockedWords: readonly string[];
  /** Boost level 2+ allows role icons. */
  roleIconsAllowed: boolean;
  /** True if they already have a custom role (this would be an edit). */
  isEdit: boolean;
  editsUsedThisWeek: number;
  maxEditsPerWeek: number;
}

export interface CustomRoleRequest {
  name: string;
  /** "#RRGGBB" */
  hex: string;
  emoji: string | null;
  /** They gave an emoji, but the server can't show role icons. */
  emojiIgnored: boolean;
}

export type CustomRoleCheck = { ok: true; value: CustomRoleRequest } | { ok: false; errors: string[] };

export function checkCustomRole(input: CustomRoleInput, ctx: CustomRoleContext): CustomRoleCheck {
  const errors: string[] = [];
  const name = input.name.replace(/\s+/g, ' ').trim();
  const norm = normalizeRoleName(name);

  if (ctx.isEdit && ctx.editsUsedThisWeek >= ctx.maxEditsPerWeek) {
    errors.push(`You've used all ${ctx.maxEditsPerWeek} edits for this Crown week.`);
  }
  if ([...name].length < 2 || [...name].length > 32) errors.push('Name must be 2–32 characters.');
  else if (norm.length === 0) errors.push('Name needs at least one letter or number.');
  if (norm && ctx.blockedWords.some((w) => normalizeRoleName(w) && norm.includes(normalizeRoleName(w)))) {
    errors.push("Name contains a word that isn't allowed.");
  }
  if (norm && ctx.otherRoleNames.some((r) => normalizeRoleName(r) === norm)) errors.push('Name is the same as (or imitates) an existing role.');
  else if (norm && ctx.staffRoleNames.some((r) => normalizeRoleName(r).length >= 3 && norm.includes(normalizeRoleName(r)))) {
    errors.push('Name looks like a staff role.');
  }

  const colour = parseHexColour(input.hex);
  if (colour === null) errors.push('Colour must be a hex code like #FF8800.');
  else if (isNearBlack(colour)) errors.push("That colour is too dark to read on dark mode. Pick a brighter one.");

  const emojiRaw = input.emoji.trim();
  if (emojiRaw && (!EMOJI_RE.test(emojiRaw) || [...emojiRaw].length > 10)) errors.push('Emoji must be a single standard emoji (like 🔥), not a custom one.');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      hex: formatHexColour(colour!),
      emoji: emojiRaw && ctx.roleIconsAllowed ? emojiRaw : null,
      emojiIgnored: !!emojiRaw && !ctx.roleIconsAllowed,
    },
  };
}

export const MAX_CUSTOM_ROLE_EDITS = 3;
