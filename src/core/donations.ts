// Donations (pure): reading Ko-fi's webhook, donor codes, money and the panel's
// numbers. See docs/SPEC.md §7.
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** Ko-fi posts form data with one field, `data`, holding this JSON. Unknown fields are ignored. */
const KofiSchema = z.object({
  verification_token: z.string(),
  message_id: z.string().min(1),
  type: z.string(),
  is_public: z.boolean().default(true),
  from_name: z.string().nullish(),
  message: z.string().nullish(),
  amount: z.string(),
  currency: z.string().default('USD'),
});

/** Ko-fi notification types that are money towards the fund. */
const COUNTED_TYPES = new Set(['Donation', 'Subscription']);

export interface KofiDonation {
  kofiId: string;
  displayName: string;
  amountCents: number;
  currency: string;
  isPublic: boolean;
  /** The donor's code, if they pasted one into their message. */
  code: string | null;
}

export type KofiParse = { ok: true; donation: KofiDonation } | { ok: false; status: number; reason: string } | { ok: 'ignored'; reason: string };

/** Constant-time token check, so the token can't be guessed from response timing. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** "3.00" → 300. Null for anything that isn't a positive amount. */
export function toCents(amount: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) return null;
  const cents = Math.round(Number(amount) * 100);
  return cents > 0 ? cents : null;
}

export const CODE_PREFIX = 'SH-';
const CODE_RE = /\bSH-([A-Z2-9]{4})\b/i;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

/** A short code like "SH-7K2F", from random bytes. */
export function makeCode(randomBytes: Uint8Array): string {
  return CODE_PREFIX + [...randomBytes.slice(0, 4)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function findCode(message: string | null | undefined): string | null {
  const m = message ? CODE_RE.exec(message) : null;
  return m ? `${CODE_PREFIX}${m[1]!.toUpperCase()}` : null;
}

/** Reads a Ko-fi webhook body. Rejects a wrong token (401) and bad data (400); ignores types that aren't money for the fund. */
export function parseKofi(formBody: string, expectedToken: string): KofiParse {
  const raw = new URLSearchParams(formBody).get('data');
  if (!raw) return { ok: false, status: 400, reason: 'no data field' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, reason: 'data is not JSON' };
  }
  const parsed = KofiSchema.safeParse(json);
  if (!parsed.success) return { ok: false, status: 400, reason: 'missing fields' };
  const k = parsed.data;
  if (!tokenMatches(k.verification_token, expectedToken)) return { ok: false, status: 401, reason: 'wrong verification token' };
  if (!COUNTED_TYPES.has(k.type)) return { ok: 'ignored', reason: `type ${k.type}` };
  const amountCents = toCents(k.amount);
  if (amountCents === null) return { ok: false, status: 400, reason: 'bad amount' };
  const name = (k.from_name ?? '').trim().slice(0, 80);
  return {
    ok: true,
    donation: {
      kofiId: k.message_id,
      displayName: k.is_public && name ? name : 'Anonymous',
      amountCents,
      currency: k.currency.toUpperCase().slice(0, 3),
      isPublic: k.is_public,
      // The code links the donation to a Discord member; a private donor stays anonymous anyway.
      code: k.is_public ? findCode(k.message) : null,
    },
  };
}

export function formatMoney(cents: number, currency = 'USD'): string {
  const value = (cents / 100).toFixed(2);
  return currency === 'USD' ? `$${value}` : `${value} ${currency}`;
}

/** "▰▰▰▰▱▱▱▱▱▱ 40%" for raised/goal; the bar is full at or past the goal. */
export function progressBar(raisedCents: number, goalCents: number, width = 10): string {
  const ratio = goalCents > 0 ? Math.min(1, raisedCents / goalCents) : 0;
  const filled = Math.round(ratio * width);
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)} ${Math.floor((raisedCents / Math.max(1, goalCents)) * 100)}%`;
}

export interface DonationRow {
  userId: string | null;
  displayName: string;
  amountCents: number;
  isPublic: boolean;
}

/** Top donors by total: members by ID, others by Ko-fi name. Anonymous donations count to the total but not here. */
export function topDonors(rows: readonly DonationRow[], limit = 5): { label: string; cents: number }[] {
  const totals = new Map<string, { label: string; cents: number }>();
  for (const r of rows) {
    if (!r.isPublic || (!r.userId && r.displayName === 'Anonymous')) continue;
    const key = r.userId ? `u:${r.userId}` : `n:${r.displayName.toLowerCase()}`;
    const t = totals.get(key) ?? { label: donorLabel(r), cents: 0 };
    t.cents += r.amountCents;
    totals.set(key, t);
  }
  return [...totals.values()].sort((a, b) => b.cents - a.cents).slice(0, limit);
}

/** How a donation is named in public: the member, their Ko-fi name (formatting stripped), or "Someone" when private. */
export function donorLabel(d: { userId: string | null; displayName: string; isPublic: boolean }): string {
  if (!d.isPublic) return 'Someone';
  // Formatting, mentions and {emoji|placeholder} characters are stripped from Ko-fi names.
  return d.userId ? `<@${d.userId}>` : `**${d.displayName.replace(/[*_`~|<>@#{}]/g, '') || 'Someone'}**`;
}
