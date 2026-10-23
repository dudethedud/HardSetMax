import { hostname } from 'node:os';
import { EmbedBuilder, IntentsBitField, time, TimestampStyles, type ChatInputCommandInteraction } from 'discord.js';
import { MANUAL_RESHUFFLE_JOB, RESHUFFLE_JOB } from '../../services/vipService.js';
import { serverDayAt } from '../../core/serverDay.js';
import { VERSION } from '../../version.js';
import { REQUIRED_INTENT_NAMES } from '../client.js';
import { defineCommand, type AppContext } from './types.js';

export const botCommand = defineCommand({
  name: 'bot',
  description: 'Bot health, setup and AI chat',
  levels: { default: 'admin', health: 'staff' },
  build: (b) =>
    b
      .addSubcommand((s) => s.setName('health').setDescription('Version, uptime, database, leader lock and intents'))
      .addSubcommand((s) => s.setName('setup').setDescription('Admin: create or repair roles, channels and panels (safe to run again)'))
      .addSubcommand((s) =>
        s
          .setName('ai')
          .setDescription('Admin: AI chat (Puppyboy Carter)')
          .addStringOption((o) =>
            o
              .setName('action')
              .setDescription('What to do')
              .setRequired(true)
              .addChoices(
                { name: 'status: usage, cooldowns and errors', value: 'status' },
                { name: 'on', value: 'on' },
                { name: 'off (pre-written replies still work)', value: 'off' },
                { name: 'providers: the provider chain', value: 'providers' },
                { name: 'test: a private reply (doesn’t use the daily cap)', value: 'test' },
              ),
          )
          .addStringOption((o) => o.setName('question').setDescription('For test: what to ask').setMaxLength(300)),
      )
      .addSubcommand((s) =>
        s
          .setName('ai-provider')
          .setDescription('Admin: change an AI provider')
          .addStringOption((o) => o.setName('provider').setDescription('Provider name, e.g. groq').setRequired(true).setMaxLength(32))
          .addStringOption((o) =>
            o
              .setName('setting')
              .setDescription('What to change')
              .setRequired(true)
              .addChoices(
                { name: 'cap: replies per day', value: 'cap' },
                { name: 'model: model ID', value: 'model' },
                { name: 'toggle: skip or use it', value: 'toggle' },
              ),
          )
          .addStringOption((o) => o.setName('value').setDescription('For cap: a number. For model: e.g. llama-3.1-8b-instant').setMaxLength(100)),
      ),
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'health') return health(interaction, ctx);
    if (sub === 'setup') {
      const report = await ctx.runSetup(interaction.guild);
      await interaction.editReply(report.join('\n').slice(0, 2000));
      return;
    }
    if (sub === 'ai') return ai(interaction, ctx);
    return aiProvider(interaction, ctx);
  },
});

async function health(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext): Promise<void> {
  const { db, leader, client, startedAt } = ctx;

  let dbLine: string;
  let dayLine = 'unavailable (database down)';
  const t0 = performance.now();
  try {
    await db.$queryRaw`SELECT 1`;
    dbLine = `✅ connected (${Math.round(performance.now() - t0)} ms)`;
    const day = serverDayAt(new Date(), ctx.config.current.boundary);
    dayLine = `\`${day.key}\`, next boundary ${time(day.end, TimestampStyles.RelativeTime)}`;
  } catch (err) {
    ctx.log.warn({ err }, 'health: database check failed');
    dbLine = '❌ unreachable';
  }

  const copy = `pid ${process.pid}, ${hostname()}`;
  const lostSince = leader.lostSince();

  let reshuffleLine = 'never run';
  try {
    const last = await db.jobRun.findFirst({ where: { job: { in: [RESHUFFLE_JOB, MANUAL_RESHUFFLE_JOB] } }, orderBy: { startedAt: 'desc' } });
    if (last) {
      const d = last.detail as { added?: unknown[]; removed?: unknown[]; error?: string } | null;
      const when = time(last.finishedAt ?? last.startedAt, TimestampStyles.RelativeTime);
      reshuffleLine =
        last.status === 'succeeded'
          ? `✅ ${when}: ${d?.added?.length ?? 0} added, ${d?.removed?.length ?? 0} removed`
          : last.status === 'failed'
            ? `❌ ${when}: ${String(d?.error ?? 'failed').slice(0, 150)} (retries automatically)`
            : `⏳ running since ${when}`;
    }
  } catch {
    reshuffleLine = 'unavailable (database down)';
  }
  const granted = new IntentsBitField(client.options.intents).toArray();
  const missingIntents = REQUIRED_INTENT_NAMES.filter((n) => !granted.includes(n as never));

  const embed = new EmbedBuilder().setTitle('Bot health').addFields(
    { name: 'Version', value: VERSION, inline: true },
    { name: 'Up since', value: time(startedAt, TimestampStyles.RelativeTime), inline: true },
    { name: 'Discord ping', value: `${client.ws.ping} ms`, inline: true },
    { name: 'Database', value: dbLine },
    {
      name: 'Gateway leader',
      value: leader.isHeld()
        ? `✅ this copy (${copy}) since ${time(leader.acquiredAt, TimestampStyles.RelativeTime)}`
        : lostSince
          ? `⚠️ database-down mode since ${time(lostSince, TimestampStyles.RelativeTime)}: counting in memory, jobs paused, reconnecting`
          : '❌ lock released; this copy is shutting down',
    },
    // Logging in only succeeds if every requested privileged intent is enabled in the portal.
    { name: 'Intents', value: missingIntents.length ? `⚠️ not requested: ${missingIntents.join(', ')}` : `✅ ${granted.join(', ')}` },
    { name: 'Server-day', value: dayLine },
    { name: 'Last reshuffle', value: reshuffleLine },
    {
      name: 'Pending writes',
      value: `${ctx.activity.pendingCount}${ctx.activity.lastFlushError ? ' ⚠️ last save failed, retrying' : ''}${
        ctx.activity.lastFlushAt ? `, last saved ${time(ctx.activity.lastFlushAt, TimestampStyles.RelativeTime)}` : ''
      }`,
      inline: true,
    },
    { name: 'AI', value: (await ctx.ai.status()).split('\n').slice(0, 3).join('\n').slice(0, 1000) },
  );

  await interaction.editReply({ embeds: [embed] });
}

async function ai(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext): Promise<void> {
  const act = interaction.options.getString('action', true);
  const actorId = interaction.user.id;
  if (act === 'status') {
    await interaction.editReply(await ctx.ai.status());
    return;
  }
  if (act === 'on' || act === 'off') {
    const enabled = act === 'on';
    await ctx.db.$transaction([
      ctx.db.guildConfig.update({ where: { guildId: interaction.guildId }, data: { aiEnabled: enabled } }),
      ctx.db.auditLog.create({ data: { action: 'ai.toggle', actorId, data: { enabled } } }),
    ]);
    await ctx.config.load();
    await interaction.editReply(enabled ? '✅ AI chat is on.' : '⏸️ AI chat is off. Mentions get pre-written replies.');
    return;
  }
  if (act === 'providers') {
    const lines = (await ctx.ai.providers()).map(
      (p) => `${p.order}. **${p.name}**: ${p.model}, cap ${p.dailyCap}/day (resets 00:00 ${p.resetTimezone}), key \`${p.keyEnvVar}\`${p.enabled ? '' : ', **disabled**'}`,
    );
    await interaction.editReply([...lines, `${lines.length + 1}. pre-written replies (always available)`].join('\n'));
    return;
  }
  const question = interaction.options.getString('question');
  if (!question) {
    await interaction.editReply('❌ `test` needs the `question` option.');
    return;
  }
  const stats = await ctx.chat.statsFor(actorId, interaction.member.displayName);
  const text = await ctx.chat.reply(stats, [{ role: 'user', content: `${interaction.member.displayName}: ${question}` }], { count: false });
  await interaction.editReply(text ? `🤖 ${text}` : '⚠️ No AI provider answered (or AI is off). Members would get a pre-written reply. See `/bot ai action:status`.');
}

async function aiProvider(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext): Promise<void> {
  const name = interaction.options.getString('provider', true).trim().toLowerCase();
  const setting = interaction.options.getString('setting', true);
  const value = interaction.options.getString('value')?.trim() ?? '';
  const provider = await ctx.db.aiProvider.findUnique({ where: { name } });
  if (!provider) {
    await interaction.editReply(`❌ No provider called ${name}. See \`/bot ai action:providers\`.`);
    return;
  }
  let data: { dailyCap: number } | { enabled: boolean } | { model: string; cooldownUntil: null; lastError: null };
  if (setting === 'cap') {
    const cap = Number(value);
    if (!/^\d+$/.test(value) || cap > 100_000) {
      await interaction.editReply('❌ For cap, `value` must be a whole number from 0 to 100000.');
      return;
    }
    data = { dailyCap: cap };
  } else if (setting === 'model') {
    if (!value) {
      await interaction.editReply('❌ For model, `value` must be a model ID.');
      return;
    }
    data = { model: value, cooldownUntil: null, lastError: null };
  } else data = { enabled: !provider.enabled };
  await ctx.db.$transaction([
    ctx.db.aiProvider.update({ where: { name }, data }),
    ctx.db.auditLog.create({ data: { action: `ai.provider-${setting}`, actorId: interaction.user.id, data: { provider: name, ...data } } }),
  ]);
  const shown = Object.entries(data).filter(([k]) => k !== 'cooldownUntil' && k !== 'lastError');
  await interaction.editReply(`✅ ${name}: ${shown.map(([k, v]) => `${k} = ${String(v)}`).join(', ')}`);
}
