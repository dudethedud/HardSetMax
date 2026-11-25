import { Client, GatewayIntentBits } from 'discord.js';

// GuildMembers is privileged (Developer Portal → Bot → Server Members Intent):
// needed to see role changes and joins, and to check everyone in the hourly sweep.
// GuildInvites (not privileged): invite create/delete events for the invite event.
// GuildMessages (not privileged): when members talk, for check-in DMs. Without the
// Message Content intent Discord sends no message text, and none is ever stored.
const REQUIRED_INTENTS = {
  Guilds: GatewayIntentBits.Guilds,
  GuildMembers: GatewayIntentBits.GuildMembers,
  GuildInvites: GatewayIntentBits.GuildInvites,
  GuildMessages: GatewayIntentBits.GuildMessages,
} as const;

export const REQUIRED_INTENT_NAMES = Object.keys(REQUIRED_INTENTS);

export function createClient(): Client {
  return new Client({
    intents: Object.values(REQUIRED_INTENTS),
    // Nothing the bot sends pings anyone.
    allowedMentions: { parse: [] },
  });
}
