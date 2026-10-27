// /bot setup reuses roles and channels that already exist with the expected name
// (so running it on a server that already has a "VIP" or "Polls" role doesn't make
// a second one), and /settings role can bind an existing role to a bot function.
import type { ChannelType, Guild, GuildBasedChannel, Role } from 'discord.js';
import { pickByName } from '../core/reuse.js';
import type { Db } from '../db/prisma.js';
import type { GuildConfig } from '../generated/prisma/client.js';

/** Every role the bot already uses for something. */
export async function rolesInUse(db: Db, cfg: GuildConfig): Promise<Set<string>> {
  const [staff, colours, badges, titles, custom] = await Promise.all([
    db.staffRole.findMany(),
    db.colourOption.findMany(),
    db.badge.findMany(),
    db.crownTitle.findMany(),
    db.customRole.findMany({ where: { roleId: { not: null } } }),
  ]);
  return new Set(
    [
      cfg.vipRoleId,
      cfg.crownRoleId,
      cfg.pollsRoleId,
      cfg.levelRolesTopId,
      ...staff.map((s) => s.roleId),
      ...colours.map((c) => c.roleId),
      ...badges.map((b) => b.roleId),
      ...titles.map((t) => t.roleId),
      ...custom.map((c) => c.roleId),
    ].filter((id): id is string => !!id),
  );
}

/**
 * An existing role with one of these names the bot can take over, if any. By
 * default only roles with no permissions qualify (every role the bot makes has
 * none), so a same-named role that does something else is never taken over.
 * `unusedOnly` also skips roles anyone has.
 */
export async function findExistingRole(
  guild: Guild,
  db: Db,
  cfg: GuildConfig,
  names: readonly string[],
  { allowPermissions = false, unusedOnly = false } = {},
): Promise<Role | undefined> {
  const used = await rolesInUse(db, cfg);
  const botTop = (guild.members.me ?? (await guild.members.fetchMe())).roles.highest;
  return pickByName(
    guild.roles.cache.values(),
    names,
    (r) =>
      r.managed ||
      r.id === guild.id ||
      used.has(r.id) ||
      r.position >= botTop.position ||
      (!allowPermissions && r.permissions.bitfield !== 0n) ||
      // Colour, badge and title roles are given and taken by the bot: never take over one people already have.
      (unusedOnly && r.members.size > 0),
  );
}

/** An existing channel of this type with one of these names, if any (inside `parentId` when given). */
export function findExistingChannel(guild: Guild, names: readonly string[], type: ChannelType, parentId?: string): GuildBasedChannel | undefined {
  return pickByName(guild.channels.cache.values(), names, (c) => c.type !== type || (parentId !== undefined && c.parentId !== parentId));
}
