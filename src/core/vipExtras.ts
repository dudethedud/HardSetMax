// VIP extras (owner-approved): daily treats, the veteran streak, colour requests
// and AI priority. Pure.
import { isNearBlack, normalizeRoleName } from './crown.js';
import { formatHexColour, parseHexColour } from './vipRules.js';

/** Days in a row as VIP before the veteran perks (a second daily shoutout, a board mark). */
export const VETERAN_DAYS = 14;
export const isVeteran = (daysHeld: number): boolean => daysHeld >= VETERAN_DAYS;

/** Share of each AI provider's daily cap kept for VIPs (others get the pre-written replies). */
export const VIP_AI_RESERVE = 0.2;
/** VIPs get this many times the per-person AI reply limit. */
export const VIP_AI_LIMIT_FACTOR = 2;

export interface TreatTarget {
  giverId: string;
  receiverId: string;
  isBot: boolean;
  inServer: boolean;
}

/** Who a VIP can give a treat to. Returns why not, or null. */
export function treatTargetError(t: TreatTarget): string | null {
  if (!t.inServer) return "They're not in the server.";
  if (t.isBot) return "Bots don't eat treats (Carter already has plenty).";
  if (t.giverId === t.receiverId) return 'Treats are for giving! Pick someone else.';
  return null;
}

/** How Carter announces a treat. Fixed lines, no AI. */
export const TREAT_LINES = [
  '*wags tail* good choice!! arf!',
  'can I have one too? :3',
  "that's the good stuff. they deserve it",
  '*sniffs it approvingly*',
  'a treat for a good egg. arf arf!',
  "ooh that's a fancy one",
] as const;

export function treatLine(random: number): string {
  return TREAT_LINES[Math.min(TREAT_LINES.length - 1, Math.floor(random * TREAT_LINES.length))]!;
}

export interface ColourRequestInput {
  name: string;
  hex: string;
  hex2: string;
}

export type ColourRequestCheck = { ok: true; value: { name: string; hex: string; hex2: string } } | { ok: false; errors: string[] };

/** A VIP's suggestion for a new VIP gradient, checked before staff see it. */
export function checkColourRequest(input: ColourRequestInput, ctx: { existingNames: readonly string[]; blockedWords: readonly string[] }): ColourRequestCheck {
  const errors: string[] = [];
  const name = input.name.replace(/\s+/g, ' ').trim();
  if ([...name].length < 2 || [...name].length > 24) errors.push('The name must be 2–24 characters.');
  const norm = normalizeRoleName(name);
  if (ctx.existingNames.some((n) => normalizeRoleName(n) === norm)) errors.push('There’s already a colour with that name.');
  const blocked = ctx.blockedWords.map(normalizeRoleName).filter(Boolean);
  if (norm && blocked.some((b) => norm.includes(b))) errors.push("The name contains a word that isn't allowed.");
  const colours = [input.hex, input.hex2].map((h) => parseHexColour(h.trim()));
  colours.forEach((c, i) => {
    const which = i === 0 ? 'First' : 'Second';
    if (c === null) errors.push(`${which} colour must be a hex code like #FF8800.`);
    else if (isNearBlack(c)) errors.push(`${which} colour is too dark to read on dark mode.`);
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { name, hex: formatHexColour(colours[0]!), hex2: formatHexColour(colours[1]!) } };
}
