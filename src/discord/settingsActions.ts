// Saving channel and role settings, shared by /settings and the /bot setup menus.
import { channelMention, roleMention, type Guild } from 'discord.js';
import { bindRoleError } from '../core/reuse.js';
import { rolesInUse } from '../services/reuse.js';
import type { AppContext } from './commands/types.js';

export const CHANNEL_FIELDS = {
  announcements: 'announceChannelId',
  'mod-log': 'modLogChannelId',
  polls: 'pollsChannelId',
  'main-chat': 'mainChatChannelId',
  'vip-board': 'vipBoardChannelId',
} as const;
export type ChannelSetting = keyof typeof CHANNEL_FIELDS;

/** Saves a channel setting. Returns the reply. */
export async function setChannel(ctx: AppContext, guildId: string, purpose: ChannelSetting, channelId: string, actorId: string): Promise<string> {
  const field = CHANNEL_FIELDS[purpose];
  const old = ctx.config.current.guild[field];
  await ctx.db.$transaction([
    ctx.db.guildConfig.update({ where: { guildId }, data: { [field]: channelId } }),
    ctx.db.auditLog.create({ data: { action: 'config.channel', actorId, targetId: channelId, data: { purpose, old } } }),
  ]);
  await ctx.config.load();
  if (purpose === 'vip-board') await ctx.panels.refresh('vip-board');
  const note = purpose === 'polls' || purpose === 'vip-board' ? '. Run `/bot setup` to set its permissions.' : '';
  return `✅ ${purpose} channel: ${channelMention(channelId)}${note}`;
}

/** Why a role can't be used for a setting (bot roles, roles above the bot, roles in use), or null. */
export async function roleSettingError(ctx: AppContext, guild: Guild, roleId: string, currentId: string | null): Promise<string | null> {
  const used = await rolesInUse(ctx.db, ctx.config.current.guild);
  if (currentId) used.delete(currentId);
  const botTop = (guild.members.me ?? (await guild.members.fetchMe())).roles.highest;
  const live = guild.roles.cache.get(roleId);
  return live
    ? bindRoleError({ id: live.id, managed: live.managed, position: live.position }, { everyoneId: guild.id, botTopPosition: botTop.position, usedElsewhere: used.has(live.id) })
    : 'That role no longer exists.';
}

/** Saves the Polls role or the top level role. Returns the reply. */
export async function setRoleSetting(ctx: AppContext, guild: Guild, which: 'polls' | 'level-top', roleId: string, actorId: string): Promise<string> {
  const field = which === 'polls' ? 'pollsRoleId' : 'levelRolesTopId';
  const error = await roleSettingError(ctx, guild, roleId, ctx.config.current.guild[field]);
  if (error) return `❌ ${error}${which === 'level-top' ? ' Pick the role VIP should sit directly above, e.g. your highest colour or level role.' : ''}`;
  await ctx.db.$transaction([
    ctx.db.guildConfig.update({ where: { guildId: guild.id }, data: { [field]: roleId } }),
    ctx.db.auditLog.create({ data: { action: which === 'polls' ? 'config.polls-role' : 'config.level-roles-top', actorId, targetId: roleId } }),
  ]);
  await ctx.config.load();
  return which === 'polls'
    ? `✅ Polls role: ${roleMention(roleId)}. Run \`/bot setup\` so only the bot can ping it.`
    : `✅ Top level role: ${roleMention(roleId)}. Run \`/bot setup\` to move the VIP role above it.`;
}
