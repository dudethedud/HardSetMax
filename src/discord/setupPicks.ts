// After /bot setup: menus for anything it couldn't work out by itself (channels,
// the top level role, categories for #polls and #vip-board), plus a button to
// run setup again. Fixed custom IDs, admin only, so they work after a restart.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  RoleSelectMenuBuilder,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type Guild,
  type ChatInputCommandInteraction,
  type RoleSelectMenuInteraction,
} from 'discord.js';
import { chunkLines } from '../core/chunk.js';
import type { AppContext } from './commands/types.js';
import { setChannel, setRoleSetting, type ChannelSetting } from './settingsActions.js';

const PICK = 'setup:pick:';
export const SETUP_RERUN_ID = 'setup:rerun';

const CHANNEL_PICKS: { purpose: ChannelSetting; field: 'announceChannelId' | 'mainChatChannelId' | 'modLogChannelId'; placeholder: string }[] = [
  { purpose: 'announcements', field: 'announceChannelId', placeholder: '📢 Which channel is announcements?' },
  { purpose: 'main-chat', field: 'mainChatChannelId', placeholder: '💬 Which channel is main chat? (AI and shoutouts)' },
  { purpose: 'mod-log', field: 'modLogChannelId', placeholder: '🛡️ Which channel should the bot log to? (staff only)' },
];
const CATEGORY_PICKS = [
  { key: 'polls-category', field: 'pollsChannelId', label: '#polls' },
  { key: 'board-category', field: 'vipBoardChannelId', label: '#vip-board' },
] as const;

type Row = ActionRowBuilder<ChannelSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder>;
export interface SetupMessage {
  content?: string;
  components?: Row[];
}

/** One menu per setting setup couldn't fill, or none. */
export function setupPickRows(guild: Guild, cfg: AppContext['config']['current']['guild']): Row[] {
  const rows: Row[] = [];
  for (const p of CHANNEL_PICKS) {
    if (cfg[p.field]) continue;
    rows.push(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder().setCustomId(PICK + p.purpose).setPlaceholder(p.placeholder).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
    );
  }
  if (!cfg.levelRolesTopId) {
    rows.push(
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder().setCustomId(`${PICK}level-top`).setPlaceholder('⭐ VIP goes directly above which role? (your top level or colour role)'),
      ),
    );
  }
  for (const c of CATEGORY_PICKS) {
    const id = cfg[c.field];
    const channel = id ? guild.channels.cache.get(id) : undefined;
    if (!channel || channel.parentId) continue;
    rows.push(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder().setCustomId(PICK + c.key).setPlaceholder(`📁 Which category should ${c.label} go in?`).setChannelTypes(ChannelType.GuildCategory),
      ),
    );
  }
  return rows;
}

/** The setup report, split to fit, followed by the menus (5 rows per message). */
export function setupMessages(report: string[], rows: Row[]): SetupMessage[] {
  const text = chunkLines(report.length ? report : ['Nothing to report.'], 2000);
  const messages: SetupMessage[] = text.map((content) => ({ content }));
  if (!rows.length) return messages;
  const rerun = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(SETUP_RERUN_ID).setLabel('Run setup again').setEmoji('🔁').setStyle(ButtonStyle.Primary),
  );
  const all = [...rows, rerun];
  for (let i = 0; i < all.length; i += 5) {
    messages.push({
      ...(i === 0 ? { content: "**Setup couldn't work these out. Pick them here**, then run setup again:" } : {}),
      components: all.slice(i, i + 5),
    });
  }
  return messages;
}

/** Sends the report and menus as the reply to a deferred interaction. */
export async function sendSetupResult(
  interaction: ChatInputCommandInteraction<'cached'> | ButtonInteraction<'cached'>,
  ctx: AppContext,
  guild: Guild,
  report: string[],
): Promise<void> {
  const [first, ...rest] = setupMessages(report, setupPickRows(guild, ctx.config.current.guild));
  await interaction.editReply(first!);
  for (const m of rest) await interaction.followUp({ ...m, flags: MessageFlags.Ephemeral });
}

export interface PickHandler<I> {
  id: string;
  run(interaction: I, ctx: AppContext): Promise<void>;
}

const channelPick = (purpose: ChannelSetting): PickHandler<ChannelSelectMenuInteraction<'cached'>> => ({
  id: PICK + purpose,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channelId = interaction.values[0];
    await interaction.editReply(channelId ? await setChannel(ctx, interaction.guildId, purpose, channelId, interaction.user.id) : 'Nothing picked.');
  },
});

const categoryPick = (key: (typeof CATEGORY_PICKS)[number]['key']): PickHandler<ChannelSelectMenuInteraction<'cached'>> => ({
  id: PICK + key,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const field = CATEGORY_PICKS.find((c) => c.key === key)!.field;
    const channelId = ctx.config.current.guild[field];
    const channel = channelId ? interaction.guild.channels.cache.get(channelId) : undefined;
    const categoryId = interaction.values[0];
    if (!channel || !categoryId || !('setParent' in channel)) {
      await interaction.editReply("❌ That channel doesn't exist any more. Run setup again.");
      return;
    }
    // Keeps the channel's own permissions (e.g. #polls' posting rules).
    await channel.setParent(categoryId, { lockPermissions: false, reason: `Moved by ${interaction.user.id} from /bot setup` });
    await ctx.db.auditLog.create({ data: { action: 'setup.category', actorId: interaction.user.id, targetId: channel.id, data: { categoryId } } });
    await interaction.editReply(`📁 Moved <#${channel.id}> into ${interaction.guild.channels.cache.get(categoryId)?.name ?? 'that category'}.`);
  },
});

export const CHANNEL_PICK_HANDLERS = new Map<string, PickHandler<ChannelSelectMenuInteraction<'cached'>>>(
  [...CHANNEL_PICKS.map((p) => channelPick(p.purpose)), ...CATEGORY_PICKS.map((c) => categoryPick(c.key))].map((h) => [h.id, h]),
);

export const ROLE_PICK_HANDLERS = new Map<string, PickHandler<RoleSelectMenuInteraction<'cached'>>>([
  [
    `${PICK}level-top`,
    {
      id: `${PICK}level-top`,
      async run(interaction, ctx) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const roleId = interaction.values[0];
        await interaction.editReply(roleId ? await setRoleSetting(ctx, interaction.guild, 'level-top', roleId, interaction.user.id) : 'Nothing picked.');
      },
    },
  ],
]);

export async function rerunSetup(interaction: ButtonInteraction<'cached'>, ctx: AppContext): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await sendSetupResult(interaction, ctx, interaction.guild, await ctx.runSetup(interaction.guild));
}
