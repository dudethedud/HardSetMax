// The VIP board's "Titles & perks" button: what each title does, and the buttons
// for the title someone holds. Titles holders without the lounge (Advisor, Jester)
// use their perks from here. Fixed custom IDs, so they work after a restart.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { JESTER_STATUS_MAX, TITLE_SLOTS } from '../core/perks.js';
import { VIP_SHOUTOUT_ID } from '../services/panels.js';
import { TITLE_PERKS_ID } from '../services/vipBoard.js';
import type { ButtonHandler, ModalHandler } from './buttons.js';

export const JESTER_STATUS_ID = 'jester:status';
export const JESTER_TRICK_ID = 'jester:trick';
export const SPEECH_OPT_OUT_ID = 'speech:opt-out';
const JESTER_STATUS_MODAL_ID = 'jester:status-modal';

const button = (id: string, label: string, emoji: string, style = ButtonStyle.Primary) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

export const titlePerks: ButtonHandler = {
  id: TITLE_PERKS_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await ctx.powers.titles();
    const slot = ctx.powers.titleOf(interaction.user.id);
    const lines = [
      '🎖️ **Titles** are handed out by the 👑 Crown for their week. Each has a job:',
      ...TITLE_SLOTS.map((t) => `${t.name}: ${t.job}`),
      '',
      '⭐ **VIPs** (the most active members) get colours, a daily shoutout, polls, VIP voice and the VIP Lounge. 👑 The **Crown** is the top VIP each week.',
    ];
    const row = new ActionRowBuilder<ButtonBuilder>();
    const cfg = ctx.config.current.guild;
    if (slot) lines.push('', `You're the **${TITLE_SLOTS.find((t) => t.slot === slot)!.name}** this week!`);
    if (slot === 'jester') row.addComponents(button(JESTER_STATUS_ID, "Set Carter's status", '💬'), button(JESTER_TRICK_ID, 'Make Carter do a trick', '🦴', ButtonStyle.Success));
    if (slot === 'advisor') {
      row.addComponents(button(VIP_SHOUTOUT_ID, 'Shoutout', '📣'));
      if (cfg.pollsChannelId) lines.push(`Post your polls in <#${cfg.pollsChannelId}> (they share the VIPs' daily limit).`);
    }
    if (slot === 'champion' && cfg.loungePerksId) lines.push(`Your guest pass is active: head to <#${cfg.loungePerksId}>.`);
    // Everyone can turn rainbow speech off (or back on) for themselves.
    const optedOut = await ctx.speech.isOptedOut(interaction.user.id);
    const optRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(SPEECH_OPT_OUT_ID, optedOut ? 'Allow rainbow speech on me' : 'Opt out of rainbow speech', '🌈', ButtonStyle.Secondary),
    );
    await interaction.editReply({ content: lines.join('\n'), components: [...(row.components.length ? [row] : []), optRow] });
  },
};

export const speechOptOut: ButtonHandler = {
  id: SPEECH_OPT_OUT_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await ctx.speech.toggleOptOut(interaction.user.id));
  },
};

export const jesterStatus: ButtonHandler = {
  id: JESTER_STATUS_ID,
  async run(interaction, ctx) {
    const access = await ctx.jester.statusAccess(interaction.user.id);
    if (!access.ok) {
      await interaction.reply({ content: access.message, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(JESTER_STATUS_MODAL_ID)
        .setTitle("🃏 Puppyboy Carter's status")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('text').setLabel('His new status (everyone sees it)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(JESTER_STATUS_MAX).setPlaceholder('chewing on the Crown’s shoe'),
          ),
        ),
    );
  },
};

export const jesterTrick: ButtonHandler = {
  id: JESTER_TRICK_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await ctx.jester.trick(interaction.user.id));
  },
};

export const jesterStatusModal: ModalHandler = {
  id: JESTER_STATUS_MODAL_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await ctx.jester.setStatus(interaction.user.id, interaction.fields.getTextInputValue('text')));
  },
};
