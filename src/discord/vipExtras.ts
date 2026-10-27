// Lounge buttons for the VIP extras: give a treat (member picker) and suggest a
// colour (form), plus the staff Approve/Decline buttons on colour requests in the
// mod-log. Fixed custom IDs, so they work after a restart.
import { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder } from 'discord.js';
import { COLOUR_REQUEST_APPROVE_ID, COLOUR_REQUEST_DECLINE_ID } from '../services/colourRequests.js';
import { VIP_COLOUR_REQUEST_ID, VIP_TREAT_ID } from '../services/panels.js';
import type { ButtonHandler, ModalHandler, UserSelectHandler } from './buttons.js';

const TREAT_PICK_ID = 'vip:treat-pick';
const COLOUR_REQUEST_MODAL_ID = 'vip:colour-request-modal';

export const treatButton: ButtonHandler = {
  id: VIP_TREAT_ID,
  async run(interaction, ctx) {
    const access = await ctx.treats.access(interaction.user.id);
    if (!access.ok) {
      await interaction.reply({ content: access.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const menu = new UserSelectMenuBuilder().setCustomId(TREAT_PICK_ID).setPlaceholder('🦴 Who gets your treat today?').setMinValues(1).setMaxValues(1);
    await interaction.reply({ content: '🦴 Pick someone to get today’s treat. Carter will announce it in main chat (no ping).', components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu)], flags: MessageFlags.Ephemeral });
  },
};

export const treatPick: UserSelectHandler = {
  id: TREAT_PICK_ID,
  async run(interaction, ctx) {
    await interaction.deferUpdate();
    const target = interaction.values[0];
    await interaction.editReply({ content: target ? await ctx.treats.give(interaction.user.id, target) : 'Nobody picked.', components: [] });
  },
};

const field = (id: string, label: string, placeholder: string, max: number) =>
  new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max).setPlaceholder(placeholder));

export const colourRequestButton: ButtonHandler = {
  id: VIP_COLOUR_REQUEST_ID,
  async run(interaction, ctx) {
    const access = await ctx.colourRequests.access(interaction.user.id);
    if (!access.ok) {
      await interaction.reply({ content: access.message, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(COLOUR_REQUEST_MODAL_ID)
        .setTitle('🎨 Suggest a VIP colour')
        .addComponents(field('name', 'Colour name', 'e.g. Peach Fizz', 24), field('hex', 'First colour (hex)', '#FFB38A', 7), field('hex2', 'Second colour (hex, for the gradient)', '#FF6FB5', 7)),
    );
  },
};

export const colourRequestModal: ModalHandler = {
  id: COLOUR_REQUEST_MODAL_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const get = (id: string) => interaction.fields.getTextInputValue(id);
    await interaction.editReply(await ctx.colourRequests.submit(interaction.user.id, { name: get('name'), hex: get('hex'), hex2: get('hex2') }));
  },
};

const decide = (id: string, approve: boolean): ButtonHandler => ({
  id,
  level: 'staff',
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = await ctx.colourRequests.decide(interaction.message.id, interaction.user.id, approve);
    // Decided (now or earlier): the buttons go, so nobody clicks them again.
    if (!reply.startsWith('❌')) await interaction.message.edit({ components: [] }).catch(() => undefined);
    await interaction.editReply(reply);
  },
});

export const colourRequestApprove = decide(COLOUR_REQUEST_APPROVE_ID, true);
export const colourRequestDecline = decide(COLOUR_REQUEST_DECLINE_ID, false);
