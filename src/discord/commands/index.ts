import { botCommand } from './bot.js';
import { configCommand } from './config.js';
import type { AdminCommand } from './types.js';

export const COMMANDS: readonly AdminCommand[] = [botCommand, configCommand];

export const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
