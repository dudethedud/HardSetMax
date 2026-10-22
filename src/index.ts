import { Events } from 'discord.js';
import { loadEnv } from './config/env.js';
import { ConfigStore } from './config/configStore.js';
import { explainDbError, pgConfig } from './db/connection.js';
import { createDb } from './db/prisma.js';
import { createClient } from './discord/client.js';
import type { AppContext } from './discord/commands/types.js';
import { handleInteraction } from './discord/interactions.js';
import { registerCommands } from './discord/registerCommands.js';
import { createLogger } from './logger.js';
import { ActivityBuffer } from './services/activityBuffer.js';
import { acquireGatewayLeader } from './services/gatewayLeader.js';
import { MessageTracker } from './services/messageTracker.js';
import { createShutdown } from './services/shutdown.js';
import { TimeoutTracker } from './services/timeoutTracker.js';
import { VoiceTracker } from './services/voiceTracker.js';
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

const connection = pgConfig(env.DATABASE_URL, { caCertPath: env.DATABASE_CA_CERT });

// 1. Become the only connected copy before touching Discord (SPEC §11).
const leader = await acquireGatewayLeader(connection, log, {
  signal: waiting.signal,
  onLost: () => void shutdown.run('gateway-leader lost', 1),
}).catch((err: unknown) => {
  if (waiting.signal.aborted) return null; // Shutting down; shutdown.run exits.
  log.fatal({ err, hint: explainDbError(err) ?? undefined }, 'could not connect to the database');
  process.exit(1);
});
if (!leader) await new Promise(() => undefined);

const db = createDb(connection, env.DATABASE_POOL_MAX);
const client = createClient();
const config = new ConfigStore(db, env.GUILD_ID);
const buffer = new ActivityBuffer();
const messages = new MessageTracker(env.GUILD_ID, config, buffer);
const voice = new VoiceTracker(client, env.GUILD_ID, db, config, buffer, log);
const timeouts = new TimeoutTracker(env.GUILD_ID, db, log);
const timers: NodeJS.Timeout[] = [];

const FLUSH_MS = 30_000;
const VOICE_TICK_MS = 60_000;
const SWEEP_MS = 5 * 60_000;

async function flush(): Promise<void> {
  await buffer.flush(db);
  await voice.heartbeat();
}

// Shutdown order (SPEC §11): stop counting, close voice sessions, save everything,
// then Discord → DB → lock.
shutdown.add({
  name: 'activity',
  run: async () => {
    for (const t of timers) clearInterval(t);
    messages.stop();
    await voice.stop();
    for (let attempt = 1; ; attempt++) {
      try {
        await buffer.flush(db);
        return;
      } catch (err) {
        if (attempt >= 3) throw err;
        log.warn({ err, attempt }, 'final save failed; retrying');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  },
});
shutdown.add({ name: 'discord', run: () => client.destroy() });
shutdown.add({ name: 'database', run: () => db.$disconnect() });
shutdown.add({ name: 'gateway-leader', run: () => leader!.release() });

const ctx: AppContext = { env, log, db, leader: leader!, client, startedAt: new Date(), config, activity: buffer };

const logErrors =
  (what: string) =>
  (err: unknown): void =>
    log.error({ err }, `${what} failed`);

client.once(Events.ClientReady, (c) => {
  log.info({ user: c.user.tag }, 'connected to Discord');
  const guild = c.guilds.cache.get(env.GUILD_ID);
  if (!guild) {
    log.warn({ guildId: env.GUILD_ID }, 'bot is not in GUILD_ID; invite it first');
    return;
  }
  void (async () => {
    // Full member list: names, and the "before" state for timeout changes.
    await guild.members.fetch();
    for (const m of guild.members.cache.values()) if (!m.user.bot) buffer.setName(m.id, m.displayName);
    await voice.start();
    await timeouts.catchUp(guild);
  })().catch(logErrors('startup catch-up'));

  timers.push(
    setInterval(() => {
      flush().catch((err: unknown) => log.warn({ err, pending: buffer.pendingCount }, 'saving activity failed; will retry'));
    }, FLUSH_MS),
    setInterval(() => void voice.tick().catch(logErrors('voice tick')), VOICE_TICK_MS),
    setInterval(() => messages.sweep(), SWEEP_MS),
  );
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, ctx).catch(logErrors('interaction handler'));
});
client.on(Events.MessageCreate, (message) => {
  try {
    messages.handle(message);
  } catch (err) {
    logErrors('message tracking')(err);
  }
});
client.on(Events.VoiceStateUpdate, (before, after) => voice.onVoiceStateUpdate(before, after));
client.on(Events.GuildMemberAdd, (member) => {
  if (member.guild.id === env.GUILD_ID && !member.user.bot) buffer.setName(member.id, member.displayName);
});
client.on(Events.GuildMemberUpdate, (before, after) => {
  if (after.guild.id === env.GUILD_ID && !after.user.bot) buffer.setName(after.id, after.displayName);
  timeouts.onMemberUpdate(before, after).catch(logErrors('timeout tracking'));
});
client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
  timeouts.onAuditLogEntry(entry, guild).catch(logErrors('audit log cursor'));
});
client.on(Events.Error, (err) => log.error({ err }, 'discord client error'));

try {
  await config.load();
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
