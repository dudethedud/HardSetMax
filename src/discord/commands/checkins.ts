// /checkins: anyone can turn check-in DMs on or off, or see their setting (docs/SPEC.md §9).
import { defineCommand } from './types.js';

export const OPTED_OUT_TEXT = 'Done! No more check-ins ♡ Turn them back on with /checkins on';

export const checkinsCommand = defineCommand({
  name: 'checkins',
  description: 'Check-in DMs when you have been quiet for a while',
  level: 'everyone',
  build: (b) =>
    b
      .addSubcommand((s) => s.setName('on').setDescription('Get a check-in DM about upcoming events if you go quiet'))
      .addSubcommand((s) => s.setName('off').setDescription('No more check-in DMs'))
      .addSubcommand((s) => s.setName('status').setDescription('Are check-ins on for you?')),
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    if (sub === 'on') {
      await ctx.checkins.setOptOut(userId, false);
      return void (await interaction.editReply("Check-ins are on ♡ If you go quiet for a week, I might DM you about the next server event (at most once every 2 weeks). Turn them off with /checkins off"));
    }
    if (sub === 'off') {
      await ctx.checkins.setOptOut(userId, true);
      return void (await interaction.editReply(OPTED_OUT_TEXT));
    }
    const { optedOut, lastCheckinAt } = await ctx.checkins.status(userId);
    const last = lastCheckinAt ? `\nYour last check-in was <t:${Math.floor(lastCheckinAt.getTime() / 1000)}:R>.` : '';
    await interaction.editReply(optedOut ? `Check-ins are **off** for you. Turn them on with /checkins on${last}` : `Check-ins are **on** for you. Turn them off with /checkins off${last}`);
  },
});
