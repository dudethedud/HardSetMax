import { announceCommand } from '../announce.js';
import { botCommand } from './bot.js';
import { settingsCommand } from './settings.js';
import { statsCommand } from './stats.js';
import { vipCommand } from './vip.js';
import type { Command } from './types.js';

export const COMMANDS: readonly Command[] = [statsCommand, vipCommand, settingsCommand, botCommand, announceCommand];

export const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
