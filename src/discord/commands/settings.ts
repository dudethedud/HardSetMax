import { ChannelType, channelMention, inlineCode, roleMention, type SlashCommandStringOption } from 'discord.js';
import { CONFIG_KEYS, parseConfigValue } from '../../core/configKeys.js';
import { DEFAULT_CHANNEL_WEIGHT } from '../../core/activityRules.js';
import { normalizeRoleName } from '../../core/crown.js';
import { formatHexColour, parseHexColour } from '../../core/vipRules.js';
import { bindRoleError } from '../../core/reuse.js';
import { rolesInUse } from '../../services/reuse.js';
import { defineCommand } from './types.js';

const WEIGHTED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
] as const;

const CHANNEL_FIELDS = {
  announcements: 'announceChannelId',
  'mod-log': 'modLogChannelId',
  polls: 'pollsChannelId',
  'main-chat': 'mainChatChannelId',
  'vip-board': 'vipBoardChannelId',
} as const;

const action = (...choices: string[]) => (o: SlashCommandStringOption) =>
  o
    .setName('action')
    .setDescription('What to do')
    .setRequired(true)
    .addChoices(...choices.map((c) => ({ name: c, value: c })));

export const settingsCommand = defineCommand({
  name: 'settings',
  description: 'Admin: bot settings, channels, roles, colours, badges and blocked words',
  levels: { default: 'admin' },
  build: (b) =>
    b
      .addSubcommand((s) => s.setName('view').setDescription('Show all settings'))
      .addSubcommand((s) =>
        s
          .setName('set')
          .setDescription('Change a setting')
          .addStringOption((o) =>
            o
              .setName('key')
              .setDescription('Setting to change')
              .setRequired(true)
              .addChoices(...Object.entries(CONFIG_KEYS).map(([key, def]) => ({ name: `${key}: ${def.description}`.slice(0, 100), value: key }))),
          )
          .addStringOption((o) => o.setName('value').setDescription('New value').setRequired(true).setMaxLength(100)),
      )
      .addSubcommand((s) =>
        s
          .setName('channel')
          .setDescription('Set a channel the bot uses')
          .addStringOption((o) =>
            o
              .setName('purpose')
              .setDescription('What the channel is for')
              .setRequired(true)
              .addChoices(
                { name: 'announcements', value: 'announcements' },
                { name: 'mod-log', value: 'mod-log' },
                { name: 'polls', value: 'polls' },
                { name: 'main-chat (AI replies and shoutouts)', value: 'main-chat' },
                { name: 'vip-board', value: 'vip-board' },
              ),
          )
          .addChannelOption((o) =>
            o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('channel-weight')
          .setDescription("Set how much a channel's messages count (0 ignores it; threads use their parent's)")
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...WEIGHTED_CHANNEL_TYPES))
          .addNumberOption((o) => o.setName('weight').setDescription('0 to 5, default 1').setRequired(true).setMinValue(0).setMaxValue(5)),
      )
      .addSubcommand((s) =>
        s
          .setName('role')
          .setDescription('Staff roles, or use an existing role for VIP, the Crown, a title, polls or the top level role')
          .addStringOption(action('add-staff', 'remove-staff', 'list-staff', 'level-top', 'polls', 'vip', 'crown', 'title-champion', 'title-advisor', 'title-jester'))
          .addRoleOption((o) => o.setName('role').setDescription('Role (not needed for list-staff)')),
      )
      .addSubcommand((s) =>
        s
          .setName('colour')
          .setDescription('VIP colour options')
          .addStringOption(action('list', 'add', 'edit', 'remove'))
          .addStringOption((o) => o.setName('name').setDescription('Name shown in the picker (current name, for edit)').setMaxLength(32))
          .addStringOption((o) => o.setName('hex').setDescription('Colour, e.g. #FF8800').setMaxLength(7))
          .addStringOption((o) => o.setName('new_name').setDescription('New name (edit only)').setMaxLength(32)),
      )
      .addSubcommand((s) =>
        s
          .setName('badge')
          .setDescription('VIP history badge milestones')
          .addStringOption(action('list', 'set', 'remove'))
          .addIntegerOption((o) => o.setName('weeks').setDescription('Weeks of VIP (pinned time doesn’t count)').setMinValue(1).setMaxValue(520))
          .addStringOption((o) => o.setName('name').setDescription('Badge name, e.g. VIP Regular (set only)').setMaxLength(32)),
      )
      .addSubcommand((s) =>
        s
          .setName('blocked-word')
          .setDescription('Words custom roles, room names, shoutouts and decrees can’t contain')
          .addStringOption(action('list', 'add', 'remove'))
          .addStringOption((o) => o.setName('word').setDescription('Word').setMaxLength(50)),
      ),
  async execute(interaction, ctx) {
    const guildId = interaction.guildId;
    const { guild: config, channelWeights } = ctx.config.current;
    const sub = interaction.options.getSubcommand();
    const act = interaction.options.getString('action');
    const actorId = interaction.user.id;
    const needs = async (what: string) => interaction.editReply(`❌ \`${act}\` needs the \`${what}\` option.`);

    if (sub === 'view') {
      const lines = Object.entries(CONFIG_KEYS).map(([key, def]) => `${inlineCode(key)} = ${inlineCode(String(config[def.field]))}`);
      const weights = [...channelWeights].map(([id, w]) => `${channelMention(id)} = ${inlineCode(String(w))}`);
      const ref = (id: string | null, mention: (id: string) => string) => (id ? mention(id) : 'not set');
      const staff = await ctx.db.staffRole.findMany();
      lines.push(
        '',
        `**Announcements:** ${ref(config.announceChannelId, channelMention)} · **Mod-log:** ${ref(config.modLogChannelId, channelMention)}`,
        `**VIP role:** ${ref(config.vipRoleId, roleMention)} · **Level roles top:** ${ref(config.levelRolesTopId, roleMention)}`,
        `**Polls channel:** ${ref(config.pollsChannelId, channelMention)} · **Polls role:** ${ref(config.pollsRoleId, roleMention)}`,
        `**Main chat:** ${ref(config.mainChatChannelId, channelMention)} · **AI chat:** ${config.aiEnabled ? 'on' : 'off'}`,
        `**VIP board:** ${ref(config.vipBoardChannelId, channelMention)}`,
        `**Staff roles:** ${staff.length ? staff.map((r) => roleMention(r.roleId)).join(', ') : 'none'}`,
      );
      lines.push('', `**Channel weights** (others: ${DEFAULT_CHANNEL_WEIGHT})`, ...(weights.length ? weights : ['none set']));
      await interaction.editReply(lines.join('\n').slice(0, 2000));
      return;
    }

    if (sub === 'set') {
      const parsed = parseConfigValue(interaction.options.getString('key', true), interaction.options.getString('value', true));
      if (!parsed.ok) {
        await interaction.editReply(`❌ ${parsed.error}`);
        return;
      }
      const old = config[parsed.field];
      await ctx.db.$transaction([
        ctx.db.guildConfig.update({ where: { guildId }, data: { [parsed.field]: parsed.value } }),
        ctx.db.auditLog.create({ data: { actorId, action: 'config.set', data: { key: parsed.key, old, new: parsed.value } } }),
      ]);
      await ctx.config.load();
      ctx.log.info({ actorId, key: parsed.key, old, new: parsed.value }, 'config changed');
      await interaction.editReply(`✅ ${inlineCode(parsed.key)}: ${inlineCode(String(old))} → ${inlineCode(String(parsed.value))}`);
      return;
    }

    if (sub === 'channel') {
      const purpose = interaction.options.getString('purpose', true) as keyof typeof CHANNEL_FIELDS;
      const channel = interaction.options.getChannel('channel', true, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
      const field = CHANNEL_FIELDS[purpose];
      await ctx.db.$transaction([
        ctx.db.guildConfig.update({ where: { guildId }, data: { [field]: channel.id } }),
        ctx.db.auditLog.create({ data: { action: 'config.channel', actorId, targetId: channel.id, data: { purpose, old: config[field] } } }),
      ]);
      await ctx.config.load();
      const note = purpose === 'polls' || purpose === 'vip-board' ? '. Run `/bot setup` to set its permissions.' : '';
      if (purpose === 'vip-board') await ctx.panels.refresh('vip-board');
      await interaction.editReply(`✅ ${purpose} channel: ${channelMention(channel.id)}${note}`);
      return;
    }

    if (sub === 'channel-weight') {
      const channel = interaction.options.getChannel('channel', true, WEIGHTED_CHANNEL_TYPES);
      const weight = interaction.options.getNumber('weight', true);
      const old = channelWeights.get(channel.id) ?? DEFAULT_CHANNEL_WEIGHT;
      await ctx.db.$transaction([
        weight === DEFAULT_CHANNEL_WEIGHT
          ? ctx.db.channelWeight.deleteMany({ where: { channelId: channel.id } })
          : ctx.db.channelWeight.upsert({ where: { channelId: channel.id }, create: { channelId: channel.id, weight }, update: { weight } }),
        ctx.db.auditLog.create({ data: { actorId, action: 'config.channel-weight', targetId: channel.id, data: { old, new: weight } } }),
      ]);
      await ctx.config.load();
      await interaction.editReply(`✅ ${channelMention(channel.id)}: ${old} → ${weight}${weight === 0 ? ' (ignored)' : ''}`);
      return;
    }

    if (sub === 'role') {
      if (act === 'list-staff') {
        const roles = await ctx.db.staffRole.findMany();
        await interaction.editReply(roles.length ? `**Staff roles:** ${roles.map((r) => roleMention(r.roleId)).join(', ')}` : 'No staff roles set.');
        return;
      }
      const role = interaction.options.getRole('role');
      if (!role) {
        await needs('role');
        return;
      }
      if (act === 'add-staff' || act === 'remove-staff') {
        const adding = act === 'add-staff';
        await ctx.db.$transaction([
          adding
            ? ctx.db.staffRole.upsert({ where: { roleId: role.id }, create: { roleId: role.id }, update: {} })
            : ctx.db.staffRole.deleteMany({ where: { roleId: role.id } }),
          ctx.db.auditLog.create({ data: { action: `config.staff-role.${adding ? 'add' : 'remove'}`, actorId, targetId: role.id } }),
        ]);
        await interaction.editReply(
          adding
            ? `✅ ${roleMention(role.id)} is a staff role. Members with it can use staff commands (they also need Timeout Members to see them) and can't be VIP; current VIPs with it lose VIP at their next role change or the next reshuffle.`
            : `✅ ${roleMention(role.id)} is no longer a staff role.`,
        );
        return;
      }
      if (act === 'vip' || act === 'crown' || act?.startsWith('title-')) {
        // Use an existing role for a bot function instead of the one /bot setup made.
        const guild = interaction.guild;
        const slot = act.startsWith('title-') ? act.slice('title-'.length) : null;
        const current = slot ? (await ctx.db.crownTitle.findUnique({ where: { slot } }))?.roleId : act === 'vip' ? config.vipRoleId : config.crownRoleId;
        const used = await rolesInUse(ctx.db, config);
        if (current) used.delete(current);
        const botTop = (guild.members.me ?? (await guild.members.fetchMe())).roles.highest;
        const live = guild.roles.cache.get(role.id);
        const error = live
          ? bindRoleError({ id: live.id, managed: live.managed, position: live.position }, { everyoneId: guild.id, botTopPosition: botTop.position, usedElsewhere: used.has(live.id) })
          : 'That role no longer exists.';
        if (error) {
          await interaction.editReply(`❌ ${error}`);
          return;
        }
        if (slot) {
          await ctx.powers.titles(); // make sure the title rows exist
          await ctx.db.$transaction([
            ctx.db.crownTitle.update({ where: { slot }, data: { roleId: role.id, name: role.name } }),
            ctx.db.auditLog.create({ data: { action: 'config.title-role', actorId, targetId: role.id, data: { slot, old: current ?? null } } }),
          ]);
          await ctx.powers.reconcile();
        } else {
          const field = act === 'vip' ? 'vipRoleId' : 'crownRoleId';
          await ctx.db.$transaction([
            ctx.db.guildConfig.update({ where: { guildId }, data: { [field]: role.id } }),
            ctx.db.auditLog.create({ data: { action: `config.${act}-role`, actorId, targetId: role.id, data: { old: current ?? null } } }),
          ]);
          await ctx.config.load();
          if (act === 'vip') await ctx.vip.reconcile();
          else await ctx.crown.reconcile();
        }
        await interaction.editReply(
          [
            `✅ ${roleMention(role.id)} is now the ${slot ? `${slot} title` : act === 'vip' ? 'VIP' : 'Crown'} role. The bot gives and removes it from now on.`,
            current && current !== role.id ? `The old role <@&${current}> isn't used any more; delete it in Server Settings → Roles when you're ready.` : '',
            'Run `/bot setup` so its position and permissions are set up (the lounge uses the VIP role too).',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }
      const field = act === 'polls' ? 'pollsRoleId' : 'levelRolesTopId';
      await ctx.db.$transaction([
        ctx.db.guildConfig.update({ where: { guildId }, data: { [field]: role.id } }),
        ctx.db.auditLog.create({ data: { action: act === 'polls' ? 'config.polls-role' : 'config.level-roles-top', actorId, targetId: role.id } }),
      ]);
      await ctx.config.load();
      await interaction.editReply(
        act === 'polls'
          ? `✅ Polls role: ${roleMention(role.id)}. Run \`/bot setup\` so only the bot can ping it.`
          : `✅ Highest level role: ${roleMention(role.id)}. Run \`/bot setup\` to move the VIP role above it.`,
      );
      return;
    }

    if (sub === 'colour') {
      if (act === 'list') {
        const options = await ctx.colours.options();
        await interaction.editReply(
          options.length
            ? options.map((o) => `• **${o.name}** ${o.hex}${o.roleId ? ` <@&${o.roleId}>` : ' (no role yet: run /bot setup)'}`).join('\n')
            : 'No colours. Add some with `/settings colour action:add`.',
        );
        return;
      }
      const name = interaction.options.getString('name')?.trim();
      if (!name) {
        await needs('name');
        return;
      }
      const hexRaw = interaction.options.getString('hex');
      const hex = hexRaw === null ? undefined : parseHexColour(hexRaw);
      if (hex === null) {
        await interaction.editReply(`❌ "${hexRaw}" is not a hex colour like #FF8800.`);
        return;
      }
      const hexText = hex === undefined ? undefined : formatHexColour(hex);
      let reply: string;
      if (act === 'add') {
        if (!hexText) {
          await needs('hex');
          return;
        }
        reply = await ctx.colours.addOption(name, hexText, actorId);
      } else if (act === 'edit') {
        const newName = interaction.options.getString('new_name')?.trim();
        reply = await ctx.colours.editOption(name, { ...(newName ? { name: newName } : {}), ...(hexText ? { hex: hexText } : {}) }, actorId);
      } else reply = await ctx.colours.removeOption(name, actorId);
      const report = reply.startsWith('✅') ? [...(await ctx.colours.syncRoles()), ...(await ctx.panels.ensureAll())] : [];
      await interaction.editReply([reply, ...report.filter((l) => !l.startsWith('✅'))].join('\n'));
      return;
    }

    if (sub === 'badge') {
      if (act === 'list') {
        const badges = await ctx.db.badge.findMany({ orderBy: { weeks: 'asc' }, include: { _count: { select: { earned: true } } } });
        await interaction.editReply(
          badges.length
            ? badges.map((b) => `• **${b.name}** at ${b.weeks} weeks: ${b._count.earned} member(s)${b.roleId ? ` <@&${b.roleId}>` : ' (no role yet: run /bot setup)'}`).join('\n')
            : 'No badges. Add one with `/settings badge action:set`.',
        );
        return;
      }
      const weeks = interaction.options.getInteger('weeks');
      if (weeks === null) {
        await needs('weeks');
        return;
      }
      let reply: string;
      if (act === 'set') {
        const name = interaction.options.getString('name')?.trim();
        if (!name) {
          await needs('name');
          return;
        }
        reply = await ctx.badges.set(weeks, name, actorId);
      } else reply = await ctx.badges.remove(weeks, actorId);
      const guild = interaction.guild;
      const vipRoleId = config.vipRoleId;
      const vipRole = vipRoleId ? guild.roles.cache.get(vipRoleId) : undefined;
      const report: string[] = [];
      if (act === 'set' && reply.startsWith('✅') && vipRole) await ctx.badges.setup(guild, vipRole, report);
      await interaction.editReply([reply, ...report.filter((l) => !l.startsWith('✅'))].join('\n'));
      return;
    }

    // blocked-word
    if (act === 'list') {
      const words = await ctx.db.blockedWord.findMany({ orderBy: { word: 'asc' } });
      await interaction.editReply(words.length ? `**Blocked words:** ${words.map((w) => `\`${w.word}\``).join(', ')}`.slice(0, 2000) : 'No blocked words.');
      return;
    }
    const word = interaction.options.getString('word')?.trim().toLowerCase();
    if (!word) {
      await needs('word');
      return;
    }
    if (!normalizeRoleName(word)) {
      await interaction.editReply('❌ The word needs at least one letter or number.');
      return;
    }
    await ctx.db.$transaction([
      act === 'add' ? ctx.db.blockedWord.upsert({ where: { word }, create: { word }, update: {} }) : ctx.db.blockedWord.deleteMany({ where: { word } }),
      ctx.db.auditLog.create({ data: { action: `crown.blocked-word.${act}`, actorId, data: { word } } }),
    ]);
    await interaction.editReply(act === 'add' ? `✅ Blocked \`${word}\` (also catches lookalikes like 0 for o).` : `✅ Unblocked \`${word}\`.`);
  },
});
