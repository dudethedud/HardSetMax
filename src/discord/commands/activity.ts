import { codeBlock, EmbedBuilder, escapeMarkdown, userMention } from 'discord.js';
import { dayScore } from '../../core/scoring.js';
import { loadStandings, namesFor, todayKey } from '../../db/activityRepo.js';
import { defineAdminCommand } from './types.js';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export const statsCommand = defineAdminCommand(
  'stats',
  "A member's activity score, rank and 7-day breakdown",
  (b) => b.addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
  async (interaction, ctx) => {
    const user = interaction.options.getUser('user', true);
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
    const stints = await ctx.db.vipStint.findMany({ where: { userId: user.id }, orderBy: { startedAt: 'asc' } });
    const firstVip = stints[0]?.startedAt;
    const vipLine = [
      vip ? `⭐ VIP since ${vip.since}${vip.pinned ? ' (📌 pinned)' : ''}` : 'Not VIP',
      firstVip ? `first VIP <t:${Math.floor(firstVip.getTime() / 1000)}:D>` : 'never VIP before',
      'badges: Phase 7',
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
  },
);

export const leaderboardCommand = defineAdminCommand(
  'leaderboard',
  'Top members by activity score this window',
  (b) => b.addIntegerOption((o) => o.setName('count').setDescription('How many (default 10)').setMinValue(1).setMaxValue(25)),
  async (interaction, ctx) => {
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
  },
);

export const activityCommand = defineAdminCommand(
  'activity',
  'Correct activity scores',
  (b) =>
    b.addSubcommand((s) =>
      s
        .setName('adjust')
        .setDescription("Add or remove points from a member's score (counts on today's server-day)")
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addNumberOption((o) => o.setName('amount').setDescription('Points, e.g. 25 or -10').setRequired(true).setMinValue(-1000).setMaxValue(1000))
        .addStringOption((o) => o.setName('reason').setDescription('Why (saved in the log)').setRequired(true).setMaxLength(200)),
    ),
  async (interaction, ctx) => {
    const user = interaction.options.getUser('user', true);
    const amount = interaction.options.getNumber('amount', true);
    const reason = interaction.options.getString('reason', true);
    if (amount === 0) {
      await interaction.editReply('❌ Amount must not be 0.');
      return;
    }
    if (user.bot) {
      await interaction.editReply("❌ Bots don't have activity scores.");
      return;
    }
    const serverDay = todayKey(ctx.config.current);
    await ctx.db.$transaction([
      ctx.db.activityAdjustment.create({ data: { userId: user.id, serverDay, amount, reason, actorId: interaction.user.id } }),
      ctx.db.auditLog.create({
        data: { actorId: interaction.user.id, action: 'activity.adjust', targetId: user.id, reason, data: { amount, serverDay } },
      }),
    ]);
    ctx.log.info({ actorId: interaction.user.id, userId: user.id, amount }, 'activity adjusted');
    await interaction.editReply(
      `✅ ${amount > 0 ? '+' : ''}${fmt(amount)} points for ${userMention(user.id)} on ${serverDay}. It counts toward the score once that day is in the window.`,
    );
  },
);
