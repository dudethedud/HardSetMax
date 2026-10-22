// Safety for AI text (SPEC §9a "Safety"). The AI only produces text; this makes sure
// that text can't ping anyone and stays short. Pure.
import { normalizeRoleName } from '../crown.js';

export const MAX_REPLY_CHARS = 400;

/** Removes @everyone/@here and role mentions, and trims to `max` characters. */
export function sanitizeAiText(raw: string, max = MAX_REPLY_CHARS): string {
  let t = raw
    .replace(/<@&\d+>/g, '')
    .replace(/@(everyone|here)/gi, '$1')
    .replace(/\s+\n/g, '\n')
    .trim()
    .replace(/^["“]|["”]$/g, '')
    .trim();
  if ([...t].length > max) {
    const cut = [...t].slice(0, max - 1).join('');
    const sentence = cut.lastIndexOf('. ');
    t = sentence > max / 2 ? cut.slice(0, sentence + 1) : `${cut}…`;
  }
  return t;
}

export function containsBlockedWord(text: string, words: readonly string[]): boolean {
  const norm = normalizeRoleName(text);
  return words.some((w) => {
    const n = normalizeRoleName(w);
    return n.length > 0 && norm.includes(n);
  });
}

/** Up to `limit` replies per person in any rolling minute (default 3). */
export function allowReply(history: readonly number[], now: number, limit: number, windowMs = 60_000): boolean {
  return history.filter((t) => t > now - windowMs).length < limit;
}

/** Hype lines must not carry numbers: numbers in posts always come from code. */
export function hypeLineOrNull(raw: string): string | null {
  const t = sanitizeAiText(raw.split('\n')[0] ?? '', 160);
  return t && !/\d/.test(t) ? t : null;
}
