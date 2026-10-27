// /bot fresh-start: owner only. Typing the server's name, then pressing Confirm
// within 5 minutes, wipes activity and VIP history (services/freshStart.ts).
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction } from 'discord.js';
import { freshStart, FRESH_START_KEEPS, FRESH_START_WIPES } from '../services/freshStart.js';
import type { ButtonHandler } from './buttons.js';
import type { AppContext } from './commands/types.js';

export const FRESH_START_CONFIRM_ID = 'bot:fresh-start:confirm';
export const FRESH_START_CANCEL_ID = 'bot:fresh-start:cancel';
const CONFIRM_WITHIN_MS = 5 * 60_000;

const normalise = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/** The command step: checks the typed name, then asks to confirm. */
export async function askFreshStart(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const typed = interaction.options.getString('server-name', true);
  if (normalise(typed) !== normalise(interaction.guild.name)) {
    await interaction.editReply(`❌ That isn't this server's name. Type it exactly (**${interaction.guild.name}**) to continue.`);
    return;
  }
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(FRESH_START_CONFIRM_ID).setLabel('Yes, wipe it and start fresh').setEmoji('🧹').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(FRESH_START_CANCEL_ID).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({
    content: [
      '⚠️ **Fresh start: this can’t be undone.** It deletes:',
      ...FRESH_START_WIPES.map((w) => `• ${w}`),
      '',
      `It keeps ${FRESH_START_KEEPS}.`,
      'VIP then warms up again: it starts after a full week of activity here.',
      '',
      'Confirm within 5 minutes.',
    ].join('\n'),
    components: [buttons],
  });
}

export const freshStartConfirm: ButtonHandler = {
  id: FRESH_START_CONFIRM_ID,
  level: 'owner',
  async run(interaction, ctx) {
    if (Date.now() - interaction.message.createdTimestamp > CONFIRM_WITHIN_MS) {
      await interaction.update({ content: '⌛ That confirmation expired. Run `/bot fresh-start` again.', components: [] });
      return;
    }
    await interaction.update({ content: '🧹 Starting fresh… this can take a minute.', components: [] });
    const counts = await freshStart(interaction.guild, depsFor(ctx, interaction.user.id), interaction.user.id);
    await ctx.modLog.post(`🧹 <@${interaction.user.id}> ran a fresh start: activity and VIP history were wiped`);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await interaction.editReply(`✅ Fresh start done (${total} saved rows removed). VIP warms up again from today. Run \`/bot setup\` if you haven't on this server yet.`);
  },
};

export const freshStartCancel: ButtonHandler = {
  id: FRESH_START_CANCEL_ID,
  level: 'owner',
  async run(interaction) {
    await interaction.update({ content: 'Cancelled. Nothing was changed.', components: [] });
  },
};

function depsFor(ctx: AppContext, actorId: string) {
  return {
    db: ctx.db,
    endCrown: async () => {
      const cur = await ctx.crown.current();
      if (cur) await ctx.crown.onVipRemoved(cur.userId, 'fresh start');
    },
    resetCustomRole: (userId: string) => ctx.crown.resetRole(userId, actorId),
    clearTitles: () => ctx.powers.clearTitles('fresh start'),
    discardPending: () => ctx.activity.discard(),
    reload: async () => {
      await ctx.vip.load();
      await ctx.vip.reconcile();
      await ctx.powers.titles();
      await ctx.colours.reconcile();
      await ctx.jester.restore();
      await ctx.speech.load();
      await ctx.polls.reconcileLocks();
      await ctx.config.load();
      await ctx.panels.ensureAll();
    },
  };
}
