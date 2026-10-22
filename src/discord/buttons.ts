// Buttons and other components, by fixed custom ID (SPEC §11), so they keep working
// after restarts. Later phases add member-facing panel buttons here.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { FormPrefill } from '../services/crown.js';
import { COLOUR_NONE, COLOUR_PICKER_ID, CROWN_CREATE_ID, CROWN_EDIT_ID } from '../services/panels.js';
import { MANUAL_RESHUFFLE_JOB } from '../services/vipService.js';
import type { AppContext } from './commands/types.js';

export const RESHUFFLE_CONFIRM_ID = 'vip:reshuffle-now:confirm';
export const RESHUFFLE_CANCEL_ID = 'vip:reshuffle-now:cancel';

export interface ButtonHandler {
  id: string;
  /** Admin-only buttons get the same runtime admin check as commands. */
  adminOnly: boolean;
  run(interaction: ButtonInteraction<'cached'>, ctx: AppContext): Promise<void>;
}

const reshuffleConfirm: ButtonHandler = {
  id: RESHUFFLE_CONFIRM_ID,
  adminOnly: true,
  async run(interaction, ctx) {
    // Answer within Discord's 3 s, then do the slow part.
    await interaction.update({ content: '⏳ Running the reshuffle…', components: [] });
    const run = await ctx.vip.runReshuffle(MANUAL_RESHUFFLE_JOB, ctx.clock.now().toISOString(), interaction.user.id);
    await interaction.editReply(run.status === 'done' ? `✅ Reshuffle done: ${run.message}` : `⏭️ Skipped: ${run.message}`);
  },
};

const reshuffleCancel: ButtonHandler = {
  id: RESHUFFLE_CANCEL_ID,
  adminOnly: true,
  async run(interaction) {
    await interaction.update({ content: 'Cancelled.', components: [] });
  },
};

export const CROWN_RETRY_ID = 'crown:role-retry';
export const CROWN_MODAL_ID = 'crown:role-modal';

/** The custom role form (SPEC §6), filled in with earlier answers when there are any. */
export function crownRoleModal(prefill: FormPrefill | null): ModalBuilder {
  const input = (id: string, label: string, opts: { min?: number; max: number; required: boolean; placeholder: string; value?: string }) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(opts.required).setMaxLength(opts.max).setPlaceholder(opts.placeholder);
    if (opts.min) t.setMinLength(opts.min);
    if (opts.value) t.setValue(opts.value.slice(0, opts.max));
    return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
  };
  return new ModalBuilder()
    .setCustomId(CROWN_MODAL_ID)
    .setTitle('👑 Your Crown role')
    .addComponents(
      input('name', 'Role name', { min: 2, max: 32, required: true, placeholder: 'e.g. Sunset Club', value: prefill?.name }),
      input('hex', 'Colour (hex)', { max: 7, required: true, placeholder: '#FF8800', value: prefill?.hex }),
      input('emoji', 'Emoji icon (optional, needs Boost Level 2)', { max: 10, required: false, placeholder: '🔥', value: prefill?.emoji }),
    );
}

/** Opens the form, or explains privately why not. Must be the first reply (no defer). */
const openCrownForm = (id: string): ButtonHandler => ({
  id,
  adminOnly: false,
  async run(interaction, ctx) {
    const access = await ctx.crown.formAccess(interaction.user.id);
    if (!access.ok) {
      await interaction.reply({ content: access.message, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(crownRoleModal(access.prefill));
  },
});

export const BUTTONS = new Map(
  [reshuffleConfirm, reshuffleCancel, openCrownForm(CROWN_CREATE_ID), openCrownForm(CROWN_EDIT_ID), openCrownForm(CROWN_RETRY_ID)].map((b) => [b.id, b]),
);

export interface ModalHandler {
  id: string;
  run(interaction: ModalSubmitInteraction<'cached'>, ctx: AppContext): Promise<void>;
}

const crownModal: ModalHandler = {
  id: CROWN_MODAL_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const field = (name: string) => interaction.fields.getTextInputValue(name) ?? '';
    const result = await ctx.crown.submit(interaction.user.id, { name: field('name'), hex: field('hex'), emoji: field('emoji') });
    if (result.ok) {
      await interaction.editReply(result.message);
      return;
    }
    // Discord can't open a form from a form, so offer a button that reopens it filled in.
    const retry = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(CROWN_RETRY_ID).setLabel('Try again').setStyle(ButtonStyle.Primary),
    );
    await interaction.editReply({ content: `Couldn't save your role:\n${result.errors.map((e) => `• ${e}`).join('\n')}`, components: [retry] });
  },
};

export const MODALS = new Map([crownModal].map((m) => [m.id, m]));

export interface SelectHandler {
  id: string;
  run(interaction: StringSelectMenuInteraction<'cached'>, ctx: AppContext): Promise<void>;
}

const colourPicker: SelectHandler = {
  id: COLOUR_PICKER_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const value = interaction.values[0];
    const optionId = !value || value === COLOUR_NONE ? null : Number(value);
    await interaction.editReply(await ctx.colours.pick(interaction.user.id, Number.isInteger(optionId) ? optionId : null));
    // Reset the dropdown so the same colour can be picked again later.
    await interaction.message.edit({ components: interaction.message.components }).catch(() => undefined);
  },
};

export const SELECTS = new Map([colourPicker].map((s) => [s.id, s]));
