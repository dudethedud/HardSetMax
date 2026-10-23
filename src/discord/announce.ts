// /announce: the server owner posts an @everyone announcement as the bot.
// Command → form → private preview with Send / Cancel → posted. Owner only
// (not admins or staff), checked at every step. The draft is kept for 15 minutes
// so the buttons still work after a restart, then deleted.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { AppContext } from './commands/types.js';
import { defineCommand } from './commands/types.js';

export const ANNOUNCE_MODAL_ID = 'announce:modal';
export const ANNOUNCE_SEND_ID = 'announce:send';
export const ANNOUNCE_CANCEL_ID = 'announce:cancel';
/** Discord's 2000-character limit, minus room for "@everyone". */
export const ANNOUNCE_MAX = 1900;
const DRAFT_MINUTES = 15;

interface AnnounceDraft {
  channelId: string;
  text?: string;
}

const draftKey = (userId: string) => `announce:${userId}`;

async function loadDraft(ctx: AppContext, userId: string): Promise<AnnounceDraft | null> {
  const row = await ctx.db.modalDraft.findUnique({ where: { userId: draftKey(userId) } });
  if (!row || row.expiresAt <= ctx.clock.now()) return null;
  return row.data as unknown as AnnounceDraft;
}

async function saveDraft(ctx: AppContext, userId: string, data: AnnounceDraft): Promise<void> {
  const expiresAt = new Date(ctx.clock.now().getTime() + DRAFT_MINUTES * 60_000);
  const key = draftKey(userId);
  await ctx.db.modalDraft.upsert({ where: { userId: key }, create: { userId: key, data: { ...data }, expiresAt }, update: { data: { ...data }, expiresAt } });
}

export const announceCommand = defineCommand({
  name: 'announce',
  description: 'Owner only: post an @everyone announcement as the bot',
  levels: { default: 'owner' },
  defer: false, // the form must be the first reply
  build: (b) =>
    b.addChannelOption((o) =>
      o.setName('channel').setDescription('Where to post (default: the announcements channel)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  async execute(interaction, ctx) {
    const channelId = interaction.options.getChannel('channel')?.id ?? ctx.config.current.guild.announceChannelId;
    if (!channelId) {
      await interaction.reply({ content: '❌ No announcements channel is set. Pick a channel, or set one with `/settings channel`.', flags: MessageFlags.Ephemeral });
      return;
    }
    await saveDraft(ctx, interaction.user.id, { channelId });
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(ANNOUNCE_MODAL_ID)
        .setTitle('📢 Announcement')
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('text')
              .setLabel('Message (pings @everyone)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(ANNOUNCE_MAX),
          ),
        ),
    );
  },
});

/** Form submitted: show a private preview with Send / Cancel. */
export async function previewAnnouncement(interaction: ModalSubmitInteraction<'cached'>, ctx: AppContext): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const draft = await loadDraft(ctx, interaction.user.id);
  if (!draft) {
    await interaction.editReply('⌛ This draft expired. Run `/announce` again.');
    return;
  }
  const text = interaction.fields.getTextInputValue('text').trim();
  if (!text) {
    await interaction.editReply('❌ The announcement is empty.');
    return;
  }
  await saveDraft(ctx, interaction.user.id, { ...draft, text });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ANNOUNCE_SEND_ID).setLabel('Send and ping @everyone').setEmoji('📢').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(ANNOUNCE_CANCEL_ID).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({
    content: `**Preview** (posts in <#${draft.channelId}>, from the bot):\n\n@everyone\n${text}`.slice(0, 2000),
    components: [row],
    allowedMentions: { parse: [] },
  });
}

export async function sendAnnouncement(interaction: ButtonInteraction<'cached'>, ctx: AppContext): Promise<void> {
  await interaction.update({ content: '⏳ Sending…', components: [] });
  const draft = await loadDraft(ctx, interaction.user.id);
  if (!draft?.text) {
    await interaction.editReply('⌛ This draft expired. Run `/announce` again.');
    return;
  }
  // Delete first, so a double click can't post it twice.
  const { count } = await ctx.db.modalDraft.deleteMany({ where: { userId: draftKey(interaction.user.id) } });
  if (!count) {
    await interaction.editReply('Already sent.');
    return;
  }
  const channel = await ctx.client.channels.fetch(draft.channelId).catch(() => null);
  if (!channel?.isSendable()) {
    await interaction.editReply(`❌ Can't post in <#${draft.channelId}>. Check the bot's permissions there, then run \`/announce\` again.`);
    return;
  }
  // Only @everyone pings: names and roles in the text don't.
  const message = await channel.send({ content: `@everyone\n${draft.text}`, allowedMentions: { parse: ['everyone'] } });
  await ctx.db.auditLog.create({ data: { action: 'announce', actorId: interaction.user.id, targetId: draft.channelId, data: { messageId: message.id } } });
  await ctx.modLog.post(`📢 <@${interaction.user.id}> posted an announcement: ${message.url}`);
  await interaction.editReply(`✅ Posted: ${message.url}`);
}

export async function cancelAnnouncement(interaction: ButtonInteraction<'cached'>, ctx: AppContext): Promise<void> {
  await ctx.db.modalDraft.deleteMany({ where: { userId: draftKey(interaction.user.id) } });
  await interaction.update({ content: 'Cancelled. Nothing was posted.', components: [] });
}
