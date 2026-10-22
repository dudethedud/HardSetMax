// Posts to the mod-log channel (SPEC §1.6: every role change is logged with a
// reason). Never pings anyone. If no channel is set, entries only go to the logs.
import type { Client } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import type { Logger } from '../logger.js';

export class ModLog {
  constructor(
    private readonly client: Client,
    private readonly config: ConfigStore,
    private readonly log: Logger,
  ) {}

  async post(text: string): Promise<void> {
    this.log.info({ modLog: text }, 'mod-log');
    const id = this.config.current.guild.modLogChannelId;
    if (!id) return;
    try {
      const channel = await this.client.channels.fetch(id);
      if (!channel?.isSendable()) throw new Error('not a text channel the bot can post in');
      await channel.send({ content: text.slice(0, 2000), allowedMentions: { parse: [] } });
    } catch (err) {
      this.log.warn({ err, channelId: id }, "couldn't post to the mod-log channel");
    }
  }
}
