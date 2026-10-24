// /bot setup fitting the bot into an existing server (owner-approved). Every guess
// is reported, only fills in settings that aren't set yet, and never touches a
// setting an admin chose. The decisions themselves are pure (core/autoSetup.ts).
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildBasedChannel,
  type GuildChannel,
  type Role,
} from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { blockedVipPerks, isLowValueChannel, pickChannel, pickLevelTop, type ChannelPurpose } from '../core/autoSetup.js';
import type { Db } from '../db/prisma.js';
import { rolesInUse } from './reuse.js';

const STAFF_PERMS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageMessages,
];

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

/** Channels the bot made for itself; never guessed at or changed here. */
function botChannels(guild: Guild, cfg: ConfigStore['current']['guild']): Set<string> {
  const ids = new Set([cfg.loungeCategoryId, cfg.loungeTextId, cfg.loungeVoiceId, cfg.pollsChannelId, cfg.vipBoardChannelId].filter((id): id is string => !!id));
  for (const c of guild.channels.cache.values()) if (c.parentId && ids.has(c.parentId)) ids.add(c.id);
  return ids;
}

/**
 * Fills in what isn't set: bleed's top level role, staff roles, the announcements,
 * mod-log and main chat channels, and (once) zero weight for bot/spam channels.
 * Runs before the VIP role is placed, so a found level role is used straight away.
 */
export async function autoConfigure(guild: Guild, db: Db, config: ConfigStore, report: string[]): Promise<void> {
  const cfg = config.current.guild;
  const botTop = (guild.members.me ?? (await guild.members.fetchMe())).roles.highest;
  const data: Record<string, string | boolean> = {};

  if (!cfg.levelRolesTopId) {
    const level = pickLevelTop(guild.roles.cache.values(), botTop.position);
    if (level) {
      data.levelRolesTopId = level.id;
      report.push(`🔎 Top level role set to ${level.toString()} (looks like bleed's highest level role). Change it with \`/settings role action:level-top\`.`);
    }
  }

  if ((await db.staffRole.count()) === 0) {
    const used = await rolesInUse(db, cfg);
    const staff = guild.roles.cache.filter(
      (r) => r.id !== guild.id && !r.managed && !used.has(r.id) && STAFF_PERMS.some((p) => r.permissions.has(p, false)),
    );
    if (staff.size) {
      await db.staffRole.createMany({ data: staff.map((r) => ({ roleId: r.id })), skipDuplicates: true });
      report.push(`🔎 Staff roles set to ${staff.map((r) => r.toString()).join(', ')} (roles with moderator permissions). Change them with \`/settings role\`.`);
    }
  }

  const mine = botChannels(guild, cfg);
  const textChannels = guild.channels.cache
    .filter((c) => TEXT_TYPES.has(c.type) && !mine.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, isAnnouncement: c.type === ChannelType.GuildAnnouncement, channel: c }));
  const fields: [ChannelPurpose, 'mainChatChannelId' | 'announceChannelId' | 'modLogChannelId'][] = [
    ['main-chat', 'mainChatChannelId'],
    ['announcements', 'announceChannelId'],
    ['mod-log', 'modLogChannelId'],
  ];
  for (const [purpose, field] of fields) {
    if (cfg[field]) continue;
    const hit = pickChannel(textChannels, purpose);
    if (hit) {
      data[field] = hit.id;
      report.push(`🔎 ${purpose} channel set to <#${hit.id}>. Change it with \`/settings channel purpose:${purpose}\`.`);
    }
  }

  if (!cfg.autoWeightsDone) {
    const existing = new Set((await db.channelWeight.findMany()).map((w) => w.channelId));
    const quiet = textChannels.filter((c) => isLowValueChannel(c.name) && !existing.has(c.id));
    if (quiet.length) {
      await db.channelWeight.createMany({ data: quiet.map((c) => ({ channelId: c.id, weight: 0 })), skipDuplicates: true });
      report.push(`🔎 Messages in ${quiet.map((c) => `<#${c.id}>`).join(', ')} no longer count toward VIP (bot, spam or counting channels). Change with \`/settings channel-weight\`.`);
    }
    data.autoWeightsDone = true;
  }

  if (Object.keys(data).length) {
    await db.$transaction([
      db.guildConfig.update({ where: { guildId: guild.id }, data }),
      db.auditLog.create({ data: { action: 'setup.auto', data } }),
    ]);
    await config.load();
  }
}

/**
 * Where a channel's own @everyone deny blocks a VIP perk, the VIP role's
 * permissions can't help, so VIP gets an allow for just those perks there. A
 * channel synced to its category is fixed on the category instead, keeping it synced.
 */
export async function unblockVipPerks(guild: Guild, vipRole: Role, vipPerms: readonly bigint[], cfg: ConfigStore['current']['guild'], report: string[]): Promise<void> {
  const perms = vipPerms.reduce((a, b) => a | b, 0n);
  const mine = botChannels(guild, cfg);
  const targets = new Map<string, GuildChannel>();
  for (const c of guild.channels.cache.values() as IterableIterator<GuildBasedChannel>) {
    if (mine.has(c.id) || c.isThread() || !('permissionOverwrites' in c)) continue;
    const target = c.parent && c.permissionsLocked ? c.parent : c;
    if (!mine.has(target.id)) targets.set(target.id, target);
  }
  const fixed: string[] = [];
  for (const channel of targets.values()) {
    const everyone = channel.permissionOverwrites.cache.get(guild.id);
    const vip = channel.permissionOverwrites.cache.get(vipRole.id);
    const missing = blockedVipPerks({
      everyoneDeny: everyone?.deny.bitfield ?? 0n,
      vipAllow: vip?.allow.bitfield ?? 0n,
      vipPerms: perms,
      viewBit: PermissionFlagsBits.ViewChannel,
      sendBit: PermissionFlagsBits.SendMessages,
    });
    if (!missing) continue;
    const allow = Object.fromEntries(new PermissionsBitField(missing).toArray().map((name) => [name, true]));
    try {
      await channel.permissionOverwrites.edit(vipRole, allow, { reason: '/bot setup: VIP perks were blocked here' });
      fixed.push(channel.type === ChannelType.GuildCategory ? `${channel.name} (category)` : `<#${channel.id}>`);
    } catch {
      report.push(`⚠️ Couldn't give VIP its perks in <#${channel.id}>: the bot needs Manage Permissions there.`);
    }
  }
  if (fixed.length) report.push(`✅ VIP perks unblocked in ${fixed.length} place(s) that denied them to everyone: ${fixed.join(', ')}`.slice(0, 1900));
}

/** The category new bot channels go in: next to announcements (or main chat), if those are in one. */
export function homeCategoryId(guild: Guild, cfg: ConfigStore['current']['guild']): string | undefined {
  for (const id of [cfg.announceChannelId, cfg.mainChatChannelId]) {
    const parent = id ? guild.channels.cache.get(id)?.parentId : null;
    if (parent) return parent;
  }
  return undefined;
}
