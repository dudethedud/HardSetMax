// Runtime access check. Discord also hides admin commands from members without
// Administrator, but every handler re-checks here, because server owners can
// override command permissions in Integrations settings.
//
//   admin: Administrator, or the owner
//   owner: only the server owner

export type AccessLevel = 'admin' | 'owner';

export interface AccessInput {
  /** Guild the interaction came from; null for DMs. */
  guildId: string | null;
  /** The only guild this bot serves. */
  expectedGuildId: string;
  isOwner: boolean;
  isAdministrator: boolean;
}

export type AccessDenied = 'not-in-guild' | 'wrong-guild' | 'not-admin' | 'not-owner';
export type AccessResult = { ok: true } | { ok: false; reason: AccessDenied };

export function checkAccess(level: AccessLevel, { guildId, expectedGuildId, isOwner, isAdministrator }: AccessInput): AccessResult {
  if (guildId === null) return { ok: false, reason: 'not-in-guild' };
  if (guildId !== expectedGuildId) return { ok: false, reason: 'wrong-guild' };
  if (isOwner) return { ok: true };
  if (level === 'owner') return { ok: false, reason: 'not-owner' };
  return isAdministrator ? { ok: true } : { ok: false, reason: 'not-admin' };
}

export const ACCESS_DENIED: Record<AccessDenied, string> = {
  'not-in-guild': 'This bot only works inside the server.',
  'wrong-guild': 'This bot is not set up for this server.',
  'not-admin': 'Admins only.',
  'not-owner': 'Only the server owner can use this.',
};
