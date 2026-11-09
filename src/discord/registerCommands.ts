// Registers the slash commands to the one configured guild (never globally).
// Runs on every startup; `npm run register-commands` (src/cli/registerCommands.ts)
// does it by hand.
import { REST, Routes } from 'discord.js';
import type { Env } from '../config/env.js';
import type { Logger } from '../logger.js';
import { COMMANDS } from './commands/index.js';

export async function registerCommands(env: Env, log: Logger): Promise<void> {
  const rest = new REST().setToken(env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.GUILD_ID), {
    body: COMMANDS.map((c) => c.data),
  });
  log.info({ commands: COMMANDS.map((c) => c.name) }, 'registered guild commands');
}
