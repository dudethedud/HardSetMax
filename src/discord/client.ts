import { Client, GatewayIntentBits } from 'discord.js';

// GuildMembers is privileged (Developer Portal → Bot → Server Members Intent):
// needed to see role changes and to check everyone in the hourly sweep.
const REQUIRED_INTENTS = {
  Guilds: GatewayIntentBits.Guilds,
  GuildMembers: GatewayIntentBits.GuildMembers,
} as const;

export const REQUIRED_INTENT_NAMES = Object.keys(REQUIRED_INTENTS);

export function createClient(): Client {
  return new Client({
    intents: Object.values(REQUIRED_INTENTS),
    // Nothing the bot sends pings anyone.
    allowedMentions: { parse: [] },
  });
}
