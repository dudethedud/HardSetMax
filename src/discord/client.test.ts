import { describe, expect, it } from 'vitest';
import { createClient, REQUIRED_INTENT_NAMES } from './client.js';

describe('client', () => {
  it('needs these intents (Server Members is the only privileged one)', () => {
    expect(REQUIRED_INTENT_NAMES).toEqual(['Guilds', 'GuildMembers', 'GuildInvites', 'GuildMessages']);
  });

  it('keeps no messages in memory: check-ins only need when members talk', async () => {
    const client = createClient();
    // A text channel's message cache (what every incoming message would be added to).
    const { GuildMessageManager, Message, MessageManager } = await import('discord.js');
    const cache = client.options.makeCache!(MessageManager as never, Message, GuildMessageManager as never);
    expect((cache as { maxSize?: number }).maxSize).toBe(0);
    await client.destroy();
  });
});
