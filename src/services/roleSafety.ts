// Whether the bot may hand a role out (colour menus, the Donor role, donor tiers).
// The rules themselves are pure (core/colours.ts colourRoleError); this reads them
// off a live role.
import { PermissionFlagsBits, PermissionsBitField, type Role } from 'discord.js';
import { colourRoleError } from '../core/colours.js';

/** Permissions a handed-out role must never carry: the bot would give them to anyone. */
const DANGEROUS = new PermissionsBitField([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ViewAuditLog,
]).bitfield;

/** Why the bot can't hand this role out, or null. */
export async function assignableRoleError(role: Role): Promise<string | null> {
  const guild = role.guild;
  const botTop = (guild.members.me ?? (await guild.members.fetchMe())).roles.highest;
  return colourRoleError({
    id: role.id,
    everyoneId: guild.id,
    managed: role.managed,
    belowBot: role.position < botTop.position,
    dangerous: (role.permissions.bitfield & DANGEROUS) !== 0n,
  });
}
