import { codeBlock, EmbedBuilder, escapeMarkdown, userMention, type ChatInputCommandInteraction, type User } from 'discord.js';
import { dayScore } from '../../core/scoring.js';
import { loadStandings, namesFor, todayKey } from '../../db/activityRepo.js';
import { defineCommand, type AppContext } from './types.js';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export const statsCommand = defineCommand({
  name: 'stats',
  description: "The leaderboard, or one member's score, rank and 7-day breakdown",
  levels: { default: 'staff' },
  build: (b) =>
    b
      .addUserOption((o) => o.setName('user').setDescription('Member (leave empty for the leaderboard)'))
      .addIntegerOption((o) => o.setName('count').setDescription('Leaderboard size (default 10)').setMinValue(1).setMaxValue(25)),
  async execute(interaction, ctx) {
    const user = interaction.options.getUser('user');
    await (user ? memberStats(interaction, ctx, user) : leaderboard(interaction, ctx));
  },
});

async function memberStats(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext, user: User): Promise<void> {
  await ctx.activity.flush(ctx.db).catch(() => undefined); // show the latest counts if the DB is up
  const config = ctx.config.current;
  const { window, ranked } = await loadStandings(ctx.db, config);
  const today = todayKey(config);
  const [days, todayRow, adjustments] = await Promise.all([
    ctx.db.activityDay.findMany({ where: { userId: user.id, serverDay: { in: window } } }),
    ctx.db.activityDay.findUnique({ where: { userId_serverDay: { userId: user.id, serverDay: today } } }),
    ctx.db.activityAdjustment.findMany({ where: { userId: user.id, serverDay: { in: window } } }),
  ]);

  const index = ranked.findIndex((s) => s.userId === user.id);
  const me = ranked[index];
  const tenth = ranked[9];
  const byDay = new Map(days.map((d) => [d.serverDay, d]));
  const vw = config.guild.voiceWeight;

  const rows = window.map((day) => {
    const d = byDay.get(day);
    return `${day}  ${String(d?.messages ?? 0).padStart(4)}  ${fmt(d?.weightedMessages ?? 0).padStart(6)}  ${String(d?.voiceMinutes ?? 0).padStart(5)}  ${String(d?.filteredMessages ?? 0).padStart(4)}  ${fmt(d ? dayScore(d, vw) : 0).padStart(6)}`;
  });
  const table = ['day         msgs  weight  voice  spam   score', ...rows].join('\n');
  const adjTotal = adjustments.reduce((sum, a) => sum + a.amount, 0);

  const vip = ctx.vip.vips.get(user.id);
  const badgeNames = (await ctx.db.userBadge.findMany({ where: { userId: user.id }, include: { badge: true }, orderBy: { awardedAt: 'asc' } })).map((b) => b.badge.name);
  const stints = await ctx.db.vipStint.findMany({ where: { userId: user.id }, orderBy: { startedAt: 'asc' } });
  const firstVip = stints[0]?.startedAt;
  const vipLine = [
    vip ? `⭐ VIP since ${vip.since}${vip.pinned ? ' (📌 pinned)' : ''}` : 'Not VIP',
    firstVip ? `first VIP <t:${Math.floor(firstVip.getTime() / 1000)}:D>` : 'never VIP before',
    `${await ctx.badges.weeksHeld(user.id, ctx.clock.now())} week(s) held (not counting pinned time)`,
    badgeNames.length ? `🏅 ${badgeNames.join(', ')}` : 'no badges yet',
  ].join(' · ');

  const embed = new EmbedBuilder()
    .setTitle(`Stats for ${escapeMarkdown(user.displayName)}`)
    .setDescription(`Window: ${window[0]} to ${window.at(-1)} (last ${window.length} complete days)`)
    .addFields(
      { name: 'Score', value: fmt(me?.score ?? 0), inline: true },
      { name: 'Rank', value: me ? `#${index + 1} of ${ranked.length}` : 'unranked', inline: true },
      { name: 'Active days', value: `${me?.activeDays ?? 0}/${window.length}`, inline: true },
      {
        name: 'To reach #10',
        value: !tenth || (index >= 0 && index < 10) ? '—' : `${fmt(Math.max(0, tenth.score - (me?.score ?? 0)))} points`,
        inline: true,
      },
      { name: 'Today so far', value: fmt(todayRow ? dayScore(todayRow, vw) : 0), inline: true },
      { name: 'Adjustments', value: adjustments.length ? fmt(adjTotal) : 'none', inline: true },
      { name: 'Breakdown', value: codeBlock(table) },
      { name: 'VIP', value: vipLine, inline: false },
    )
    .setFooter({ text: `Voice minutes count ${vw} points each. "spam" = messages the spam filter didn't count.` });
  await interaction.editReply({ embeds: [embed] });
}

async function leaderboard(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext): Promise<void> {
  const count = interaction.options.getInteger('count') ?? 10;
  await ctx.activity.flush(ctx.db).catch(() => undefined);
  const { window, ranked } = await loadStandings(ctx.db, ctx.config.current);
  const top = ranked.slice(0, count);
  if (top.length === 0) {
    await interaction.editReply('No activity in the current window yet.');
    return;
  }
  const names = await namesFor(ctx.db, top.map((s) => s.userId));
  const lines = top.map(
    (s, i) => `**${i + 1}.** ${userMention(s.userId)} (${escapeMarkdown(names.get(s.userId) ?? 'unknown')}): ${fmt(s.score)} pts, ${s.activeDays} active days`,
  );
  await interaction.editReply(`**Leaderboard** (${window[0]} to ${window.at(-1)})\n${lines.join('\n')}`);
}
