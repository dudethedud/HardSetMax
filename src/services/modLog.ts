// Posts to the mod-log channel (SPEC §1.6: every role change is logged with a
// reason), as an embed coloured by the kind of entry. Never pings anyone. If no
// channel is set, entries only go to the logs.
import { AttachmentBuilder, EmbedBuilder, type ActionRowBuilder, type ButtonBuilder, type Client } from 'discord.js';
import { logStyle } from '../core/logStyle.js';
import type { ConfigStore } from '../config/configStore.js';
import type { Logger } from '../logger.js';

export class ModLog {
  constructor(
    private readonly client: Client,
    private readonly config: ConfigStore,
    private readonly log: Logger,
  ) {}

  /**
   * `image`: shown in the entry (e.g. an uploaded role icon, for staff to check).
   * `extra.components`: buttons for staff (fixed IDs). Returns the message ID, or null if it wasn't posted.
   */
  async post(text: string, image?: { name: string; data: Buffer }, extra: { components?: ActionRowBuilder<ButtonBuilder>[]; colour?: number } = {}): Promise<string | null> {
    this.log.info({ modLog: text }, 'mod-log');
    const id = this.config.current.guild.modLogChannelId;
    if (!id) return null;
    try {
      const channel = await this.client.channels.fetch(id);
      if (!channel?.isSendable()) throw new Error('not a text channel the bot can post in');
      const { colour, title } = logStyle(text);
      const embed = new EmbedBuilder().setColor(extra.colour ?? colour).setAuthor({ name: title }).setDescription(text.slice(0, 4096)).setTimestamp(new Date());
      if (image) embed.setThumbnail(`attachment://${image.name}`);
      const files = image ? [new AttachmentBuilder(image.data, { name: image.name })] : [];
      const message = await channel.send({ embeds: [embed], files, components: extra.components ?? [], allowedMentions: { parse: [] } });
      return message.id;
    } catch (err) {
      this.log.warn({ err, channelId: id }, "couldn't post to the mod-log channel");
      return null;
    }
  }
}
