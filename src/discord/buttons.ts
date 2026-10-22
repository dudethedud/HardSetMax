// Buttons and other components, by fixed custom ID (SPEC §11), so they keep working
// after restarts. Later phases add member-facing panel buttons here.
import { MessageFlags, type ButtonInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { COLOUR_NONE, COLOUR_PICKER_ID } from '../services/panels.js';
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

export const BUTTONS = new Map([reshuffleConfirm, reshuffleCancel].map((b) => [b.id, b]));

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
