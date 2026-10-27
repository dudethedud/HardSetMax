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
  /** Second colour of a gradient. */
  hex2?: string;
}

/** Default VIP colours (owner-approved), added once by /bot setup. */
// VIP-only gradients (owner request): names that don't clash with the server's own
// colour roles. Servers without Discord's gradient roles feature show the first colour.
export const DEFAULT_COLOURS: readonly ColourDefault[] = [
  { name: 'Starlight Bloom', hex: '#FF9AE2', hex2: '#9B8CFF' },
  { name: 'Sunset Candy', hex: '#FF7A59', hex2: '#FFC75F' },
  { name: 'Ocean Glow', hex: '#2EC4FF', hex2: '#3DFFC5' },
  { name: 'Sakura Drift', hex: '#FFB7D5', hex2: '#FF6FA8' },
  { name: 'Golden Hour', hex: '#FFD86B', hex2: '#FF9F43' },
  { name: 'Frostbite', hex: '#E0F7FF', hex2: '#7FB8FF' },
  { name: 'Lava Lamp', hex: '#FF4D6D', hex2: '#B14CFF' },
  { name: 'Galaxy Pop', hex: '#7B5CFF', hex2: '#FF5CDB' },
  { name: 'Mint Sorbet', hex: '#9CFFD9', hex2: '#5ED1FF' },
  { name: 'Cotton Candy', hex: '#A7D8FF', hex2: '#FFB3E6' },
];

/** A select menu holds 25 options; one is "Remove colour". */
export const MAX_COLOURS = 24;
