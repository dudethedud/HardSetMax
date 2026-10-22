// /setup run (SPEC §10, §12): creates or repairs the VIP role and lounge, checks
// role order and the bot's permissions. Safe to run any number of times.
import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type OverwriteResolvable,
  type Role,
} from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { parseHexColour } from '../core/vipRules.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { Panels } from './panels.js';
import { explainRoleError } from './roleQueue.js';
import type { VipService } from './vipService.js';

/** What VIP gives (SPEC §3). */
export const VIP_PERMISSIONS = [
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.UseExternalStickers,
  PermissionFlagsBits.UseSoundboard,
  PermissionFlagsBits.UseExternalSounds,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
];

/** What the bot needs for everything up to Phase 4. */
export const BOT_PERMISSIONS = [
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.Connect,
  // Discord only lets the bot give the VIP role permissions it has itself.
  ...VIP_PERMISSIONS,
];

export interface SetupDeps {
  /** More setup steps from later phases (colours, polls, …), run after the VIP role exists. */
  steps: ((guild: Guild, vipRole: Role, report: string[]) => Promise<void>)[];
  db: Db;
  config: ConfigStore;
  panels: Panels;
  vip: VipService;
  log: Logger;
}

const permName = (bit: bigint) => new PermissionsBitField(bit).toArray()[0] ?? String(bit);

export async function runSetup(guild: Guild, { steps, db, config, panels, vip, log }: SetupDeps): Promise<string[]> {
  const report: string[] = [];
  const me = await guild.members.fetchMe();
  const cfg = config.current.guild;

  const missing = BOT_PERMISSIONS.filter((p) => !me.permissions.has(p));
  if (missing.length) report.push(`⚠️ The bot is missing permissions: ${missing.map(permName).join(', ')}. Add them to the bot's role.`);

  // 1. VIP role.
  const colour = parseHexColour(cfg.vipColour) ?? 0xf1c40f;
  let vipRole: Role | null = cfg.vipRoleId ? (guild.roles.cache.get(cfg.vipRoleId) ?? null) : null;
  try {
    if (vipRole) {
      await vipRole.edit({ colors: { primaryColor: colour }, hoist: true, mentionable: false, permissions: VIP_PERMISSIONS, reason: '/setup run' });
      report.push(`✅ VIP role ${vipRole.toString()} updated`);
    } else {
      vipRole = await guild.roles.create({
        name: 'VIP',
        colors: { primaryColor: colour },
        hoist: true,
        mentionable: false,
        permissions: VIP_PERMISSIONS,
        reason: '/setup run',
      });
      report.push(`✅ VIP role ${vipRole.toString()} created`);
    }
  } catch (err) {
    log.warn({ err }, 'setup: VIP role');
    report.push(`❌ VIP role: ${explainRoleError(err)}`);
    if (!vipRole) return report;
  }

  // 2. Role position: directly above the highest bleed level role, if set.
  const botTop = me.roles.highest;
  const levelTop = cfg.levelRolesTopId ? guild.roles.cache.get(cfg.levelRolesTopId) : undefined;
  try {
    const target = levelTop ? levelTop.position + 1 : botTop.position - 1;
    if (target >= botTop.position) {
      report.push(`⚠️ The bot's role (${botTop.toString()}) must be above the level roles. Drag it higher in Server Settings → Roles, then run /setup run again.`);
    } else if (vipRole.position !== target) {
      await vipRole.setPosition(target, { reason: '/setup run' });
    }
    if (!levelTop) report.push('ℹ️ No level-roles-top set, so VIP was placed just below the bot. Set it with /config level-roles-top.');
  } catch (err) {
    report.push(`⚠️ Couldn't move the VIP role: ${explainRoleError(err)}`);
  }
  const fresh = await guild.roles.fetch(vipRole.id);
  if (fresh && fresh.position >= botTop.position) report.push(`⚠️ The VIP role is above the bot's role, so the bot can't give it. Move the bot's role higher.`);

  // 3. VIP lounge: category visible only to VIPs (and the bot), with a text and a voice channel.
  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: vipRole.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    },
    {
      id: me.id,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.Connect,
      ],
    },
  ];
  const ids = { loungeCategoryId: cfg.loungeCategoryId, loungeTextId: cfg.loungeTextId, loungeVoiceId: cfg.loungeVoiceId };
  try {
    const existing = (id: string | null) => (id ? (guild.channels.cache.get(id) ?? null) : null);
    let category = existing(cfg.loungeCategoryId) as CategoryChannel | null;
    if (category?.type === ChannelType.GuildCategory) await category.permissionOverwrites.set(overwrites, '/setup run');
    else category = await guild.channels.create({ name: 'VIP Lounge', type: ChannelType.GuildCategory, permissionOverwrites: overwrites, reason: '/setup run' });
    ids.loungeCategoryId = category.id;

    const ensureChild = async (id: string | null, name: string, type: ChannelType.GuildText | ChannelType.GuildVoice): Promise<GuildBasedChannel> => {
      const ch = existing(id);
      if (ch && ch.type === type && 'setParent' in ch) {
        await ch.setParent(category.id, { lockPermissions: true, reason: '/setup run' });
        return ch;
      }
      return guild.channels.create({ name, type, parent: category.id, reason: '/setup run' });
    };
    ids.loungeTextId = (await ensureChild(cfg.loungeTextId, 'vip-lounge', ChannelType.GuildText)).id;
    ids.loungeVoiceId = (await ensureChild(cfg.loungeVoiceId, 'VIP Voice', ChannelType.GuildVoice)).id;
    report.push(`✅ VIP lounge ready: <#${ids.loungeTextId}>, <#${ids.loungeVoiceId}>`);
  } catch (err) {
    log.warn({ err }, 'setup: lounge');
    report.push(`❌ VIP lounge: ${err instanceof Error ? err.message : String(err)}`);
  }

  await db.guildConfig.update({ where: { guildId: guild.id }, data: { vipRoleId: vipRole.id, ...ids } });
  await db.auditLog.create({ data: { action: 'setup.run', data: { vipRoleId: vipRole.id, ...ids } } });
  await config.load();

  for (const step of steps) {
    try {
      await step(guild, vipRole, report);
    } catch (err) {
      log.warn({ err }, 'setup step failed');
      report.push(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  report.push(...(await panels.ensureAll()));
  const drift = await vip.reconcile();
  if (drift.added || drift.removed) report.push(`🔧 VIP roles fixed: ${drift.added} restored, ${drift.removed} removed`);

  const c = config.current.guild;
  if (!c.announceChannelId) report.push('ℹ️ No announcement channel: set one with `/config channel purpose:announcements`.');
  if (!c.modLogChannelId) report.push('ℹ️ No mod-log channel: set one with `/config channel purpose:mod-log`.');
  return report;
}
