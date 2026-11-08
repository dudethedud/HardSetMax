import { coloursCommand } from './colours.js';
import type { Command } from './types.js';

export const COMMANDS: Command[] = [coloursCommand];
export const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
