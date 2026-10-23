// The AI's "this message was mean or NSFW" flag (owner-approved exception to "the
// AI only produces text"): the reply ends with STRIKE_TAG, the code removes it
// before posting and counts a strike for the person who wrote the message, never
// anyone else. Enough strikes in a day and the bot stops replying to them. Pure.

export const STRIKE_TAG = '[[STRIKE]]';
export const STRIKE_WINDOW_MS = 24 * 60 * 60_000;

/** Removes the tag (and anything that looks like it) from a reply, and says whether it was there. */
export function extractStrike(raw: string): { text: string; strike: boolean } {
  const re = /\[\[\s*strike\s*\]\]/gi;
  const strike = re.test(raw);
  return { text: raw.replace(re, '').replace(/[ \t]{2,}/g, ' ').trim(), strike };
}

/** True once `limit` strikes (including this one) fall inside the window. */
export function reachedStrikeLimit(strikeTimes: readonly Date[], now: Date, limit: number, windowMs = STRIKE_WINDOW_MS): boolean {
  return strikeTimes.filter((t) => now.getTime() - t.getTime() < windowMs).length >= limit;
}
