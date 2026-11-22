// The colour menu bot (docs/SPEC.md): starts after taking the gateway-leader lock,
// so only one copy is ever connected to Discord.
import type { Server } from 'node:http';
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
import { DonationService } from './services/donations.js';
import { edmontonTime } from './core/inviteEvent.js';
import { InviteEventService } from './services/inviteEvent.js';
import { startWebhookServer } from './services/webhookServer.js';
import { acquireGatewayLeader } from './services/gatewayLeader.js';
import { createShutdown } from './services/shutdown.js';
import { VERSION } from './version.js';

const SWEEP_EVERY_MS = 60 * 60_000;
/** The invite event's due-or-not steps (hourly check, Sunday posts, freeze) run this often. */
const INVITE_TICK_MS = 5 * 60_000;

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
const donations = new DonationService(client, env.GUILD_ID, db, log);
// The Christmas invite event, only when its channel and level role are set.
const invites =
  env.LEADERBOARD_CHANNEL_ID && env.LEVEL3_ROLE_ID
    ? new InviteEventService(client, env.GUILD_ID, db, log, {
        end: edmontonTime(env.INVITE_EVENT_END),
        leaderboardChannelId: env.LEADERBOARD_CHANNEL_ID,
        level3RoleId: env.LEVEL3_ROLE_ID,
        staffLogChannelId: env.STAFF_LOG_CHANNEL_ID ?? null,
        inviteLinkChannelId: env.INVITE_LINK_CHANNEL_ID ?? null,
        color: env.EMBED_COLOR,
      })
    : null;
if (!invites && (env.LEADERBOARD_CHANNEL_ID || env.LEVEL3_ROLE_ID)) log.warn('invite event needs both LEADERBOARD_CHANNEL_ID and LEVEL3_ROLE_ID: it is off');
const ctx: AppContext = { env, log, db, client, colours, donations, invites };

// Steps run in order: stop taking Ko-fi donations before the database closes.
let webhook: Server | null = null;
shutdown.add({
  name: 'webhook server',
  run: () =>
    new Promise<void>((resolve) => {
      if (!webhook) return resolve();
      webhook.close(() => resolve());
      webhook.closeIdleConnections();
    }),
});
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
  const guild = c.guilds.cache.get(env.GUILD_ID);
  if (invites && guild) {
    const tick = () => void invites.tick(guild).catch(logErrors('invite event tick'));
    void invites.start(guild).then(tick, logErrors('invite event start'));
    setInterval(tick, INVITE_TICK_MS).unref();
  }
});
client.on(Events.InviteCreate, (invite) => invites?.onInviteCreate(invite));
client.on(Events.InviteDelete, (invite) => invites?.onInviteDelete(invite));
client.on(Events.GuildMemberAdd, (member) => {
  invites?.onMemberAdd(member).catch(logErrors('invite event join'));
});
client.on(Events.GuildMemberRemove, (member) => {
  invites?.onMemberRemove(member.id, member.guild.id).catch(logErrors('invite event leave'));
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, ctx).catch(logErrors('interaction handler'));
});
client.on(Events.GuildMemberUpdate, (_before, after) => {
  colours.check(after).catch(logErrors('colour check'));
  invites?.onMemberUpdate(after).catch(logErrors('invite event role check'));
});
client.on(Events.Error, (err) => log.error({ err }, 'discord client error'));

try {
  await colours.load();
  // Ko-fi donations: only when a token is set, on the host's port.
  const port = env.WEBHOOK_PORT ?? env.SERVER_PORT;
  if (env.KOFI_VERIFICATION_TOKEN && port) {
    const token = env.KOFI_VERIFICATION_TOKEN;
    webhook = await startWebhookServer(port, (body) => donations.handleKofi(body, token), log);
  } else if (env.KOFI_VERIFICATION_TOKEN) {
    log.warn('KOFI_VERIFICATION_TOKEN is set but there is no port (WEBHOOK_PORT or SERVER_PORT): Ko-fi donations are off');
  }
  await registerCommands(env, log);
  await client.login(env.DISCORD_TOKEN);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('disallowed intents')) log.fatal('Discord refused the intents. Turn on Server Members Intent in the Developer Portal.');
  else log.fatal({ err }, 'startup failed');
  await shutdown.run('startup failed', 1);
}
