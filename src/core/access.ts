// Runtime access check (SPEC §1.2). Discord also hides commands from members
// without the command's default_member_permissions, but every handler re-checks
// here, because server owners can override command permissions in Integrations
// settings.
//
// Levels, lowest first:
//   staff: a staff role (/settings role), Administrator, or the owner
//   admin: Administrator, or the owner
//   owner: only the server owner

export type AccessLevel = 'staff' | 'admin' | 'owner';

export interface AccessInput {
  /** Guild the interaction came from; null for DMs. */
  guildId: string | null;
  /** The only guild this bot serves. */
  expectedGuildId: string;
  isOwner: boolean;
  isAdministrator: boolean;
  /** Has one of the staff roles. */
  isStaff: boolean;
}

export type AccessDenied = 'not-in-guild' | 'wrong-guild' | 'not-staff' | 'not-admin' | 'not-owner';
export type AccessResult = { ok: true } | { ok: false; reason: AccessDenied };

export function checkAccess(level: AccessLevel, { guildId, expectedGuildId, isOwner, isAdministrator, isStaff }: AccessInput): AccessResult {
  if (guildId === null) return { ok: false, reason: 'not-in-guild' };
  if (guildId !== expectedGuildId) return { ok: false, reason: 'wrong-guild' };
  if (isOwner) return { ok: true };
  if (level === 'owner') return { ok: false, reason: 'not-owner' };
  if (isAdministrator) return { ok: true };
  if (level === 'admin') return { ok: false, reason: 'not-admin' };
  return isStaff ? { ok: true } : { ok: false, reason: 'not-staff' };
}

export const ACCESS_DENIED: Record<AccessDenied, string> = {
  'not-in-guild': 'This bot only works inside the server.',
  'wrong-guild': 'This bot is not set up for this server.',
  'not-staff': 'Staff only.',
  'not-admin': 'Admins only.',
  'not-owner': 'Only the server owner can use this.',
};
