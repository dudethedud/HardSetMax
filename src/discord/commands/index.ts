import { coloursCommand } from './colours.js';
import { donationsCommand } from './donations.js';
import type { Command } from './types.js';

export const COMMANDS: Command[] = [coloursCommand, donationsCommand];
export const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
