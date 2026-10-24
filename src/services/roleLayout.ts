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
