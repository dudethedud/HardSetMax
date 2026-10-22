// Text checks for message counting (SPEC §2). Message text is only ever looked at
// here, in memory; what's kept afterwards is a set of numbers (fingerprint), never
// the text itself.

const MENTION_RE = /<(@!?|@&|#)\d+>|@everyone|@here/g;
const CUSTOM_EMOJI_RE = /<a?:\w+:\d+>/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
// Not \p{Emoji_Component}: that includes the digits 0–9, # and *.
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[\u{e0020}-\u{e007f}]/gu;
const ALNUM_RE = /[\p{L}\p{N}]/gu;

/** Lowercased, with everything but letters and digits removed (SPEC §2 "Repeat"). */
export function normalize(text: string): string {
  return (text.toLowerCase().match(ALNUM_RE) ?? []).join('');
}

/** Length in characters (not UTF-16 units) after trimming. */
export function trimmedLength(text: string): number {
  return [...text.trim()].length;
}

/** Nothing but emoji (unicode or custom) and whitespace, or a sticker with no text. */
export function isEmojiOrStickerOnly(text: string, hasStickers: boolean): boolean {
  const rest = text.replace(CUSTOM_EMOJI_RE, '').replace(EMOJI_RE, '').trim();
  if (rest.length > 0) return false;
  return hasStickers || text.trim().length > 0;
}

/** Nothing but mentions, links, emoji, whitespace and punctuation. */
export function isOnlyMentionsLinksEmoji(text: string): boolean {
  const rest = text.replace(MENTION_RE, '').replace(URL_RE, '').replace(CUSTOM_EMOJI_RE, '').replace(EMOJI_RE, '');
  return normalize(rest).length === 0;
}

/** Number of different letters/digits ("hahahaha" → 2, "hello" → 4). */
export function distinctAlnumCount(text: string): number {
  return new Set(normalize(text)).size;
}

// 32-bit FNV-1a.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The fingerprint kept for the repeat check: hashes of each 3-character chunk of
 * the normalized text. Texts shorter than 3 characters use the whole text.
 */
export function fingerprint(text: string): ReadonlySet<number> {
  const n = normalize(text);
  const chunks = new Set<number>();
  if (n.length < 3) {
    if (n.length > 0) chunks.add(hash(n));
    return chunks;
  }
  for (let i = 0; i + 3 <= n.length; i++) chunks.add(hash(n.slice(i, i + 3)));
  return chunks;
}

/**
 * Dice similarity of two fingerprints, 0–1: shared chunks relative to the average
 * number of chunks. One typo in a 20-letter message scores about 0.85.
 */
export function similarity(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return (2 * shared) / (a.size + b.size);
}
