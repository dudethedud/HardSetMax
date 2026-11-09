// The colour menu bot (docs/SPEC.md): starts after taking the gateway-leader lock,
// so only one copy is ever connected to Discord.
import { Events } from 'discord.js';
import { loadEnv } from './config/env.js';
import { explainDbError, pgConfig } from './db/connection.js';
import { createDb } from './db/prisma.js';
import { createClient } from './discord/client.js';
import type { AppContext } from './discord/commands/types.js';
import { handleInteraction } from './discord/interactions.js';
import { registerCommands } from './discord/registerCommands.js';
import { createLogger } from './logger.js';
import { ColourMenuService } from './services/colourMenus.js';
import { acquireGatewayLeader } from './services/gatewayLeader.js';
import { createShutdown } from './services/shutdown.js';
import { VERSION } from './version.js';

const SWEEP_EVERY_MS = 60 * 60_000;

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
const connection = pgConfig(env.DATABASE_URL, { caCertPath: env.DATABASE_CA_CERT });

// Become the only connected copy before touching Discord.
const leader = await acquireGatewayLeader(connection, log, {
  signal: waiting.signal,
  onLost: () => log.warn('lost the database connection; retrying'),
  onRegained: () => log.info('database connection back'),
  onTakenOver: () => void shutdown.run('another copy took gateway-leader', 1),
}).catch((err: unknown) => {
  if (waiting.signal.aborted) return null; // Shutting down; shutdown.run exits.
  log.fatal({ err, hint: explainDbError(err) ?? undefined }, 'could not connect to the database');
  process.exit(1);
});
if (!leader) await new Promise(() => undefined);

const db = createDb(connection, env.DATABASE_POOL_MAX);
const client = createClient();
const colours = new ColourMenuService(client, env.GUILD_ID, db, log);
const ctx: AppContext = { env, log, db, client, colours };

shutdown.add({ name: 'discord', run: () => client.destroy() });
shutdown.add({ name: 'database', run: () => db.$disconnect() });
shutdown.add({ name: 'gateway-leader', run: () => leader!.release() });

const logErrors = (what: string) => (err: unknown) => log.error({ err }, `${what} failed`);
const sweep = () => {
  const guild = client.guilds.cache.get(env.GUILD_ID);
  if (guild) void colours.sweep(guild).catch(logErrors('colour sweep'));
};

client.once(Events.ClientReady, (c) => {
  log.info({ user: c.user.tag }, 'connected to Discord');
  if (!c.guilds.cache.has(env.GUILD_ID)) log.error({ guildId: env.GUILD_ID }, 'the bot is not in the GUILD_ID server: invite it, then restart');
  // Catch up on anyone who stopped repping while the bot was offline, then every hour.
  sweep();
  setInterval(sweep, SWEEP_EVERY_MS).unref();
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, ctx).catch(logErrors('interaction handler'));
});
client.on(Events.GuildMemberUpdate, (_before, after) => {
  colours.check(after).catch(logErrors('colour check'));
});
client.on(Events.Error, (err) => log.error({ err }, 'discord client error'));

try {
  await colours.load();
  await registerCommands(env, log);
  await client.login(env.DISCORD_TOKEN);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('disallowed intents')) log.fatal('Discord refused the intents. Turn on Server Members Intent in the Developer Portal.');
  else log.fatal({ err }, 'startup failed');
  await shutdown.run('startup failed', 1);
}
