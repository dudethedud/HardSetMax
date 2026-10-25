// /bot setup (SPEC §10, §12): creates or repairs the VIP role, lounge and board, checks
// role order and the bot's permissions. Safe to run any number of times.
import {
  ChannelType,
  GuildPremiumTier,
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
import { explainRoleError, placeNextTo } from './roleQueue.js';
import { findExistingChannel, findExistingRole } from './reuse.js';
import { arrangeRoles } from './roleLayout.js';
import { autoConfigure, homeCategoryId, unblockVipPerks } from './autoSetup.js';
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

/** What the bot needs for everything it does. */
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
  // Crown perks: the 👑 nickname, and the voice perks it hands out in the Crown's hall.
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.PrioritySpeaker,
  PermissionFlagsBits.MoveMembers,
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

  // 1. VIP role, with a ⭐ icon when the server's boost level allows role icons.
  const colour = parseHexColour(cfg.vipColour) ?? 0xf1c40f;
  const icon = guild.premiumTier >= GuildPremiumTier.Tier2 ? { unicodeEmoji: '⭐' } : {};
  let vipRole: Role | null = cfg.vipRoleId ? (guild.roles.cache.get(cfg.vipRoleId) ?? null) : null;
  // Not set up yet: take over an existing "VIP" role rather than making a second one.
  let reused = false;
  if (!vipRole) {
    vipRole = (await findExistingRole(guild, db, cfg, ['VIP'], { allowPermissions: true })) ?? null;
    reused = !!vipRole;
  }
  try {
    if (vipRole) {
      await vipRole.edit({ colors: { primaryColor: colour }, hoist: true, mentionable: false, permissions: VIP_PERMISSIONS, ...icon, reason: '/bot setup' });
      report.push(reused ? `♻️ Using the existing ${vipRole.toString()} role for VIP` : `✅ VIP role ${vipRole.toString()} updated`);
    } else {
      vipRole = await guild.roles.create({
        name: 'VIP',
        colors: { primaryColor: colour },
        hoist: true,
        mentionable: false,
        permissions: VIP_PERMISSIONS,
        ...icon,
        reason: '/bot setup',
      });
      report.push(`✅ VIP role ${vipRole.toString()} created`);
    }
  } catch (err) {
    log.warn({ err }, 'setup: VIP role');
    report.push(`❌ VIP role: ${explainRoleError(err)}`);
    if (!vipRole) return report;
  }

  // Fit into the existing server: level role, staff, channels, quiet channels (only what isn't set).
  try {
    await autoConfigure(guild, db, config, report);
  } catch (err) {
    log.warn({ err }, 'setup: auto-configure');
    report.push(`⚠️ Couldn't look through the server for existing roles and channels: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Role position: directly above the highest bleed level role, if set; else just below the bot.
  const botTop = me.roles.highest;
  const levelTopId = config.current.guild.levelRolesTopId;
  const levelTop = levelTopId ? guild.roles.cache.get(levelTopId) : undefined;
  try {
    if (levelTop && (levelTop.managed || levelTop.position >= botTop.position)) {
      // A wrong level-top (e.g. the bot's own role) can't work: say which setting, and fall back.
      report.push(
        `⚠️ The top level role is set to ${levelTop.toString()}, which is the bot's own role or above it, so VIP can't go above it. Set it to bleed's highest level role with \`/settings role action:level-top\`. VIP was placed just below the bot for now.`,
      );
      await placeNextTo(guild, vipRole.id, botTop.id, 'below');
    } else if (levelTop) await placeNextTo(guild, vipRole.id, levelTop.id, 'above');
    else {
      await placeNextTo(guild, vipRole.id, botTop.id, 'below');
      report.push('ℹ️ No level-roles-top set, so VIP was placed just below the bot. Set it with /settings role action:level-top.');
    }
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
  const ids = { loungeCategoryId: cfg.loungeCategoryId, loungeTextId: cfg.loungeTextId, loungePerksId: cfg.loungePerksId, loungeVoiceId: cfg.loungeVoiceId };
  try {
    const existing = (id: string | null) => (id ? (guild.channels.cache.get(id) ?? null) : null);
    let category = existing(cfg.loungeCategoryId) as CategoryChannel | null;
    if (category?.type !== ChannelType.GuildCategory) category = (findExistingChannel(guild, ['VIP Lounge'], ChannelType.GuildCategory) as CategoryChannel | undefined) ?? null;
    if (category) await category.permissionOverwrites.set(overwrites, '/bot setup');
    else category = await guild.channels.create({ name: 'VIP Lounge', type: ChannelType.GuildCategory, permissionOverwrites: overwrites, reason: '/bot setup' });
    ids.loungeCategoryId = category.id;

    const ensureChild = async (id: string | null, name: string, type: ChannelType.GuildText | ChannelType.GuildVoice): Promise<GuildBasedChannel> => {
      const ch = existing(id) ?? findExistingChannel(guild, [name], type, category.id) ?? null;
      if (ch && ch.type === type && 'setParent' in ch) {
        await ch.setParent(category.id, { lockPermissions: true, reason: '/bot setup' });
        return ch;
      }
      return guild.channels.create({ name, type, parent: category.id, reason: '/bot setup' });
    };
    ids.loungeTextId = (await ensureChild(cfg.loungeTextId, 'vip-lounge', ChannelType.GuildText)).id;
    ids.loungeVoiceId = (await ensureChild(cfg.loungeVoiceId, 'VIP Voice', ChannelType.GuildVoice)).id;

    // #vip-perks: the panel's buttons and menus, read-only so chat doesn't bury them.
    const perksOverwrites: OverwriteResolvable[] = overwrites.map((o) =>
      o.id === vipRole.id
        ? {
            id: vipRole.id,
            type: OverwriteType.Role,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.SendMessagesInThreads,
              PermissionFlagsBits.CreatePublicThreads,
              PermissionFlagsBits.CreatePrivateThreads,
              PermissionFlagsBits.AddReactions,
            ],
          }
        : o,
    );
    let perks = existing(cfg.loungePerksId) ?? findExistingChannel(guild, ['vip-perks'], ChannelType.GuildText, category.id) ?? null;
    if (perks && perks.type === ChannelType.GuildText) {
      await perks.setParent(category.id, { lockPermissions: false, reason: '/bot setup' });
      await perks.permissionOverwrites.set(perksOverwrites, '/bot setup');
    } else {
      perks = await guild.channels.create({ name: 'vip-perks', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: perksOverwrites, reason: '/bot setup' });
    }
    ids.loungePerksId = perks.id;
    // Above the chat channel, so the buttons are the first thing VIPs see.
    const chat = guild.channels.cache.get(ids.loungeTextId);
    if (chat && 'position' in chat && 'setPosition' in perks) await perks.setPosition(chat.position, { reason: '/bot setup' }).catch(() => undefined);
    report.push(`✅ VIP lounge ready: <#${ids.loungePerksId}> (buttons, read-only), <#${ids.loungeTextId}> (chat), <#${ids.loungeVoiceId}>`);
  } catch (err) {
    log.warn({ err }, 'setup: lounge');
    report.push(`❌ VIP lounge: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!('unicodeEmoji' in icon)) report.push('ℹ️ The VIP role gets a ⭐ icon once the server reaches Boost Level 2.');

  // 4. The public VIP board: everyone can read it, only the bot posts.
  let vipBoardChannelId = cfg.vipBoardChannelId;
  try {
    const boardOverwrites: OverwriteResolvable[] = [
      {
        id: guild.roles.everyone.id,
        type: OverwriteType.Role,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.AddReactions,
        ],
      },
      {
        id: me.id,
        type: OverwriteType.Member,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks],
      },
    ];
    const board = (vipBoardChannelId ? guild.channels.cache.get(vipBoardChannelId) : undefined) ?? findExistingChannel(guild, ['vip-board'], ChannelType.GuildText);
    if (board && 'permissionOverwrites' in board && board.isTextBased()) {
      await board.permissionOverwrites.set(boardOverwrites, '/bot setup');
      vipBoardChannelId = board.id;
    }
    else vipBoardChannelId = (await guild.channels.create({ name: 'vip-board', type: ChannelType.GuildText, parent: homeCategoryId(guild, config.current.guild), permissionOverwrites: boardOverwrites, reason: '/bot setup' })).id;
    report.push(`✅ VIP board <#${vipBoardChannelId}> ready`);
  } catch (err) {
    log.warn({ err }, 'setup: VIP board');
    report.push(`❌ VIP board: ${err instanceof Error ? err.message : String(err)}`);
  }

  await db.guildConfig.update({ where: { guildId: guild.id }, data: { vipRoleId: vipRole.id, vipBoardChannelId, ...ids } });
  await db.auditLog.create({ data: { action: 'setup.run', data: { vipRoleId: vipRole.id, vipBoardChannelId, ...ids } } });
  await config.load();

  // VIP perks a channel blocks for @everyone (images, embeds…) get unblocked for VIP there.
  await unblockVipPerks(guild, vipRole, VIP_PERMISSIONS, config.current.guild, report).catch((err: unknown) => log.warn({ err }, 'setup: VIP perks'));

  for (const step of steps) {
    try {
      await step(guild, vipRole, report);
    } catch (err) {
      log.warn({ err }, 'setup step failed');
      report.push(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Every bot role together, in order, around VIP.
  const order = await arrangeRoles(guild, db, config.current.guild);
  report.push(order ? `⚠️ Couldn't put the bot's roles in order: ${order}` : '✅ Bot roles in order: colours, Crown and titles above VIP; Polls and badges below');
  report.push(...(await panels.ensureAll()));
  const drift = await vip.reconcile();
  if (drift.added || drift.removed) report.push(`🔧 VIP roles fixed: ${drift.added} restored, ${drift.removed} removed`);

  const c = config.current.guild;
  if (!c.announceChannelId) report.push('ℹ️ No announcement channel: set one with `/settings channel purpose:announcements`.');
  if (!c.modLogChannelId) report.push('ℹ️ No mod-log channel: set one with `/settings channel purpose:mod-log`.');
  return report;
}
