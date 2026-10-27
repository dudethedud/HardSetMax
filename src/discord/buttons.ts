// Buttons and other components, by fixed custom ID (SPEC §11), so they keep working
// after restarts.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type { AccessLevel } from '../core/access.js';
import { TITLE_SLOTS } from '../core/perks.js';
import { DECREE_MAX } from '../services/crownPowers.js';
import { SHOUTOUT_MAX } from '../services/shoutouts.js';
import { ANNOUNCE_CANCEL_ID, ANNOUNCE_MODAL_ID, ANNOUNCE_SEND_ID, cancelAnnouncement, previewAnnouncement, sendAnnouncement } from './announce.js';
import { profileEmbed } from './profile.js';
import { rerunSetup, SETUP_RERUN_ID } from './setupPicks.js';
import { jesterStatus, jesterStatusModal, jesterTrick, speechOptOut, titlePerks } from './titlePerks.js';
import { crownExtraButtons, crownExtraModals } from './crownExtras.js';
import { colourRequestApprove, colourRequestButton, colourRequestDecline, colourRequestModal, treatButton, treatPick } from './vipExtras.js';
import type { FormPrefill } from '../services/crown.js';
import { COLOUR_NONE, COLOUR_PICKER_ID, CROWN_CREATE_ID, CROWN_DECREE_ID, CROWN_EDIT_ID, CROWN_TITLES_ID, VIP_PROFILE_ID, VIP_SHOUTOUT_ID } from '../services/panels.js';
import { TEMP_VOICE_CREATE_ID, TEMP_VOICE_LIMIT_ID, TEMP_VOICE_RENAME_ID } from '../services/tempVoice.js';
import { MAX_USER_LIMIT, parseUserLimit } from '../core/tempVoice.js';
import { MANUAL_RESHUFFLE_JOB } from '../services/vipService.js';
import type { AppContext } from './commands/types.js';

export const RESHUFFLE_CONFIRM_ID = 'vip:reshuffle-now:confirm';
export const RESHUFFLE_CANCEL_ID = 'vip:reshuffle-now:cancel';

export interface ButtonHandler {
  id: string;
  /** Staff, admin or owner buttons get the same runtime check as commands. Unset: anyone (the handler checks). */
  level?: AccessLevel;
  run(interaction: ButtonInteraction<'cached'>, ctx: AppContext): Promise<void>;
}

const reshuffleConfirm: ButtonHandler = {
  id: RESHUFFLE_CONFIRM_ID,
  level: 'admin',
  async run(interaction, ctx) {
    // Answer within Discord's 3 s, then do the slow part.
    await interaction.update({ content: '⏳ Running the reshuffle…', components: [] });
    const run = await ctx.vip.runReshuffle(MANUAL_RESHUFFLE_JOB, ctx.clock.now().toISOString(), interaction.user.id);
    await interaction.editReply(run.status === 'done' ? `✅ Reshuffle done: ${run.message}` : `⏭️ Skipped: ${run.message}`);
  },
};

const reshuffleCancel: ButtonHandler = {
  id: RESHUFFLE_CANCEL_ID,
  level: 'admin',
  async run(interaction) {
    await interaction.update({ content: 'Cancelled.', components: [] });
  },
};

export const CROWN_RETRY_ID = 'crown:role-retry';
export const CROWN_ICON_FIELD = 'icon';
export const CROWN_MODAL_ID = 'crown:role-modal';

/** The custom role form (SPEC §6), filled in with earlier answers when there are any. */
export function crownRoleModal(prefill: FormPrefill | null): ModalBuilder {
  const input = (id: string, label: string, opts: { min?: number; max: number; required: boolean; placeholder: string; value?: string; hint?: string }) => {
    const t = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(opts.required).setMaxLength(opts.max).setPlaceholder(opts.placeholder);
    if (opts.min) t.setMinLength(opts.min);
    if (opts.value) t.setValue(opts.value.slice(0, opts.max));
    const l = new LabelBuilder().setLabel(label).setTextInputComponent(t);
    return opts.hint ? l.setDescription(opts.hint) : l;
  };
  const upload = new FileUploadBuilder().setCustomId(CROWN_ICON_FIELD).setRequired(false).setMinValues(0).setMaxValues(1);
  return new ModalBuilder()
    .setCustomId(CROWN_MODAL_ID)
    .setTitle('👑 Your Crown role')
    .addLabelComponents(
      input('name', 'Role name', { min: 2, max: 32, required: true, placeholder: 'e.g. Sunset Club', value: prefill?.name }),
      input('hex', 'Colour (hex)', { max: 7, required: true, placeholder: '#FF8800', value: prefill?.hex }),
      input('hex2', 'Second colour (optional)', { max: 7, required: false, placeholder: '#9B8CFF', value: prefill?.hex2, hint: 'Makes a gradient on servers that have gradient roles.' }),
      input('emoji', 'Emoji icon (optional)', { max: 10, required: false, placeholder: '🔥', value: prefill?.emoji, hint: 'Role icons need Server Boost Level 2.' }),
      new LabelBuilder()
        .setLabel('Image icon (optional)')
        .setDescription(`PNG or JPG, up to 256 KB. Used instead of the emoji.${prefill?.hasImage ? ' Leave empty to keep your current image.' : ''}`)
        .setFileUploadComponent(upload),
    );
}

/** Opens the form, or explains privately why not. Must be the first reply (no defer). */
const openCrownForm = (id: string): ButtonHandler => ({
  id,
  async run(interaction, ctx) {
    const access = await ctx.crown.formAccess(interaction.user.id);
    if (!access.ok) {
      await interaction.reply({ content: access.message, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(crownRoleModal(access.prefill));
  },
});

const TEMP_VOICE_RENAME_MODAL = 'tempvoice:rename-modal';
const TEMP_VOICE_LIMIT_MODAL = 'tempvoice:limit-modal';

const tempVoiceCreate: ButtonHandler = {
  id: TEMP_VOICE_CREATE_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await ctx.tempVoice.create(interaction.user.id));
  },
};

/** Owner-only control buttons in a temp channel's chat; they open a one-field form. */
const tempVoiceControl = (id: string, modalId: string, label: string, placeholder: string, max: number): ButtonHandler => ({
  id,
  async run(interaction, ctx) {
    if (!(await ctx.tempVoice.isOwner(interaction.user.id, interaction.channelId))) {
      await interaction.reply({ content: 'Only the channel owner can do that.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(label)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('value').setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max).setPlaceholder(placeholder),
          ),
        ),
    );
  },
});

/** A one-field paragraph form. */
function textModal(id: string, title: string, label: string, max: number, placeholder: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(id)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('text').setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(max).setPlaceholder(placeholder),
      ),
    );
}

const SHOUTOUT_MODAL_ID = 'vip:shoutout-modal';
const DECREE_MODAL_ID = 'crown:decree-modal';
const TITLE_SELECT_PREFIX = 'crown:title:';

const profile: ButtonHandler = {
  id: VIP_PROFILE_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({ embeds: [await profileEmbed(ctx, interaction.user.id, interaction.member.displayName)] });
  },
};

const shoutout: ButtonHandler = {
  id: VIP_SHOUTOUT_ID,
  async run(interaction, ctx) {
    const access = await ctx.shoutouts.access(interaction.user.id);
    if (!access.ok) {
      await interaction.reply({ content: access.message, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(textModal(SHOUTOUT_MODAL_ID, '📣 VIP shoutout', 'Your shoutout (posted in main chat, no pings)', SHOUTOUT_MAX, 'GG everyone, movie night at 8!'));
  },
};

const decree: ButtonHandler = {
  id: CROWN_DECREE_ID,
  async run(interaction, ctx) {
    const access = await ctx.powers.decreeAccess(interaction.user.id);
    if (!access.ok) {
      await interaction.reply({ content: access.message, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(textModal(DECREE_MODAL_ID, '📜 The Crown’s decree', 'Your decree (one per week, no pings)', DECREE_MAX, 'By order of the Crown…'));
  },
};

/** The Crown's title picker: one member menu per title, shown privately. */
const titles: ButtonHandler = {
  id: CROWN_TITLES_ID,
  async run(interaction, ctx) {
    const cur = await ctx.crown.current();
    if (cur?.userId !== interaction.user.id) {
      await interaction.reply({ content: '👑 Only this week’s Crown holder can hand out titles.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rows = (await ctx.powers.titles()).map((t) => {
      const menu = new UserSelectMenuBuilder()
        .setCustomId(TITLE_SELECT_PREFIX + t.slot)
        .setPlaceholder(`${t.name}: pick someone`)
        .setMinValues(0)
        .setMaxValues(1);
      if (t.holderId) menu.setDefaultUsers(t.holderId);
      return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu);
    });
    await interaction.editReply({
      content: '🎖️ **Your titles** last until the end of your Crown week. Pick someone for each, or clear a menu to take a title back. Staff and bots can’t hold titles.',
      components: rows,
    });
  },
};

const announceSend: ButtonHandler = { id: ANNOUNCE_SEND_ID, level: 'owner', run: sendAnnouncement };
const setupRerun: ButtonHandler = { id: SETUP_RERUN_ID, level: 'admin', run: rerunSetup };
const announceCancel: ButtonHandler = { id: ANNOUNCE_CANCEL_ID, level: 'owner', run: cancelAnnouncement };

export const BUTTONS = new Map(
  [
    profile,
    shoutout,
    titlePerks,
    speechOptOut,
    ...crownExtraButtons,
    treatButton,
    colourRequestButton,
    colourRequestApprove,
    colourRequestDecline,
    jesterStatus,
    jesterTrick,
    decree,
    titles,
    announceSend,
    setupRerun,
    announceCancel,
    reshuffleConfirm,
    reshuffleCancel,
    openCrownForm(CROWN_CREATE_ID),
    openCrownForm(CROWN_EDIT_ID),
    openCrownForm(CROWN_RETRY_ID),
    tempVoiceCreate,
    tempVoiceControl(TEMP_VOICE_RENAME_ID, TEMP_VOICE_RENAME_MODAL, 'Channel name', 'e.g. Chill zone', 32),
    tempVoiceControl(TEMP_VOICE_LIMIT_ID, TEMP_VOICE_LIMIT_MODAL, 'User limit (0 = no limit)', `0–${MAX_USER_LIMIT}`, 2),
  ].map((b) => [b.id, b]),
);

export interface ModalHandler {
  id: string;
  /** Checked like commands. Unset: anyone (the handler checks). */
  level?: AccessLevel;
  run(interaction: ModalSubmitInteraction<'cached'>, ctx: AppContext): Promise<void>;
}

const crownModal: ModalHandler = {
  id: CROWN_MODAL_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const field = (name: string) => interaction.fields.getTextInputValue(name) ?? '';
    const file = interaction.fields.getUploadedFiles(CROWN_ICON_FIELD)?.first();
    const result = await ctx.crown.submit(
      interaction.user.id,
      { name: field('name'), hex: field('hex'), hex2: field('hex2'), emoji: field('emoji') },
      file ? { url: file.url, contentType: file.contentType, size: file.size } : null,
    );
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

const tempVoiceRename: ModalHandler = {
  id: TEMP_VOICE_RENAME_MODAL,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await ctx.tempVoice.rename(interaction.user.id, interaction.channelId ?? '', interaction.fields.getTextInputValue('value')));
  },
};

const tempVoiceLimit: ModalHandler = {
  id: TEMP_VOICE_LIMIT_MODAL,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const limit = parseUserLimit(interaction.fields.getTextInputValue('value'));
    if (limit === null) {
      await interaction.editReply(`❌ Enter a number from 0 to ${MAX_USER_LIMIT} (0 = no limit).`);
      return;
    }
    await interaction.editReply(await ctx.tempVoice.setLimit(interaction.user.id, interaction.channelId ?? '', limit));
  },
};

const shoutoutModal: ModalHandler = {
  id: SHOUTOUT_MODAL_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await ctx.shoutouts.post(interaction.user.id, interaction.fields.getTextInputValue('text')));
  },
};

const decreeModal: ModalHandler = {
  id: DECREE_MODAL_ID,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await ctx.powers.decree(interaction.user.id, interaction.fields.getTextInputValue('text')));
  },
};

const announceModal: ModalHandler = { id: ANNOUNCE_MODAL_ID, level: 'owner', run: previewAnnouncement };

export const MODALS = new Map([crownModal, tempVoiceRename, tempVoiceLimit, shoutoutModal, decreeModal, jesterStatusModal, colourRequestModal, ...crownExtraModals, announceModal].map((m) => [m.id, m]));

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

export interface UserSelectHandler {
  id: string;
  run(interaction: UserSelectMenuInteraction<'cached'>, ctx: AppContext): Promise<void>;
}

const titleSelect = (slot: string): UserSelectHandler => ({
  id: TITLE_SELECT_PREFIX + slot,
  async run(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await ctx.powers.appoint(interaction.user.id, slot, interaction.values[0] ?? null));
  },
});

export const USER_SELECTS = new Map([...TITLE_SLOTS.map((t) => titleSelect(t.slot)), treatPick].map((h) => [h.id, h]));
