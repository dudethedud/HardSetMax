import { hostname } from 'node:os';
import { ApplicationCommandOptionType, EmbedBuilder, IntentsBitField, PermissionFlagsBits, time, TimestampStyles, userMention, type ChatInputCommandInteraction } from 'discord.js';
import { MANUAL_RESHUFFLE_JOB, RESHUFFLE_JOB } from '../../services/vipService.js';
import { serverDayAt } from '../../core/serverDay.js';
import { sendSetupResult } from '../setupPicks.js';
import { VERSION } from '../../version.js';
import { REQUIRED_INTENT_NAMES } from '../client.js';
import type { AccessLevel } from '../../core/access.js';
import { defineCommand, type AppContext, type Command } from './types.js';

export const botCommand = defineCommand({
  name: 'bot',
  description: 'Bot health, setup and AI chat',
  levels: { default: 'admin', health: 'staff', help: 'staff' },
  build: (b) =>
    b
      .addSubcommand((s) => s.setName('help').setDescription('Every command you can use, with what it does'))
      .addSubcommand((s) => s.setName('health').setDescription('Is the bot OK? Database, last reshuffle, AI and more'))
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
          .setName('ai-blacklist')
          .setDescription('Admin: who Puppyboy Carter won’t reply to (added automatically for mean/NSFW messages)')
          .addStringOption((o) =>
            o
              .setName('action')
              .setDescription('What to do')
              .setRequired(true)
              .addChoices(
                { name: 'list: who he won’t reply to', value: 'list' },
                { name: 'add: stop replying to someone', value: 'add' },
                { name: 'remove: reply to them again (clears their flags)', value: 'remove' },
              ),
          )
          .addUserOption((o) => o.setName('user').setDescription('Member (not needed for list)')),
      )
      .addSubcommand((s) =>
        s
          .setName('ai-provider')
          .setDescription('Admin: change an AI provider')
          .addStringOption((o) => o.setName('provider').setDescription('Which provider').setRequired(true).setMaxLength(32).setAutocomplete(true))
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
          .addStringOption((o) => o.setName('value').setDescription('For cap: a number. For model: a model ID, e.g. openai/gpt-oss-20b').setMaxLength(100)),
      ),
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'health') return health(interaction, ctx);
    if (sub === 'setup') {
      // The report (split to fit), then menus for anything setup couldn't work out.
      await sendSetupResult(interaction, ctx, interaction.guild, await ctx.runSetup(interaction.guild));
      return;
    }
    if (sub === 'help') return help(interaction);
    if (sub === 'ai') return ai(interaction, ctx);
    if (sub === 'ai-blacklist') return aiBlacklist(interaction, ctx);
    return aiProvider(interaction, ctx);
  },
  async autocomplete(interaction, ctx) {
    const typed = String(interaction.options.getFocused()).toLowerCase();
    return (await ctx.ai.providers())
      .filter((p) => p.name.includes(typed))
      .map((p) => ({ name: `${p.name} (${p.model}${p.enabled ? '' : ', off'})`, value: p.name }));
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
      const d = last.detail as { added?: unknown[]; removed?: unknown[]; error?: string; warmupDaysLeft?: number } | null;
      const when = time(last.finishedAt ?? last.startedAt, TimestampStyles.RelativeTime);
      reshuffleLine =
        last.status === 'succeeded' && d?.warmupDaysLeft
          ? `⏳ ${when}: warming up, VIP starts changing in ${d.warmupDaysLeft} day(s)`
          : last.status === 'succeeded'
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
  const { text, strike } = await ctx.chat.reply(stats, [{ role: 'user', content: `${interaction.member.displayName}: ${question}` }], { count: false });
  await interaction.editReply(text ? `🤖 ${text}${strike ? '\n-# (this would count as a mean/NSFW flag for a member)' : ''}` : '⚠️ No AI provider answered (or AI is off). Members would get a pre-written reply. See `/bot ai action:status`.');
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

async function aiBlacklist(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext): Promise<void> {
  const act = interaction.options.getString('action', true);
  const actorId = interaction.user.id;
  if (act === 'list') {
    const rows = await ctx.db.aiBlock.findMany({ orderBy: { createdAt: 'asc' } });
    await interaction.editReply(
      rows.length
        ? `**Puppyboy Carter won't reply to:**\n${rows.map((r) => `• ${userMention(r.userId)} (${r.auto ? 'automatic' : `added by ${userMention(r.actorId ?? '')}`}, ${time(r.createdAt, TimestampStyles.ShortDate)})`).join('\n')}`.slice(0, 2000)
        : 'Nobody is blacklisted.',
    );
    return;
  }
  const user = interaction.options.getUser('user');
  if (!user) {
    await interaction.editReply(`❌ \`${act}\` needs the \`user\` option.`);
    return;
  }
  if (act === 'add') {
    if (user.id === interaction.guild.ownerId) {
      await interaction.editReply("❌ The server owner can't be blacklisted.");
      return;
    }
    await ctx.db.$transaction([
      ctx.db.aiBlock.upsert({ where: { userId: user.id }, create: { userId: user.id, auto: false, actorId }, update: { auto: false, actorId } }),
      ctx.db.auditLog.create({ data: { action: 'ai.block', actorId, targetId: user.id } }),
    ]);
    await ctx.modLog.post(`🙊 <@${actorId}> blacklisted <@${user.id}> from Puppyboy Carter's replies`);
    await interaction.editReply(`🙊 Puppyboy Carter won't reply to ${userMention(user.id)} any more.`);
    return;
  }
  // Removing also clears their strikes, so one more flag doesn't block them straight away.
  const [{ count }] = await ctx.db.$transaction([
    ctx.db.aiBlock.deleteMany({ where: { userId: user.id } }),
    ctx.db.aiStrike.deleteMany({ where: { userId: user.id } }),
    ctx.db.auditLog.create({ data: { action: 'ai.unblock', actorId, targetId: user.id } }),
  ]);
  if (count) await ctx.modLog.post(`✅ <@${actorId}> removed <@${user.id}> from Puppyboy Carter's blacklist`);
  await interaction.editReply(count ? `✅ Puppyboy Carter will reply to ${userMention(user.id)} again.` : `${userMention(user.id)} wasn't blacklisted.`);
}

const RANK: Record<AccessLevel, number> = { staff: 0, admin: 1, owner: 2 };

async function help(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  // Loaded here: the command list imports this file.
  const { COMMANDS } = (await import('./index.js')) as { COMMANDS: readonly Command[] };
  const mine: AccessLevel =
    interaction.guild.ownerId === interaction.user.id ? 'owner' : interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ? 'admin' : 'staff';
  const embed = new EmbedBuilder()
    .setTitle('📖 Commands you can use')
    .setColor(0xf1c40f)
    .setDescription(`You're **${mine}**. Members don't use commands: they use the buttons in the VIP lounge.`);
  for (const command of COMMANDS) {
    const subs = (command.data.options ?? []).filter((o) => o.type === ApplicationCommandOptionType.Subcommand);
    const lines = (subs.length ? subs : [null])
      .filter((sub) => RANK[command.levelFor(sub?.name ?? null, null)] <= RANK[mine])
      .map((sub) => {
        const text = (sub ?? command.data).description.replace(/^(Admin|Owner only): /, '');
        return `\`/${command.name}${sub ? ` ${sub.name}` : ''}\` ${text}`;
      });
    if (lines.length) embed.addFields({ name: `/${command.name}`, value: lines.join('\n').slice(0, 1024) });
  }
  await interaction.editReply({ embeds: [embed] });
}
