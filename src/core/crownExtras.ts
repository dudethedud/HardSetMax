// Crown extras (owner-approved): the royal pardon, Carter's mood, the spotlight,
// the theme of the week and the 🌈 speech filter. Pure.

/** Carter's moods. Only these fixed instructions ever reach the AI, never member text. */
export const MOODS = [
  { key: 'hyper', label: 'Extra hyper', emoji: '⚡', prompt: 'This week you are EXTRA hyper: bouncy, excited, lots of arfs and zoomies energy.' },
  { key: 'sleepy', label: 'Sleepy', emoji: '😴', prompt: 'This week you are sleepy: yawning, slow, cosy, a bit drowsy but still sweet.' },
  { key: 'dramatic', label: 'Dramatic', emoji: '🎭', prompt: 'This week you are dramatic: everything is a huge deal, theatrical gasps and big reactions (still kind).' },
  { key: 'royal', label: 'Royal butler', emoji: '🎩', prompt: 'This week you act like a proper royal butler dog serving the Crown: polite, posh words, still casual and cute.' },
  { key: 'pirate', label: 'Pirate pup', emoji: '🏴‍☠️', prompt: 'This week you are a pirate pup: sprinkle in pirate words like "arr" and "matey", still friendly.' },
  { key: 'poet', label: 'Poet', emoji: '🪶', prompt: 'This week you are a poet: now and then your replies rhyme a little. Keep them short.' },
] as const;
export type MoodKey = (typeof MOODS)[number]['key'];
export const moodByKey = (key: string | null | undefined) => MOODS.find((m) => m.key === key) ?? null;

export const SPOTLIGHT_MAX = 80;
export const THEME_MAX = 60;
export const RAINBOW_MINUTES = 10;

export interface PardonTarget {
  targetId: string;
  crownId: string;
  isVip: boolean;
}

/** Who the Crown can pardon. Returns why not, or null. */
export function pardonTargetError(t: PardonTarget): string | null {
  if (t.targetId === t.crownId) return "You're the Crown, you don't need a pardon! Pick another VIP.";
  if (!t.isVip) return 'Only current VIPs can be pardoned.';
  return null;
}

export interface SpeechTarget {
  isBot: boolean;
  isStaff: boolean;
  isOwner: boolean;
  inServer: boolean;
  /** They turned it off for themselves (Titles & perks menu). */
  optedOut?: boolean;
}

/** Who the 🌈 speech filter can be used on. Returns why not, or null. */
export function speechTargetError(t: SpeechTarget): string | null {
  if (!t.inServer) return "They're not in the server.";
  if (t.isBot) return "Bots can't be filtered.";
  if (t.isOwner || t.isStaff) return "Staff and the owner can't be filtered.";
  if (t.optedOut) return "They've opted out of rainbow speech.";
  return null;
}

const SWAPS: Record<string, string> = {
  hi: 'heyyy gorgeous',
  hello: 'hellooo gorgeous',
  hey: 'heyyy bestie',
  bro: 'bestie',
  bruh: 'bestie',
  dude: 'diva',
  man: 'queen',
  guys: 'besties',
  yes: 'yasss',
  yeah: 'yasss',
  ok: 'okiee',
  okay: 'okiee',
  lol: 'lol slay',
  good: 'fabulous',
  nice: 'iconic',
  cool: 'fierce',
  bad: 'not the vibe',
};
const SPARKLES = ['✨', '💖', '🌈', '💅', '🦄', '🌸'];
const MAX = 2000;

/**
 * The 🌈 flair: swaps a few words, adds sparkles between some words and rainbow
 * emoji around it. Mentions, links, emoji and everything else are left as they are,
 * and the meaning stays. `random` returns 0 ≤ n < 1.
 */
export function rainbowify(text: string, random: () => number): string {
  const tokens = text.split(/(\s+)/);
  const out = tokens.map((tok) => {
    if (/^\s+$/.test(tok) || !tok) return tok;
    // Leave mentions, channels, custom emoji and links alone.
    if (/^<[@#:a].*>$/.test(tok) || /^https?:\/\//i.test(tok)) return tok;
    const m = /^([^a-z]*)([a-z]+)([^a-z]*)$/i.exec(tok);
    const swap = m ? SWAPS[m[2]!.toLowerCase()] : undefined;
    const word = m && swap ? `${m[1]}${matchCase(m[2]!, swap)}${m[3]}` : tok;
    return random() < 0.25 ? `${word} ${SPARKLES[Math.floor(random() * SPARKLES.length)]}` : word;
  });
  const flair = `🌈 ${out.join('').trim()} ~ 💖✨`;
  if (flair.length <= MAX) return flair;
  const plain = `🌈 ${text.trim()} ✨`;
  return plain.length <= MAX ? plain : text;
}

function matchCase(original: string, swap: string): string {
  if (original === original.toUpperCase() && original.length > 1) return swap.toUpperCase();
  if (original[0] === original[0]!.toUpperCase()) return swap[0]!.toUpperCase() + swap.slice(1);
  return swap;
}
