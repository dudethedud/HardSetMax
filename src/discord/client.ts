import { Client, GatewayIntentBits } from 'discord.js';

// SPEC §2 "Required Discord intents". GuildMembers and MessageContent are privileged
// and must be enabled in the Developer Portal, or login fails with code 4014.
const REQUIRED_INTENTS = {
  Guilds: GatewayIntentBits.Guilds,
  GuildMembers: GatewayIntentBits.GuildMembers,
  GuildMessages: GatewayIntentBits.GuildMessages,
  MessageContent: GatewayIntentBits.MessageContent,
  GuildVoiceStates: GatewayIntentBits.GuildVoiceStates,
  GuildModeration: GatewayIntentBits.GuildModeration,
} as const;

export const REQUIRED_INTENT_NAMES = Object.keys(REQUIRED_INTENTS);

export function createClient(): Client {
  return new Client({
    intents: Object.values(REQUIRED_INTENTS),
    // Nothing the bot sends pings anyone unless a call opts in explicitly.
    allowedMentions: { parse: [] },
  });
}
