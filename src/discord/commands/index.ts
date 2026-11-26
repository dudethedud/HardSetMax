import { checkinsCommand } from './checkins.js';
import { coloursCommand } from './colours.js';
import { donationsCommand } from './donations.js';
import { inviteEventCommand, inviteLinkCommand, invitesCommand, leaderboardCommand } from './invites.js';
import type { Command } from './types.js';

export const COMMANDS: Command[] = [coloursCommand, donationsCommand, invitesCommand, leaderboardCommand, inviteLinkCommand, inviteEventCommand, checkinsCommand];
export const COMMANDS_BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
