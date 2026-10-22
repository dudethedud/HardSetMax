import type { SlashCommandStringOption } from 'discord.js';
import { defineAdminCommand } from './types.js';

const providerOption = (o: SlashCommandStringOption) => o.setName('provider').setDescription('Provider name, e.g. groq').setRequired(true).setMaxLength(32);

export const aiCommand = defineAdminCommand(
  'ai',
  'AI chat (Puppyboy Carter)',
  (b) =>
    b
      .addSubcommand((s) => s.setName('status').setDescription('On/off, each provider’s usage today, cooldowns and errors'))
      .addSubcommand((s) => s.setName('toggle').setDescription('Turn AI chat on or off (pre-written replies still work)'))
      .addSubcommand((s) =>
        s
          .setName('test')
          .setDescription('Private test reply (doesn’t use up the daily cap)')
          .addStringOption((o) => o.setName('question').setDescription('What to ask').setRequired(true).setMaxLength(300)),
      )
      .addSubcommand((s) => s.setName('providers').setDescription('Show the provider chain'))
      .addSubcommand((s) =>
        s
          .setName('provider-cap')
          .setDescription('Set a provider’s daily reply cap')
          .addStringOption(providerOption)
          .addIntegerOption((o) => o.setName('cap').setDescription('Replies per day').setRequired(true).setMinValue(0).setMaxValue(100000)),
      )
      .addSubcommand((s) => s.setName('provider-toggle').setDescription('Skip or use a provider').addStringOption(providerOption))
      .addSubcommand((s) =>
        s
          .setName('provider-model')
          .setDescription('Change the model a provider uses')
          .addStringOption(providerOption)
          .addStringOption((o) => o.setName('model').setDescription('Model ID, e.g. llama-3.1-8b-instant').setRequired(true).setMaxLength(100)),
      ),
  async (interaction, ctx) => {
    const sub = interaction.options.getSubcommand();
    const actorId = interaction.user.id;

    if (sub === 'status') {
      await interaction.editReply(await ctx.ai.status());
      return;
    }
    if (sub === 'toggle') {
      const enabled = !ctx.config.current.guild.aiEnabled;
      await ctx.db.$transaction([
        ctx.db.guildConfig.update({ where: { guildId: interaction.guildId }, data: { aiEnabled: enabled } }),
        ctx.db.auditLog.create({ data: { action: 'ai.toggle', actorId, data: { enabled } } }),
      ]);
      await ctx.config.load();
      await interaction.editReply(enabled ? '✅ AI chat is on.' : '⏸️ AI chat is off. Mentions get pre-written replies.');
      return;
    }
    if (sub === 'test') {
      const question = interaction.options.getString('question', true);
      const stats = await ctx.chat.statsFor(actorId, interaction.member.displayName);
      const text = await ctx.chat.reply(stats, [{ role: 'user', content: `${interaction.member.displayName}: ${question}` }], { count: false });
      await interaction.editReply(text ? `🤖 ${text}` : '⚠️ No AI provider answered (or AI is off). Members would get a pre-written reply. See `/ai status`.');
      return;
    }
    if (sub === 'providers') {
      const lines = (await ctx.ai.providers()).map(
        (p) => `${p.order}. **${p.name}**: ${p.model}, cap ${p.dailyCap}/day (resets 00:00 ${p.resetTimezone}), key \`${p.keyEnvVar}\`${p.enabled ? '' : ', **disabled**'}`,
      );
      await interaction.editReply([...lines, `${lines.length + 1}. pre-written replies (always available)`].join('\n'));
      return;
    }

    const name = interaction.options.getString('provider', true).trim().toLowerCase();
    const provider = await ctx.db.aiProvider.findUnique({ where: { name } });
    if (!provider) {
      await interaction.editReply(`❌ No provider called ${name}. See \`/ai providers\`.`);
      return;
    }
    const data =
      sub === 'provider-cap'
        ? { dailyCap: interaction.options.getInteger('cap', true) }
        : sub === 'provider-toggle'
          ? { enabled: !provider.enabled }
          : { model: interaction.options.getString('model', true).trim(), cooldownUntil: null, lastError: null };
    await ctx.db.$transaction([
      ctx.db.aiProvider.update({ where: { name }, data }),
      ctx.db.auditLog.create({ data: { action: `ai.${sub}`, actorId, data: { provider: name, ...data } } }),
    ]);
    await interaction.editReply(`✅ ${name}: ${Object.entries(data).filter(([k]) => k !== 'cooldownUntil' && k !== 'lastError').map(([k, v]) => `${k} = ${String(v)}`).join(', ')}`);
  },
);
