import { inlineCode } from 'discord.js';
import { getGuildConfig } from '../../config/guildConfig.js';
import { CONFIG_KEYS, parseConfigValue } from '../../core/configKeys.js';
import { defineAdminCommand } from './types.js';

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
      ),
  async (interaction, ctx) => {
    const guildId = interaction.guildId;
    const config = await getGuildConfig(ctx.db, guildId);

    if (interaction.options.getSubcommand() === 'view') {
      const lines = Object.entries(CONFIG_KEYS).map(([key, def]) => `${inlineCode(key)} = ${inlineCode(config[def.field])}`);
      await interaction.editReply(lines.join('\n'));
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
    ctx.log.info({ actorId: interaction.user.id, key: parsed.key, old, new: parsed.value }, 'config changed');
    await interaction.editReply(`✅ ${inlineCode(parsed.key)}: ${inlineCode(old)} → ${inlineCode(parsed.value)}`);
  },
);
