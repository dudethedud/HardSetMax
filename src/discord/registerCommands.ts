// Registers the slash commands to the one configured guild (never globally).
// Runs on every startup; `npm run register-commands` does it by hand.
import { pathToFileURL } from 'node:url';
import { REST, Routes } from 'discord.js';
import { loadEnv, type Env } from '../config/env.js';
import { createLogger, type Logger } from '../logger.js';
import { COMMANDS } from './commands/index.js';

export async function registerCommands(env: Env, log: Logger): Promise<void> {
  const rest = new REST().setToken(env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.GUILD_ID), {
    body: COMMANDS.map((c) => c.data),
  });
  log.info({ commands: COMMANDS.map((c) => c.name) }, 'registered guild commands');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnv();
  await registerCommands(env, createLogger(env.LOG_LEVEL));
}
