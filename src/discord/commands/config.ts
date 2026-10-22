import { ChannelType, channelMention, inlineCode, roleMention } from 'discord.js';
import { CONFIG_KEYS, parseConfigValue } from '../../core/configKeys.js';
import { DEFAULT_CHANNEL_WEIGHT } from '../../core/activityRules.js';
import { defineAdminCommand } from './types.js';

const WEIGHTED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
] as const;

export const configCommand = defineAdminCommand(
  'config',
  'View or change bot settings',
  (b) =>
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
          .setName('channel-weight')
          .setDescription("Set how much a channel's messages count (0 ignores it; threads use their parent's)")
          .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...WEIGHTED_CHANNEL_TYPES))
          .addNumberOption((o) => o.setName('weight').setDescription('0 to 5, default 1').setRequired(true).setMinValue(0).setMaxValue(5)),
      )
      .addSubcommand((s) =>
        s
          .setName('channel')
          .setDescription('Set where the bot posts announcements or the mod-log')
          .addStringOption((o) =>
            o
              .setName('purpose')
              .setDescription('What the channel is for')
              .setRequired(true)
              .addChoices({ name: 'announcements', value: 'announcements' }, { name: 'mod-log', value: 'mod-log' }, { name: 'polls', value: 'polls' }),
          )
          .addChannelOption((o) =>
            o.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('polls-role')
          .setDescription('Role the bot pings for new VIP polls')
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('level-roles-top')
          .setDescription("bleed's highest level role; /setup run puts VIP directly above it")
          .addRoleOption((o) => o.setName('role').setDescription('Highest level role').setRequired(true)),
      )
      .addSubcommandGroup((g) =>
        g
          .setName('staff-roles')
          .setDescription('Members with a staff role can’t be VIP')
          .addSubcommand((s) =>
            s
              .setName('add')
              .setDescription('Add a staff role')
              .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName('remove')
              .setDescription('Remove a staff role')
              .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
          )
          .addSubcommand((s) => s.setName('list').setDescription('List staff roles')),
      ),
  async (interaction, ctx) => {
    const guildId = interaction.guildId;
    const { guild: config, channelWeights } = ctx.config.current;
    const sub = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);
    const actorId = interaction.user.id;

    if (group === 'staff-roles') {
      if (sub === 'list') {
        const roles = await ctx.db.staffRole.findMany();
        await interaction.editReply(roles.length ? `**Staff roles:** ${roles.map((r) => roleMention(r.roleId)).join(', ')}` : 'No staff roles set.');
        return;
      }
      const role = interaction.options.getRole('role', true);
      await ctx.db.$transaction([
        sub === 'add'
          ? ctx.db.staffRole.upsert({ where: { roleId: role.id }, create: { roleId: role.id }, update: {} })
          : ctx.db.staffRole.deleteMany({ where: { roleId: role.id } }),
        ctx.db.auditLog.create({ data: { action: `config.staff-role.${sub}`, actorId, targetId: role.id } }),
      ]);
      await interaction.editReply(
        sub === 'add'
          ? `✅ ${roleMention(role.id)} is a staff role. Members with it can't be VIP; current VIPs with it lose VIP at their next role change or the next reshuffle.`
          : `✅ ${roleMention(role.id)} is no longer a staff role.`,
      );
      return;
    }

    if (sub === 'channel') {
      const purpose = interaction.options.getString('purpose', true);
      const channel = interaction.options.getChannel('channel', true, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
      const field = purpose === 'mod-log' ? 'modLogChannelId' : purpose === 'polls' ? 'pollsChannelId' : 'announceChannelId';
      await ctx.db.$transaction([
        ctx.db.guildConfig.update({ where: { guildId }, data: { [field]: channel.id } }),
        ctx.db.auditLog.create({ data: { action: 'config.channel', actorId, targetId: channel.id, data: { purpose, old: config[field] } } }),
      ]);
      await ctx.config.load();
      await interaction.editReply(`✅ ${purpose} channel: ${channelMention(channel.id)}${purpose === 'polls' ? '. Run `/setup run` to set its permissions.' : ''}`);
      return;
    }

    if (sub === 'polls-role') {
      const role = interaction.options.getRole('role', true);
      await ctx.db.$transaction([
        ctx.db.guildConfig.update({ where: { guildId }, data: { pollsRoleId: role.id } }),
        ctx.db.auditLog.create({ data: { action: 'config.polls-role', actorId, targetId: role.id } }),
      ]);
      await ctx.config.load();
      await interaction.editReply(`✅ Polls role: ${roleMention(role.id)}. Run \`/setup run\` so only the bot can ping it.`);
      return;
    }

    if (sub === 'level-roles-top') {
      const role = interaction.options.getRole('role', true);
      await ctx.db.$transaction([
        ctx.db.guildConfig.update({ where: { guildId }, data: { levelRolesTopId: role.id } }),
        ctx.db.auditLog.create({ data: { action: 'config.level-roles-top', actorId, targetId: role.id } }),
      ]);
      await ctx.config.load();
      await interaction.editReply(`✅ Highest level role: ${roleMention(role.id)}. Run \`/setup run\` to move the VIP role above it.`);
      return;
    }

    if (sub === 'view') {
      const lines = Object.entries(CONFIG_KEYS).map(([key, def]) => `${inlineCode(key)} = ${inlineCode(String(config[def.field]))}`);
      const weights = [...channelWeights].map(([id, w]) => `${channelMention(id)} = ${inlineCode(String(w))}`);
      const ref = (id: string | null, mention: (id: string) => string) => (id ? mention(id) : 'not set');
      lines.push(
        '',
        `**Announcements:** ${ref(config.announceChannelId, channelMention)} · **Mod-log:** ${ref(config.modLogChannelId, channelMention)}`,
        `**VIP role:** ${ref(config.vipRoleId, roleMention)} · **Level roles top:** ${ref(config.levelRolesTopId, roleMention)}`,
        `**Polls channel:** ${ref(config.pollsChannelId, channelMention)} · **Polls role:** ${ref(config.pollsRoleId, roleMention)}`,
      );
      lines.push('', `**Channel weights** (others: ${DEFAULT_CHANNEL_WEIGHT})`, ...(weights.length ? weights : ['none set']));
      await interaction.editReply(lines.join('\n'));
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
        ctx.db.auditLog.create({
          data: { actorId: interaction.user.id, action: 'config.channel-weight', targetId: channel.id, data: { old, new: weight } },
        }),
      ]);
      await ctx.config.load();
      await interaction.editReply(`✅ ${channelMention(channel.id)}: ${old} → ${weight}${weight === 0 ? ' (ignored)' : ''}`);
      return;
    }

    const parsed = parseConfigValue(interaction.options.getString('key', true), interaction.options.getString('value', true));
    if (!parsed.ok) {
      await interaction.editReply(`❌ ${parsed.error}`);
      return;
    }

    const old = config[parsed.field];
    await ctx.db.$transaction([
      ctx.db.guildConfig.update({ where: { guildId }, data: { [parsed.field]: parsed.value } }),
      ctx.db.auditLog.create({
        data: { actorId: interaction.user.id, action: 'config.set', data: { key: parsed.key, old, new: parsed.value } },
      }),
    ]);
    await ctx.config.load();
    ctx.log.info({ actorId: interaction.user.id, key: parsed.key, old, new: parsed.value }, 'config changed');
    await interaction.editReply(`✅ ${inlineCode(parsed.key)}: ${inlineCode(String(old))} → ${inlineCode(String(parsed.value))}`);
  },
);
