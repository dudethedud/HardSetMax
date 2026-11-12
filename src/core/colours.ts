// The colour rules (pure). Reppers (members with any unlock role) pick one colour
// role from the menus; picking replaces any other menu colour; someone who isn't
// a repper any more loses every menu colour.

/** The dropdown value that removes your colour. */
export const NO_COLOUR = 'none';
/** A dropdown holds 25 options; one is "Remove colour". */
export const MAX_COLOURS_PER_MENU = 24;

export function isRepper(memberRoleIds: ReadonlySet<string>, unlockRoleIds: ReadonlySet<string>): boolean {
  for (const id of unlockRoleIds) if (memberRoleIds.has(id)) return true;
  return false;
}

/**
 * The member's roles after picking `picked` (a colour role ID, or null to remove):
 * every menu colour comes off, then the picked one goes on. Other roles stay.
 */
export function rolesAfterPick(memberRoleIds: readonly string[], colourRoleIds: ReadonlySet<string>, picked: string | null): string[] {
  const kept = memberRoleIds.filter((id) => !colourRoleIds.has(id));
  return picked ? [...kept, picked] : kept;
}

/** Menu colours a member must lose because they don't rep the server any more. */
export function coloursToStrip(memberRoleIds: ReadonlySet<string>, unlockRoleIds: ReadonlySet<string>, colourRoleIds: ReadonlySet<string>): string[] {
  // With no unlock roles set up yet, nobody is stripped: that's a setup gap, not a lost repper.
  if (unlockRoleIds.size === 0 || isRepper(memberRoleIds, unlockRoleIds)) return [];
  return [...memberRoleIds].filter((id) => colourRoleIds.has(id));
}

export interface RoleFacts {
  id: string;
  everyoneId: string;
  managed: boolean;
  /** Its position is below the bot's highest role. */
  belowBot: boolean;
  /** It has a permission that shouldn't be handed out by a colour menu. */
  dangerous: boolean;
}

/** Why the bot can't hand a role out (as a colour, the Donor role or a donor tier), or null. */
export function colourRoleError(r: RoleFacts): string | null {
  if (r.id === r.everyoneId) return "@everyone can't be handed out.";
  if (r.managed) return "That role belongs to a bot or integration, so it can't be given out.";
  if (r.dangerous) return 'That role has moderator or admin permissions. Roles the bot hands out should have none.';
  if (!r.belowBot) return "That role is above the bot's highest role. Drag the bot's role above it in Server Settings → Roles.";
  return null;
}

/**
 * The DM a member gets when the bot takes their colour off because they stopped
 * repping. `channelId`: where the menus are posted, if anywhere.
 */
export function removalDm(colourNames: readonly string[], serverName: string, channelId: string | null): string {
  const colours = colourNames.map((n) => `**${n}**`).join(', ');
  const where = channelId ? `<#${channelId}>` : 'the colour menus';
  return `🎨 Your ${colours} colour was removed because you're no longer repping **${serverName}** (server tag or \`.gg/femboii\` in your status). Rep again and pick a new colour in ${where}!`;
}
