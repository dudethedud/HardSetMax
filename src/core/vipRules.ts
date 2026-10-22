// VIP eligibility and role reconciliation (SPEC §3, §11). Pure.
import type { Eligibility } from './reshuffle.js';

export interface EligibilityInput {
  inGuild: boolean;
  isBot: boolean;
  roleIds: readonly string[];
  staffRoleIds: ReadonlySet<string>;
  /** Timed out now, or at any point in the last `timeoutBlockDays` days. */
  timedOutRecently: boolean;
  blocked: boolean;
}

/** First reason that applies, in this order: left, bot, staff, blocked, timed out. */
export function eligibilityOf(m: EligibilityInput): Eligibility {
  if (!m.inGuild) return 'left';
  if (m.isBot) return 'bot';
  if (m.roleIds.some((r) => m.staffRoleIds.has(r))) return 'staff';
  if (m.blocked) return 'blocked';
  if (m.timedOutRecently) return 'timed-out';
  return 'eligible';
}

export interface RoleDrift {
  /** In the database as VIP but missing the role: give it back. */
  addRole: string[];
  /** Has the role but isn't VIP in the database (e.g. given by hand): take it away. */
  removeRole: string[];
}

/** The database is the source of truth; Discord roles are made to match. */
export function roleDrift(dbVips: Iterable<string>, roleHolders: Iterable<string>, inGuild: ReadonlySet<string>): RoleDrift {
  const db = new Set(dbVips);
  const holders = new Set(roleHolders);
  return {
    addRole: [...db].filter((id) => !holders.has(id) && inGuild.has(id)).sort(),
    removeRole: [...holders].filter((id) => !db.has(id)).sort(),
  };
}

const HEX_RE = /^#?([0-9a-f]{6})$/i;

/** "#ff8800" or "ff8800" → 0xff8800, or null if invalid. */
export function parseHexColour(s: string): number | null {
  const m = HEX_RE.exec(s.trim());
  return m ? parseInt(m[1]!, 16) : null;
}

export function formatHexColour(n: number): string {
  return `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
}
