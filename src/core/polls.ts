// VIP poll limits (SPEC §5a). Pure: the caller processes polls one at a time, in
// the order Discord received them, with counts read from the database.

export interface PollContext {
  /** Staff role or Administrator: no limits, no locks. */
  isStaffOrAdmin: boolean;
  isVip: boolean;
  /** This user's accepted VIP polls today (deleted ones still count). */
  userPollsToday: number;
  /** Accepted VIP polls today across everyone (admin-granted extras don't count). */
  vipPollsToday: number;
  cap: number;
  /** An admin gave this user one more poll today with /vip poll-unlock. */
  hasExtraAllowance: boolean;
}

export type PollDecision =
  | {
      accept: true;
      kind: 'vip' | 'extra' | 'staff';
      /** Lock #polls for this user until the end of the server-day. */
      lockUser: boolean;
      /** Lock #polls for the whole VIP role until the end of the server-day. */
      lockRole: boolean;
    }
  | { accept: false; reason: 'not-vip' | 'already-posted' | 'cap-reached'; lockUser: boolean; lockRole: boolean };

export function decidePoll(c: PollContext): PollDecision {
  if (c.isStaffOrAdmin) return { accept: true, kind: 'staff', lockUser: false, lockRole: false };
  if (!c.isVip) return { accept: false, reason: 'not-vip', lockUser: false, lockRole: false };
  const capReached = c.vipPollsToday >= c.cap;
  if (c.hasExtraAllowance) return { accept: true, kind: 'extra', lockUser: true, lockRole: capReached };
  if (c.userPollsToday >= 1) return { accept: false, reason: 'already-posted', lockUser: true, lockRole: capReached };
  if (capReached) return { accept: false, reason: 'cap-reached', lockUser: false, lockRole: true };
  return { accept: true, kind: 'vip', lockUser: true, lockRole: c.vipPollsToday + 1 >= c.cap };
}

export const POLL_REJECT_TEXT: Record<Extract<PollDecision, { accept: false }>['reason'], string> = {
  'not-vip': 'only VIPs and staff can post polls',
  'already-posted': 'already posted a poll today',
  'cap-reached': "today's poll limit was already reached",
};

/** Thread name for a poll's discussion (Discord allows 1–100 characters). */
export function pollThreadName(question: string): string {
  const name = question.replace(/\s+/g, ' ').trim();
  if (!name) return 'Poll discussion';
  return name.length > 100 ? `${name.slice(0, 99)}…` : name;
}

export interface ColourDefault {
  name: string;
  hex: string;
}

/** Default VIP colours (owner-approved), added once by /bot setup. */
export const DEFAULT_COLOURS: readonly ColourDefault[] = [
  { name: 'Rose', hex: '#FF6B9D' },
  { name: 'Crimson', hex: '#E63946' },
  { name: 'Tangerine', hex: '#FF8C42' },
  { name: 'Lemon', hex: '#FFE66D' },
  { name: 'Mint', hex: '#5EEAD4' },
  { name: 'Emerald', hex: '#2ECC71' },
  { name: 'Sky', hex: '#4CC9F0' },
  { name: 'Royal', hex: '#4361EE' },
  { name: 'Lavender', hex: '#B794F4' },
  { name: 'Snow', hex: '#F8F9FA' },
];

/** A select menu holds 25 options; one is "Remove colour". */
export const MAX_COLOURS = 24;
