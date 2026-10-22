// Panels: bot-posted messages with buttons/dropdowns (SPEC §11 "Panels keep
// working after restarts"). Their components use fixed custom IDs handled by the
// global interaction handler, and each panel's message ID is saved in the database.
// On startup and /setup run, missing or deleted panels are re-posted and existing
// ones are updated to the current version.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type MessageCreateOptions,
} from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import type { Db } from '../db/prisma.js';
import type { ColourOption, GuildConfig } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';

export interface PanelDef {
  kind: string;
  channelId: (config: GuildConfig) => string | null;
  render: () => Promise<Pick<MessageCreateOptions, 'content' | 'embeds' | 'components'>>;
}

export const COLOUR_PICKER_ID = 'vip:colour-picker';
export const COLOUR_NONE = 'none';
export const CROWN_CREATE_ID = 'crown:create-role';
export const CROWN_EDIT_ID = 'crown:edit-role';

/** The VIP lounge panel: perks, and the colour dropdown. Later phases add more buttons. */
export function loungePanel(colourOptions: () => Promise<ColourOption[]>): PanelDef {
  return {
    kind: 'lounge',
    channelId: (c) => c.loungeTextId,
    render: async () => {
      const options = (await colourOptions()).filter((o) => o.roleId);
      const embed = new EmbedBuilder()
        .setTitle('⭐ VIP Lounge')
        .setColor(0xf1c40f)
        .setDescription(
          [
            'Welcome! VIP goes to the 10 most active members of the last 7 days, updated every day at midnight.',
            '',
            '**VIP perks**',
            '• Image and embed perms everywhere',
            '• External emojis, stickers and soundboard',
            '• This private lounge (text and voice)',
            '• A VIP colour (pick below) and VIP polls in the polls channel',
            '• 👑 Crown of the week: the #1 VIP each week can create their own role',
            '',
            'Stay active to keep your slot. VIPs keep it down to rank #13, and nobody loses it in their first 5 days.',
          ].join('\n'),
        );
      const crownRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(CROWN_CREATE_ID).setLabel('Create your role').setEmoji('👑').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(CROWN_EDIT_ID).setLabel('Edit your role').setStyle(ButtonStyle.Secondary),
      );
      const colourRows = options.length
        ? [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(COLOUR_PICKER_ID)
                .setPlaceholder('🎨 Pick your VIP colour')
                .addOptions(
                  ...options.map((o) => new StringSelectMenuOptionBuilder().setLabel(o.name).setValue(String(o.id)).setDescription(o.hex)),
                  new StringSelectMenuOptionBuilder().setLabel('Remove colour').setValue(COLOUR_NONE).setEmoji('✖️'),
                ),
            ),
          ]
        : [];
      return { embeds: [embed], components: [...colourRows, crownRow] };
    },
  };
}

export class Panels {
  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly log: Logger,
    private readonly defs: readonly PanelDef[],
  ) {}

  /** Posts missing panels and updates existing ones. Returns a line per panel. */
  async ensureAll(): Promise<string[]> {
    const report: string[] = [];
    for (const def of this.defs) {
      try {
        report.push(await this.#ensure(def));
      } catch (err) {
        this.log.warn({ err, panel: def.kind }, 'panel check failed');
        report.push(`⚠️ ${def.kind} panel: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return report;
  }

  async #ensure(def: PanelDef): Promise<string> {
    const channelId = def.channelId(this.config.current.guild);
    if (!channelId) return `⏭️ ${def.kind} panel: channel not set up yet`;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable() || !('messages' in channel)) return `⚠️ ${def.kind} panel: channel missing; run /setup run`;

    const saved = await this.db.panel.findUnique({ where: { kind: def.kind } });
    const content = await def.render();
    if (saved && saved.channelId === channelId) {
      const message = await channel.messages.fetch(saved.messageId).catch(() => null);
      if (message) {
        await message.edit(content);
        return `✅ ${def.kind} panel up to date`;
      }
    }
    const message = await channel.send({ ...content, allowedMentions: { parse: [] } });
    await this.db.panel.upsert({
      where: { kind: def.kind },
      create: { kind: def.kind, channelId, messageId: message.id },
      update: { channelId, messageId: message.id },
    });
    return `✅ ${def.kind} panel posted`;
  }
}
