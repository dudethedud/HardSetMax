import { activityCommand, leaderboardCommand, statsCommand } from './activity.js';
import { botCommand } from './bot.js';
import { configCommand } from './config.js';
import { setupCommand, vipCommand } from './vip.js';
import type { AdminCommand } from './types.js';

export const COMMANDS: readonly AdminCommand[] = [botCommand, setupCommand, configCommand, vipCommand, statsCommand, leaderboardCommand, activityCommand];

export const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
