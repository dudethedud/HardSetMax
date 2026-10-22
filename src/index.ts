import { Events } from 'discord.js';
import { loadEnv } from './config/env.js';
import { getGuildConfig } from './config/guildConfig.js';
import { createDb } from './db/prisma.js';
import { createClient } from './discord/client.js';
import type { AppContext } from './discord/commands/types.js';
import { handleInteraction } from './discord/interactions.js';
import { registerCommands } from './discord/registerCommands.js';
import { createLogger } from './logger.js';
import { acquireGatewayLeader } from './services/gatewayLeader.js';
import { createShutdown } from './services/shutdown.js';
import { VERSION } from './version.js';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
const shutdown = createShutdown(log);

// A signal while waiting for the lock just stops waiting.
const waiting = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    waiting.abort(new Error(signal));
    void shutdown.run(signal);
  });
}
process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception');
  void shutdown.run('uncaughtException', 1);
});

log.info({ version: VERSION }, 'starting');

// 1. Become the only connected copy before touching Discord (SPEC §11).
const leader = await acquireGatewayLeader(env.DATABASE_URL, log, {
  signal: waiting.signal,
  onLost: () => void shutdown.run('gateway-leader lost', 1),
}).catch((err: unknown) => {
  if (waiting.signal.aborted) return null; // Shutting down; shutdown.run exits.
  throw err;
});
if (!leader) await new Promise(() => undefined);

const db = createDb(env.DATABASE_URL);
const client = createClient();

// Shutdown order: (later phases: flush buffers, close voice sessions) → Discord → DB → lock.
shutdown.add({ name: 'discord', run: () => client.destroy() });
shutdown.add({ name: 'database', run: () => db.$disconnect() });
shutdown.add({ name: 'gateway-leader', run: () => leader!.release() });

const ctx: AppContext = { env, log, db, leader: leader!, client, startedAt: new Date() };

client.once(Events.ClientReady, (c) => {
  log.info({ user: c.user.tag }, 'connected to Discord');
  if (!c.guilds.cache.has(env.GUILD_ID)) log.warn({ guildId: env.GUILD_ID }, 'bot is not in GUILD_ID; invite it first');
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, ctx).catch((err: unknown) => log.error({ err }, 'interaction handler failed'));
});
client.on(Events.Error, (err) => log.error({ err }, 'discord client error'));

try {
  await getGuildConfig(db, env.GUILD_ID);
  await registerCommands(env, log);
  await client.login(env.DISCORD_TOKEN);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('disallowed intents')) {
    log.fatal('Discord refused the intents. Turn on Server Members and Message Content in the Developer Portal.');
  } else {
    log.fatal({ err }, 'startup failed');
  }
  await shutdown.run('startup failed', 1);
}
