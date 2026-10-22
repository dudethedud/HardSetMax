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
import { createClock } from './services/clock.js';
import { PermissionCheck } from './services/permissionCheck.js';
import { PRUNE_JOB, runPruneJob } from './services/prune.js';
import { ColourService } from './services/colours.js';
import { BadgeService } from './services/badges.js';
import { CrownService } from './services/crown.js';
import { TempVoiceService } from './services/tempVoice.js';
import { AiService, loadPrompts } from './services/ai/aiService.js';
import { ChatService } from './services/ai/chat.js';
import { RecapService } from './services/recap.js';
import { POLL_UNLOCK_JOB, PollService } from './services/polls.js';
import { ModLog } from './services/modLog.js';
import { loungePanel, Panels } from './services/panels.js';
import { RoleQueue } from './services/roleQueue.js';
import { DailyScheduler } from './services/scheduler.js';
import { runSetup } from './services/setup.js';
import { createShutdown } from './services/shutdown.js';
import { RESHUFFLE_JOB, VipService } from './services/vipService.js';
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
// Set once the services exist; the lock can only be lost after startup.
let onDatabaseDown: () => void = () => undefined;
let onDatabaseBack: () => void = () => undefined;
const leader = await acquireGatewayLeader(connection, log, {
  signal: waiting.signal,
  // Database-down mode (SPEC §13): keep counting in memory, pause jobs, reconnect.
  onLost: () => onDatabaseDown(),
  onRegained: () => onDatabaseBack(),
  onTakenOver: () => void shutdown.run('another copy took gateway-leader', 1),
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
const clock = createClock(env.CLOCK_OFFSET_MINUTES);
if (clock.offsetMinutes) log.warn({ offsetMinutes: clock.offsetMinutes }, 'TEST CLOCK: reshuffle times are shifted');
const modLog = new ModLog(client, config, log);
const roleQueue = new RoleQueue(client, env.GUILD_ID, log);
const vip = new VipService(client, env.GUILD_ID, db, config, buffer, roleQueue, modLog, clock, log);
const colours = new ColourService(client, env.GUILD_ID, db, config, roleQueue, vip, modLog, log);
const polls = new PollService(client, env.GUILD_ID, db, config, vip, modLog, clock, log);
const crown = new CrownService(client, env.GUILD_ID, db, config, roleQueue, modLog, clock, log);
vip.onRemoved.push((userId) => colours.onVipRemoved(userId));
vip.onRemoved.push((userId, reason) => crown.onVipRemoved(userId, reason));
const tempVoice = new TempVoiceService(client, env.GUILD_ID, db, config, vip, modLog, clock, log);
vip.onRemoved.push((userId) => tempVoice.onVipRemoved(userId));
const ai = new AiService(db, config, process.env, clock, log);
const chat = new ChatService(client, env.GUILD_ID, db, config, ai, vip, crown, loadPrompts(), clock, log);
vip.hype = (summary) => chat.hypeLine('vip-update', summary);
const badges = new BadgeService(client, env.GUILD_ID, db, config, roleQueue, modLog, log);
const recap = new RecapService(client, db, config, modLog, clock, log);
vip.badges = badges;
recap.hype = (summary) => chat.hypeLine('recap', summary);
// Order matters: the recap names the Crown holder that was just picked.
vip.onReshuffled.push(async (today, result) => {
  await crown.afterReshuffle(today, result);
  await recap.afterReshuffle(today, result);
  await chat.welcome(result.added.map((a) => a.userId));
});
vip.onAdded.push((userId) => colours.onVipAdded(userId));
const panels = new Panels(client, db, config, log, [loungePanel(() => colours.options())]);
const scheduler = new DailyScheduler(config, clock, log, () => leader!.isHeld());
scheduler.register(RESHUFFLE_JOB, (period) => vip.runReshuffle(RESHUFFLE_JOB, period));
scheduler.register(POLL_UNLOCK_JOB, (period) => polls.runUnlockJob(period));
scheduler.register(PRUNE_JOB, (period) => runPruneJob(db, config, clock, log, period));
const permissionCheck = new PermissionCheck(client, env.GUILD_ID, db, config, modLog);
onDatabaseDown = () => void modLog.post('⚠️ The database is unreachable. Activity is kept in memory and scheduled jobs are paused until it’s back.');
onDatabaseBack = () => {
  void modLog.post('✅ The database is back. Saving what was counted and catching up on scheduled jobs.');
  void flush().catch(logErrors('saving after the database came back'));
  void scheduler.check();
};
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
    scheduler.stop();
    messages.stop();
    await voice.stop();
    await roleQueue.idle();
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

const ctx: AppContext = {
  env,
  log,
  db,
  leader: leader!,
  client,
  startedAt: new Date(),
  config,
  activity: buffer,
  clock,
  modLog,
  vip,
  colours,
  crown,
  badges,
  polls,
  tempVoice,
  ai,
  chat,
  panels,
  runSetup: (guild) =>
    runSetup(guild, {
      steps: [
        (g, vipRole, report) => colours.setup(g, vipRole, report),
        (g, vipRole, report) => crown.setup(g, vipRole, report),
        (g, vipRole, report) => badges.setup(g, vipRole, report),
        (g, vipRole, report) => polls.setup(g, vipRole, report),
      ],
      db,
      config,
      panels,
      vip,
      log,
    }),
};

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
    // VIP: roles match the database, panels exist, missed announcements go out, then
    // the scheduler runs any reshuffle that was due while the bot was offline.
    await vip.reconcile();
    await colours.reconcile();
    await crown.reconcile();
    await badges.reconcile();
    await tempVoice.start();
    await polls.reconcileLocks();
    await panels.ensureAll();
    await vip.postPendingAnnouncements();
    scheduler.start();
    await permissionCheck.run();
  })().catch(logErrors('startup catch-up'));

  timers.push(
    setInterval(() => {
      flush().catch((err: unknown) => log.warn({ err, pending: buffer.pendingCount }, 'saving activity failed; will retry'));
    }, FLUSH_MS),
    setInterval(() => void voice.tick().catch(logErrors('voice tick')), VOICE_TICK_MS),
    setInterval(() => messages.sweep(), SWEEP_MS),
    setInterval(() => void tempVoice.sweep().catch(logErrors('temp voice check')), 15_000),
    setInterval(() => void permissionCheck.run().catch(logErrors('permission check')), 60 * 60_000),
  );
});
client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, ctx).catch(logErrors('interaction handler'));
});
client.on(Events.MessageCreate, (message) => {
  try {
    const outcome = messages.handle(message);
    polls.handleMessage(message);
    chat.handle(message, outcome).catch(logErrors('AI chat'));
  } catch (err) {
    logErrors('message tracking')(err);
  }
});
client.on(Events.VoiceStateUpdate, (before, after) => {
  voice.onVoiceStateUpdate(before, after);
  tempVoice.onVoiceStateUpdate(before, after);
});
client.on(Events.GuildMemberAdd, (member) => {
  if (member.guild.id === env.GUILD_ID && !member.user.bot) buffer.setName(member.id, member.displayName);
});
client.on(Events.GuildMemberUpdate, (before, after) => {
  if (after.guild.id === env.GUILD_ID && !after.user.bot) buffer.setName(after.id, after.displayName);
  timeouts.onMemberUpdate(before, after).catch(logErrors('timeout tracking'));
  vip.onMemberUpdate(before, after).catch(logErrors('VIP member update'));
});
client.on(Events.GuildMemberRemove, (member) => {
  vip.onMemberRemove(member).catch(logErrors('VIP member leave'));
});
client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
  timeouts.onAuditLogEntry(entry, guild).catch(logErrors('audit log cursor'));
});
client.on(Events.Error, (err) => log.error({ err }, 'discord client error'));

try {
  await config.load();
  await vip.load();
  await ai.ensureProviders();
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
