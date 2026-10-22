import { hostname } from 'node:os';
import { EmbedBuilder, IntentsBitField, time, TimestampStyles } from 'discord.js';
import { MANUAL_RESHUFFLE_JOB, RESHUFFLE_JOB } from '../../services/vipService.js';
import { serverDayAt } from '../../core/serverDay.js';
import { VERSION } from '../../version.js';
import { REQUIRED_INTENT_NAMES } from '../client.js';
import { defineAdminCommand } from './types.js';

export const botCommand = defineAdminCommand(
  'bot',
  'Bot status',
  (b) => b.addSubcommand((s) => s.setName('health').setDescription('Version, uptime, database, leader lock and intents')),
  async (interaction, ctx) => {
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
  },
);
