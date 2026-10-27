// The order of every role the bot manages (owner-approved, SPEC §12), top to bottom,
// all together right below where the VIP role sits:
//   the Crown holder's custom role
//   colour roles (first option on top): above VIP and the Crown so a picked colour shows
//   👑 Crown, 🛡️ Champion, 📜 Advisor, 🃏 Jester
//   VIP (directly above bleed's highest level role)
//   Polls
//   history badges (fewest weeks first)
// /bot setup places VIP, then calls arrangeRoles to stack the rest around it.
import type { Guild } from 'discord.js';
import { TITLE_SLOTS } from '../core/perks.js';
import type { Db } from '../db/prisma.js';
import type { GuildConfig } from '../generated/prisma/client.js';
import { placeNextTo } from './roleQueue.js';
import { rolesInUse } from './reuse.js';

/** Role IDs above VIP, bottom to top, and below VIP, top to bottom. Only roles that exist. */
export async function roleBlock(guild: Guild, db: Db, cfg: GuildConfig): Promise<{ above: string[]; below: string[] }> {
  const [titles, colours, badges, crown] = await Promise.all([
    db.crownTitle.findMany(),
    db.colourOption.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
    db.badge.findMany({ orderBy: { weeks: 'asc' } }),
    db.crownHolder.findFirst({ where: { endedAt: null }, orderBy: { awardedAt: 'desc' } }),
  ]);
  const custom = crown ? await db.customRole.findUnique({ where: { userId: crown.userId } }) : null;
  const titleIds = TITLE_SLOTS.map((t) => titles.find((r) => r.slot === t.slot)?.roleId);
  const exists = (id: string | null | undefined): id is string => !!id && guild.roles.cache.has(id);
  return {
    // Bottom to top: Jester, Advisor, Champion, Crown, last colour … first colour, custom role.
    above: [...[...titleIds].reverse(), cfg.crownRoleId, ...colours.map((c) => c.roleId).reverse(), custom?.roleId].filter(exists),
    below: [cfg.pollsRoleId, ...badges.map((b) => b.roleId)].filter(exists),
  };
}

/** Stacks the block around the VIP role. Returns an error line, or null. */
export async function arrangeRoles(guild: Guild, db: Db, cfg: GuildConfig): Promise<string | null> {
  if (!cfg.vipRoleId || !guild.roles.cache.has(cfg.vipRoleId)) return null;
  const { above, below } = await roleBlock(guild, db, cfg);
  try {
    let anchor = cfg.vipRoleId;
    for (const id of above) {
      await placeNextTo(guild, id, anchor, 'above');
      anchor = id;
    }
    anchor = cfg.vipRoleId;
    for (const id of below) {
      await placeNextTo(guild, id, anchor, 'below');
      anchor = id;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Coloured roles members can have that sit above VIP (and aren't the bot's or
 * staff's): Discord shows a name in its highest coloured role's colour, so these
 * would hide VIP's colour and the VIP colour picks. Highest first.
 */
export async function rolesCoveringVip(guild: Guild, db: Db, cfg: GuildConfig): Promise<string[]> {
  const vip = cfg.vipRoleId ? guild.roles.cache.get(cfg.vipRoleId) : undefined;
  if (!vip) return [];
  const botTop = (guild.members.me ?? (await guild.members.fetchMe())).roles.highest;
  const mine = await rolesInUse(db, cfg);
  const staff = new Set((await db.staffRole.findMany()).map((s) => s.roleId));
  return [...guild.roles.cache.values()]
    .filter((r) => r.position > vip.position && r.position < botTop.position && !r.managed && !mine.has(r.id) && !staff.has(r.id) && r.colors.primaryColor !== 0)
    .sort((a, b) => b.position - a.position)
    .map((r) => r.name);
}
