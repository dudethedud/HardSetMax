import { hostname } from 'node:os';
import { EmbedBuilder, time, TimestampStyles } from 'discord.js';
import { dayBoundaryOf, getGuildConfig } from '../../config/guildConfig.js';
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
      const day = serverDayAt(new Date(), dayBoundaryOf(await getGuildConfig(db, interaction.guildId)));
      dayLine = `\`${day.key}\`, next boundary ${time(day.end, TimestampStyles.RelativeTime)}`;
    } catch (err) {
      ctx.log.warn({ err }, 'health: database check failed');
      dbLine = '❌ unreachable';
    }

    const copy = `pid ${process.pid}, ${hostname()}`;

    const embed = new EmbedBuilder().setTitle('Bot health').addFields(
      { name: 'Version', value: VERSION, inline: true },
      { name: 'Up since', value: time(startedAt, TimestampStyles.RelativeTime), inline: true },
      { name: 'Discord ping', value: `${client.ws.ping} ms`, inline: true },
      { name: 'Database', value: dbLine },
      {
        name: 'Gateway leader',
        value: leader.isHeld()
          ? `✅ this copy (${copy}) since ${time(leader.acquiredAt, TimestampStyles.RelativeTime)}`
          : '❌ lock lost; this copy is shutting down',
      },
      // Logging in succeeds only if every requested privileged intent is enabled.
      { name: 'Intents', value: `✅ ${REQUIRED_INTENT_NAMES.join(', ')}` },
      { name: 'Server-day', value: dayLine },
      { name: 'Last reshuffle', value: 'not built yet (Phase 4)', inline: true },
      { name: 'Pending writes', value: 'none (activity tracking is Phase 2)', inline: true },
      { name: 'AI', value: 'not built yet (Phase 9)', inline: true },
    );

    await interaction.editReply({ embeds: [embed] });
  },
);
