// Runtime access check. Discord also hides staff/admin commands from members
// without the command's default permission, but every handler re-checks here,
// because server owners can override command permissions in Integrations settings.
//
//   everyone:      any member, inside the server (the invite event's public commands)
//   manage-server: Manage Server, Administrator, or the owner (invite event staff)
//   admin:         Administrator, or the owner
//   owner:         only the server owner

export type AccessLevel = 'everyone' | 'manage-server' | 'admin' | 'owner';

export interface AccessInput {
  /** Guild the interaction came from; null for DMs. */
  guildId: string | null;
  /** The only guild this bot serves. */
  expectedGuildId: string;
  isOwner: boolean;
  isAdministrator: boolean;
  /** Has Manage Server (Administrator implies it). */
  canManageServer?: boolean;
}

export type AccessDenied = 'not-in-guild' | 'wrong-guild' | 'not-staff' | 'not-admin' | 'not-owner';
export type AccessResult = { ok: true } | { ok: false; reason: AccessDenied };

export function checkAccess(level: AccessLevel, { guildId, expectedGuildId, isOwner, isAdministrator, canManageServer = false }: AccessInput): AccessResult {
  if (guildId === null) return { ok: false, reason: 'not-in-guild' };
  if (guildId !== expectedGuildId) return { ok: false, reason: 'wrong-guild' };
  if (level === 'everyone' || isOwner) return { ok: true };
  if (level === 'owner') return { ok: false, reason: 'not-owner' };
  if (isAdministrator) return { ok: true };
  if (level === 'admin') return { ok: false, reason: 'not-admin' };
  return canManageServer ? { ok: true } : { ok: false, reason: 'not-staff' };
}

export const ACCESS_DENIED: Record<AccessDenied, string> = {
  'not-in-guild': 'This bot only works inside the server.',
  'wrong-guild': 'This bot is not set up for this server.',
  'not-staff': 'Staff only (Manage Server).',
  'not-admin': 'Admins only.',
  'not-owner': 'Only the server owner can use this.',
};
