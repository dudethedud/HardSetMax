import { ActionRowBuilder, ButtonBuilder, ButtonStyle, userMention, type SlashCommandUserOption } from 'discord.js';
import { describeAdd, describeRemove, formatScore } from '../../core/reshuffle.js';
import { serverDayAt, serverDaysBetween } from '../../core/serverDay.js';
import { todayKey } from '../../db/activityRepo.js';
import { RESHUFFLE_CANCEL_ID, RESHUFFLE_CONFIRM_ID } from '../buttons.js';
import { defineCommand } from './types.js';

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const member = (o: SlashCommandUserOption) => o.setName('user').setDescription('Which member').setRequired(true);

export const vipCommand = defineCommand({
  name: 'vip',
  description: 'VIPs, polls, the Crown and activity scores',
  levels: {
    default: 'admin',
    list: 'staff',
    preview: 'staff',
    polls: 'staff',
    crown: 'staff',
  },
  build: (b) =>
    b
      .addSubcommand((s) => s.setName('list').setDescription('Current VIPs with rank, score and days held'))
      .addSubcommand((s) => s.setName('preview').setDescription('What a reshuffle would do now, plus ranks 11–15'))
      .addSubcommand((s) => s.setName('polls').setDescription('Polls used today, who posted, who is locked, when it resets'))
      .addSubcommand((s) => s.setName('crown').setDescription('Current Crown holder, their custom role and titles'))
      .addSubcommand((s) => s.setName('pin').setDescription('Admin: lock someone into VIP (gives VIP now if they don’t have it)').addUserOption(member))
      .addSubcommand((s) => s.setName('unpin').setDescription('Admin: unlock a pinned VIP (the next reshuffle decides)').addUserOption(member))
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Admin: remove VIP now, optionally blocking them from VIP')
          .addUserOption(member)
          .addIntegerOption((o) => o.setName('block_days').setDescription('Block from VIP for this many days').setMinValue(1).setMaxValue(365)),
      )
      .addSubcommand((s) => s.setName('unblock').setDescription('Admin: clear a VIP block').addUserOption(member))
      .addSubcommand((s) => s.setName('reshuffle').setDescription('Admin: run the reshuffle now (asks to confirm)'))
      .addSubcommand((s) =>
        s
          .setName('adjust')
          .setDescription("Admin: add or remove points from a member's score (counts on today's server-day)")
          .addUserOption(member)
          .addNumberOption((o) => o.setName('amount').setDescription('Points, e.g. 25 or -10').setRequired(true).setMinValue(-1000).setMaxValue(1000))
          .addStringOption((o) => o.setName('reason').setDescription('Why (saved in the log)').setRequired(true).setMaxLength(200)),
      )
      .addSubcommand((s) =>
        s
          .setName('poll-unlock')
          .setDescription('Admin: give a VIP one more poll today (works even past the daily limit)')
          .addUserOption((o) => o.setName('user').setDescription('VIP').setRequired(true)),
      )
      .addSubcommand((s) => s.setName('crown-give').setDescription('Admin: give this week’s Crown to a VIP now (e.g. for testing)').addUserOption(member))
      .addSubcommand((s) => s.setName('crown-reset').setDescription('Admin: delete a custom role and its saved settings').addUserOption(member))
      .addSubcommand((s) =>
        s
          .setName('crown-lock')
          .setDescription('Admin: block or allow someone creating or editing a custom role')
          .addUserOption(member)
          .addBooleanOption((o) => o.setName('locked').setDescription('True blocks, false allows').setRequired(true)),
      ),
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const actor = interaction.user.id;
    const now = ctx.clock.now();

    if (sub === 'list' || sub === 'preview') {
      await ctx.activity.flush(ctx.db).catch(() => undefined);
      const result = await ctx.vip.preview(now);
      const rankOf = new Map(result.ranked.map((c, i) => [c.userId, i + 1]));
      const scoreOf = new Map(result.ranked.map((c) => [c.userId, c.score]));

      if (sub === 'list') {
        const today = serverDayAt(now, ctx.config.current.boundary).key;
        const vips = [...ctx.vip.vips].sort(([a], [b]) => (rankOf.get(a) ?? Infinity) - (rankOf.get(b) ?? Infinity));
        if (!vips.length) {
          await interaction.editReply('No VIPs right now.');
          return;
        }
        const lines = vips.map(([id, v]) => {
          const rank = rankOf.get(id);
          return `${rank ? `#${rank}` : 'unranked'} ${userMention(id)}: score ${formatScore(scoreOf.get(id) ?? 0)}, held ${serverDaysBetween(v.since, today)} days${v.pinned ? ' 📌' : ''}`;
        });
        await interaction.editReply(`**VIPs** (${vips.length}/${ctx.config.current.reshuffle.slots})\n${lines.join('\n')}`);
        return;
      }

      const lines = ['**Reshuffle preview** (if it ran now)'];
      if (!result.added.length && !result.removed.length) lines.push('No changes.');
      for (const a of result.added) lines.push(`➕ ${userMention(a.userId)}: ${describeAdd(a.reason)}`);
      for (const r of result.removed) lines.push(`➖ ${userMention(r.userId)}: ${describeRemove(r.reason)}`);
      lines.push('', '**Bubble watch** (ranks 11–15)');
      const bubble = result.ranked.slice(10, 15);
      if (!bubble.length) lines.push('nobody');
      bubble.forEach((c, i) => lines.push(`#${11 + i} ${userMention(c.userId)}: ${formatScore(c.score)}${ctx.vip.vips.has(c.userId) ? ' (VIP)' : ''}`));
      await interaction.editReply(lines.join('\n'));
      return;
    }

    if (sub === 'reshuffle') {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(RESHUFFLE_CONFIRM_ID).setLabel('Run reshuffle now').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(RESHUFFLE_CANCEL_ID).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({
        content: 'This applies VIP changes and posts the VIP update now. The daily reshuffle still runs at the boundary as usual. Use `/vip preview` to see what would change.',
        components: [row],
      });
      return;
    }

    if (sub === 'polls') {
      await interaction.editReply(await ctx.polls.status());
      return;
    }

    if (sub === 'crown') {
      const cur = await ctx.crown.current();
      if (!cur) {
        await interaction.editReply('Nobody holds the Crown right now.');
        return;
      }
      const custom = await ctx.db.customRole.findUnique({ where: { userId: cur.userId } });
      await interaction.editReply(
        [
          `👑 ${userMention(cur.userId)} holds the Crown for the week starting ${cur.weekStart}.`,
          custom?.roleId ? `Custom role: <@&${custom.roleId}> (${custom.hex}${custom.emoji ? ` ${custom.emoji}` : ''}), edits used this week: ${custom.editsWeek === cur.weekStart ? custom.editsCount : 0}/3` : 'No custom role yet.',
          custom?.locked ? '🔒 Custom roles are locked for them.' : '',
          cur.decreeAt ? `📜 Decree used <t:${Math.floor(cur.decreeAt.getTime() / 1000)}:R>` : '📜 Decree not used yet',
          ...(await ctx.powers.titles()).map((t) => `🎖️ ${t.name}: ${t.holderId ? userMention(t.holderId) : 'nobody'}`),
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }

    if (sub === 'adjust') {
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
      return;
    }

    const user = interaction.options.getUser('user', true);

    if (sub === 'crown-give') {
      if (!ctx.vip.vips.has(user.id)) {
        await interaction.editReply(`❌ ${userMention(user.id)} isn't VIP. The Crown only goes to VIPs; use \`/vip pin\` first.`);
        return;
      }
      await interaction.editReply(await ctx.crown.giveManually(user.id, actor));
      return;
    }

    if (sub === 'crown-reset') {
      const done = await ctx.crown.resetRole(user.id, actor);
      await interaction.editReply(done ? `✅ ${userMention(user.id)}'s custom role and saved settings were deleted.` : `${userMention(user.id)} had no custom role.`);
      return;
    }

    if (sub === 'crown-lock') {
      const locked = interaction.options.getBoolean('locked', true);
      await ctx.crown.setLocked(user.id, locked, actor);
      await interaction.editReply(locked ? `🔒 ${userMention(user.id)} can't create or edit a custom role.` : `🔓 ${userMention(user.id)} can create a custom role again.`);
      return;
    }

    if (sub === 'poll-unlock') {
      if (!ctx.vip.vips.has(user.id)) {
        await interaction.editReply(`❌ ${userMention(user.id)} isn't VIP.`);
        return;
      }
      await interaction.editReply(await ctx.polls.grantExtra(user.id, actor));
      return;
    }

    if (user.bot) {
      await interaction.editReply("❌ Bots can't be VIP.");
      return;
    }
    const v = ctx.vip.vips.get(user.id);

    if (sub === 'pin') {
      if (v?.pinned) await interaction.editReply(`${userMention(user.id)} is already pinned.`);
      else if (v) {
        await ctx.vip.setPinned(user.id, true, actor);
        await interaction.editReply(`📌 ${userMention(user.id)} is now pinned.`);
      } else {
        await ctx.vip.addVip(user.id, `pinned by <@${actor}>`, true, actor);
        await interaction.editReply(`📌 ${userMention(user.id)} is now VIP and pinned.`);
      }
      return;
    }

    if (sub === 'unpin') {
      if (!v?.pinned) await interaction.editReply(`${userMention(user.id)} isn't pinned.`);
      else {
        await ctx.vip.setPinned(user.id, false, actor);
        await interaction.editReply(`📍 ${userMention(user.id)} is unpinned. They stay VIP until a reshuffle removes them.`);
      }
      return;
    }

    if (sub === 'remove') {
      const days = interaction.options.getInteger('block_days');
      const removed = await ctx.vip.removeVip(user.id, `removed by <@${actor}>`, actor);
      if (days) {
        const until = new Date(now.getTime() + days * 86_400_000);
        const reason = `blocked by <@${actor}> for ${days} days`;
        await ctx.db.$transaction([
          ctx.db.vipBlock.upsert({ where: { userId: user.id }, create: { userId: user.id, until, reason, actorId: actor }, update: { until, reason, actorId: actor } }),
          ctx.db.auditLog.create({ data: { action: 'vip.block', actorId: actor, targetId: user.id, reason, data: { until: until.toISOString() } } }),
        ]);
        await ctx.modLog.post(`⛔ <@${user.id}> blocked from VIP until <t:${Math.floor(until.getTime() / 1000)}:f> by <@${actor}>`);
      }
      await interaction.editReply(
        `${removed ? `🔻 Removed VIP from ${userMention(user.id)}.` : `${userMention(user.id)} wasn't VIP.`}${days ? ` Blocked from VIP for ${days} days.` : ''}`,
      );
      return;
    }

    if (sub === 'unblock') {
      const { count } = await ctx.db.vipBlock.deleteMany({ where: { userId: user.id } });
      if (count) {
        await ctx.db.auditLog.create({ data: { action: 'vip.unblock', actorId: actor, targetId: user.id } });
        await ctx.modLog.post(`✅ <@${user.id}> unblocked from VIP by <@${actor}>`);
      }
      await interaction.editReply(count ? `✅ ${userMention(user.id)} can be VIP again.` : `${userMention(user.id)} wasn't blocked.`);
    }
  },
});
