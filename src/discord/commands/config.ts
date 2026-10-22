import { ChannelType, channelMention, inlineCode } from 'discord.js';
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
      ),
  async (interaction, ctx) => {
    const guildId = interaction.guildId;
    const { guild: config, channelWeights } = ctx.config.current;
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const lines = Object.entries(CONFIG_KEYS).map(([key, def]) => `${inlineCode(key)} = ${inlineCode(String(config[def.field]))}`);
      const weights = [...channelWeights].map(([id, w]) => `${channelMention(id)} = ${inlineCode(String(w))}`);
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
