// Lounge buttons for the Crown extras: pardon, mood, spotlight, theme and the 🌈
// speech filter, each a single form; plus the staff Stop button on speech filter
// entries in the mod-log. Fixed custom IDs, so they work after a restart.
import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { MOODS, SPOTLIGHT_MAX, THEME_MAX } from '../core/crownExtras.js';
import { CROWN_MOOD_ID, CROWN_PARDON_ID, CROWN_RAINBOW_ID, CROWN_SPOTLIGHT_ID, CROWN_THEME_ID } from '../services/panels.js';
import { SPEECH_STOP_ID } from '../services/speechFilter.js';
import type { ButtonHandler, ModalHandler } from './buttons.js';
import type { AppContext } from './commands/types.js';

const MODAL = { pardon: 'crown:pardon-modal', mood: 'crown:mood-modal', spotlight: 'crown:spotlight-modal', theme: 'crown:theme-modal', rainbow: 'crown:rainbow-modal' } as const;

const userField = (label: string, description: string) =>
  new LabelBuilder().setLabel(label).setDescription(description).setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('user').setMinValues(1).setMaxValues(1));
const textField = (label: string, max: number, placeholder: string) =>
  new LabelBuilder().setLabel(label).setTextInputComponent(new TextInputBuilder().setCustomId('text').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max).setPlaceholder(placeholder));

type Access = (ctx: AppContext, userId: string) => Promise<{ ok: true } | { ok: false; message: string }>;

/** A Crown button: checks access, then opens its form. Must be the first reply (no defer). */
const opener = (id: string, access: Access, modal: () => ModalBuilder): ButtonHandler => ({
  id,
  async run(interaction, ctx) {
    const a = await access(ctx, interaction.user.id);
    if (!a.ok) {
      await interaction.reply({ content: a.message, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(modal());
  },
});

export const crownExtraButtons: ButtonHandler[] = [
  opener(CROWN_PARDON_ID, (ctx, u) => ctx.crownExtras.access(u, 'pardon'), () =>
    new ModalBuilder().setCustomId(MODAL.pardon).setTitle('🛡️ Royal pardon').addLabelComponents(userField('Which VIP is safe at the next reshuffle?', 'One per Crown week. They can’t be dropped for rank or inactivity.')),
  ),
  opener(CROWN_MOOD_ID, (ctx, u) => ctx.crownExtras.access(u, 'mood'), () =>
    new ModalBuilder()
      .setCustomId(MODAL.mood)
      .setTitle("🎭 Carter's mood this week")
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Pick a mood')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder().setCustomId('mood').addOptions(MOODS.map((m) => new StringSelectMenuOptionBuilder().setLabel(m.label).setValue(m.key).setEmoji(m.emoji))),
          ),
      ),
  ),
  opener(CROWN_SPOTLIGHT_ID, (ctx, u) => ctx.crownExtras.access(u, 'spotlight'), () =>
    new ModalBuilder()
      .setCustomId(MODAL.spotlight)
      .setTitle('📌 Spotlight')
      .addLabelComponents(userField('Who goes on the VIP board?', 'One spotlight a day. Anyone but bots.'), textField('Why? (shown on the board, no pings)', SPOTLIGHT_MAX, 'carried the movie night vc')),
  ),
  opener(CROWN_THEME_ID, (ctx, u) => ctx.crownExtras.access(u, 'theme'), () =>
    new ModalBuilder().setCustomId(MODAL.theme).setTitle('🎵 Theme of the week').addLabelComponents(textField('Theme or word of the week', THEME_MAX, 'spooky season 🎃')),
  ),
  opener(CROWN_RAINBOW_ID, (ctx, u) => ctx.speech.crownAccess(u), () =>
    new ModalBuilder()
      .setCustomId(MODAL.rainbow)
      .setTitle('🌈 Rainbow speech')
      .addLabelComponents(userField('Whose messages get rainbow flair?', 'For 10 minutes, once per Crown week. Not staff or the owner. It’s logged.')),
  ),
  {
    id: SPEECH_STOP_ID,
    level: 'staff',
    async run(interaction, ctx) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reply = await ctx.speech.stopFromLog(interaction.message.embeds[0]?.description ?? '', interaction.user.id);
      await interaction.message.edit({ components: [] }).catch(() => undefined);
      await interaction.editReply(reply);
    },
  },
];

const pickedUser = (interaction: Parameters<ModalHandler['run']>[0]) => interaction.fields.getSelectedUsers('user')?.first()?.id ?? null;

const submit = (id: string, run: (interaction: Parameters<ModalHandler['run']>[0], ctx: AppContext) => Promise<string>): ModalHandler => ({
  id,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await run(interaction, ctx));
  },
});

export const crownExtraModals: ModalHandler[] = [
  submit(MODAL.pardon, (i, ctx) => {
    const u = pickedUser(i);
    return u ? ctx.crownExtras.pardon(i.user.id, u) : Promise.resolve('Nobody picked.');
  }),
  submit(MODAL.mood, (i, ctx) => ctx.crownExtras.setMood(i.user.id, i.fields.getStringSelectValues('mood')[0] ?? '')),
  submit(MODAL.spotlight, (i, ctx) => {
    const u = pickedUser(i);
    return u ? ctx.crownExtras.spotlight(i.user.id, u, i.fields.getTextInputValue('text')) : Promise.resolve('Nobody picked.');
  }),
  submit(MODAL.theme, (i, ctx) => ctx.crownExtras.setTheme(i.user.id, i.fields.getTextInputValue('text'))),
  submit(MODAL.rainbow, (i, ctx) => {
    const u = pickedUser(i);
    return u ? ctx.speech.start(i.user.id, u, true) : Promise.resolve('Nobody picked.');
  }),
];
