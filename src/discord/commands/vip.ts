import { ActionRowBuilder, ButtonBuilder, ButtonStyle, userMention } from 'discord.js';
import { describeAdd, describeRemove, formatScore } from '../../core/reshuffle.js';
import { serverDayAt, serverDaysBetween } from '../../core/serverDay.js';
import { formatHexColour, parseHexColour } from '../../core/vipRules.js';
import { RESHUFFLE_CANCEL_ID, RESHUFFLE_CONFIRM_ID } from '../buttons.js';
import { defineAdminCommand } from './types.js';

export const vipCommand = defineAdminCommand(
  'vip',
  'Manage VIPs',
  (b) =>
    b
      .addSubcommand((s) => s.setName('list').setDescription('Current VIPs with rank, score and days held'))
      .addSubcommand((s) => s.setName('preview').setDescription('What a reshuffle would do now, plus ranks 11–15'))
      .addSubcommand((s) =>
        s
          .setName('pin')
          .setDescription('Lock someone into VIP (gives VIP now if they don’t have it)')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('unpin')
          .setDescription('Unlock a pinned VIP (the next reshuffle decides)')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove VIP now, optionally blocking them from VIP')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('block_days').setDescription('Block from VIP for this many days').setMinValue(1).setMaxValue(365)),
      )
      .addSubcommand((s) =>
        s
          .setName('unblock')
          .setDescription('Clear a VIP block')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((s) => s.setName('reshuffle-now').setDescription('Run the reshuffle now (asks to confirm)'))
      .addSubcommandGroup((g) =>
        g
          .setName('colours')
          .setDescription('VIP colour options')
          .addSubcommand((s) => s.setName('list').setDescription('List colour options'))
          .addSubcommand((s) =>
            s
              .setName('add')
              .setDescription('Add a colour option')
              .addStringOption((o) => o.setName('name').setDescription('Name shown in the picker').setRequired(true).setMaxLength(32))
              .addStringOption((o) => o.setName('hex').setDescription('Colour, e.g. #FF8800').setRequired(true).setMaxLength(7)),
          )
          .addSubcommand((s) =>
            s
              .setName('edit')
              .setDescription('Rename or recolour an option')
              .addStringOption((o) => o.setName('name').setDescription('Current name').setRequired(true).setMaxLength(32))
              .addStringOption((o) => o.setName('new_name').setDescription('New name').setMaxLength(32))
              .addStringOption((o) => o.setName('hex').setDescription('New colour, e.g. #FF8800').setMaxLength(7)),
          )
          .addSubcommand((s) =>
            s
              .setName('remove')
              .setDescription('Remove a colour option (deletes its role)')
              .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(32)),
          ),
      ),
  async (interaction, ctx) => {
    const sub = interaction.options.getSubcommand();
    const actor = interaction.user.id;
    const now = ctx.clock.now();

    if (interaction.options.getSubcommandGroup(false) === 'colours') {
      if (sub === 'list') {
        const options = await ctx.colours.options();
        await interaction.editReply(
          options.length ? options.map((o) => `• **${o.name}** ${o.hex}${o.roleId ? ` <@&${o.roleId}>` : ' (no role yet: run /setup run)'}`).join('\n') : 'No colours. Add some with `/vip colours add`.',
        );
        return;
      }
      const name = interaction.options.getString('name', true).trim();
      const hexRaw = interaction.options.getString('hex');
      const hex = hexRaw === null ? undefined : parseHexColour(hexRaw);
      if (hex === null) {
        await interaction.editReply(`❌ "${hexRaw}" is not a hex colour like #FF8800.`);
        return;
      }
      const hexText = hex === undefined ? undefined : formatHexColour(hex);
      let reply: string;
      if (sub === 'add') reply = await ctx.colours.addOption(name, hexText!, actor);
      else if (sub === 'edit') {
        const newName = interaction.options.getString('new_name')?.trim();
        reply = await ctx.colours.editOption(name, { ...(newName ? { name: newName } : {}), ...(hexText ? { hex: hexText } : {}) }, actor);
      } else reply = await ctx.colours.removeOption(name, actor);
      const report = reply.startsWith('✅') ? [...(await ctx.colours.syncRoles()), ...(await ctx.panels.ensureAll())] : [];
      await interaction.editReply([reply, ...report.filter((l) => !l.startsWith('✅'))].join('\n'));
      return;
    }

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

    if (sub === 'reshuffle-now') {
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

    const user = interaction.options.getUser('user', true);
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
);

export const setupCommand = defineAdminCommand(
  'setup',
  'Create or repair the bot’s roles, channels and panels',
  (b) => b.addSubcommand((s) => s.setName('run').setDescription('Safe to run again: creates what’s missing, repairs the rest')),
  async (interaction, ctx) => {
    const report = await ctx.runSetup(interaction.guild);
    await interaction.editReply(report.join('\n').slice(0, 2000));
  },
);

export const pollsCommand = defineAdminCommand(
  'polls',
  'VIP polls',
  (b) =>
    b
      .addSubcommand((s) => s.setName('status').setDescription('Polls used today, who posted, who is locked, when it resets'))
      .addSubcommand((s) =>
        s
          .setName('unlock')
          .setDescription('Give a VIP one more poll today (works even past the daily limit)')
          .addUserOption((o) => o.setName('user').setDescription('VIP').setRequired(true)),
      ),
  async (interaction, ctx) => {
    if (interaction.options.getSubcommand() === 'status') {
      await interaction.editReply(await ctx.polls.status());
      return;
    }
    const user = interaction.options.getUser('user', true);
    if (!ctx.vip.vips.has(user.id)) {
      await interaction.editReply(`❌ ${userMention(user.id)} isn't VIP.`);
      return;
    }
    await interaction.editReply(await ctx.polls.grantExtra(user.id, interaction.user.id));
  },
);
