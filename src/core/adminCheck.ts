// Runtime admin check (SPEC §1.2). Discord also hides the commands from non-admins
// via default_member_permissions, but every handler re-checks here, because server
// owners can override command permissions in Integrations settings.

export interface AdminCheckInput {
  /** Guild the interaction came from; null for DMs. */
  guildId: string | null;
  /** The only guild this bot serves. */
  expectedGuildId: string;
  /** Whether the member has the Administrator permission in that guild. */
  isAdministrator: boolean;
}

export type AdminCheckResult = { ok: true } | { ok: false; reason: 'not-in-guild' | 'wrong-guild' | 'not-admin' };

export function checkAdmin({ guildId, expectedGuildId, isAdministrator }: AdminCheckInput): AdminCheckResult {
  if (guildId === null) return { ok: false, reason: 'not-in-guild' };
  if (guildId !== expectedGuildId) return { ok: false, reason: 'wrong-guild' };
  if (!isAdministrator) return { ok: false, reason: 'not-admin' };
  return { ok: true };
}
