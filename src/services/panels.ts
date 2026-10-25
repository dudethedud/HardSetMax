// Panels: bot-posted messages with buttons/dropdowns (SPEC §11 "Panels keep
// working after restarts"). Their components use fixed custom IDs handled by the
// global interaction handler, and each panel's message ID is saved in the database.
// On startup and /bot setup, missing or deleted panels are re-posted and existing
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
import { TEMP_VOICE_CREATE_ID } from './tempVoice.js';

export interface PanelDef {
  kind: string;
  channelId: (config: GuildConfig) => string | null;
  render: () => Promise<Pick<MessageCreateOptions, 'content' | 'embeds' | 'components'>>;
}

export const COLOUR_PICKER_ID = 'vip:colour-picker';
export const COLOUR_NONE = 'none';
export const CROWN_CREATE_ID = 'crown:create-role';
export const CROWN_EDIT_ID = 'crown:edit-role';
export const CROWN_TITLES_ID = 'crown:titles';
export const CROWN_DECREE_ID = 'crown:decree';
export const VIP_PROFILE_ID = 'vip:profile';
export const VIP_SHOUTOUT_ID = 'vip:shoutout';

/** The VIP lounge panel: perks, the colour dropdown, and the VIP and Crown buttons. */
export function loungePanel(colourOptions: () => Promise<ColourOption[]>): PanelDef {
  return {
    kind: 'lounge',
    // The read-only #vip-perks; the chat channel on installs set up before it existed.
    channelId: (c) => c.loungePerksId ?? c.loungeTextId,
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
            '• This private lounge (text and voice), plus your own temporary voice channel (button below)',
            '• A VIP colour (pick below) and VIP polls in the polls channel',
            '• ⭐ Your name on the public VIP board, a profile card, and one 📣 shoutout a day in main chat',
            '',
            '**👑 Crown of the week** (the #1 VIP each week)',
            '• Your own custom role and a 👑 in front of your name',
            '• Hand out three titles: Champion, Advisor and Jester',
            '• One 📜 decree a week in announcements',
            '• Your own hall: a voice channel with Priority Speaker',
            '',
            'Use the buttons below for your perks. Chat with the other VIPs in the lounge chat channel.',
            '',
            'Stay active to keep your slot. VIPs keep it down to rank #13, and nobody loses it in their first 5 days.',
          ].join('\n'),
        );
      const vipRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(VIP_PROFILE_ID).setLabel('My profile').setEmoji('🪪').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(VIP_SHOUTOUT_ID).setLabel('Shoutout').setEmoji('📣').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(TEMP_VOICE_CREATE_ID).setLabel('Create VIP voice').setEmoji('🔊').setStyle(ButtonStyle.Success),
      );
      const crownRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(CROWN_CREATE_ID).setLabel('Create your role').setEmoji('👑').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(CROWN_EDIT_ID).setLabel('Edit your role').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(CROWN_TITLES_ID).setLabel('Titles').setEmoji('🎖️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(CROWN_DECREE_ID).setLabel('Decree').setEmoji('📜').setStyle(ButtonStyle.Secondary),
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
      return { embeds: [embed], components: [...colourRows, vipRow, crownRow] };
    },
  };
}

export class Panels {
  /** Panel writes run one at a time, so a refresh can't race a re-post. */
  #queue: Promise<unknown> = Promise.resolve();
  #soon = new Map<string, NodeJS.Timeout>();

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
    for (const def of this.defs) report.push(await this.#ensureQueued(def));
    return report;
  }

  /** Re-renders one panel now. */
  async refresh(kind: string): Promise<string> {
    const def = this.defs.find((d) => d.kind === kind);
    return def ? this.#ensureQueued(def) : `⚠️ no ${kind} panel`;
  }

  /** Re-renders one panel a few seconds from now; changes in a burst cause one edit. */
  refreshSoon(kind: string, delayMs = 5_000): void {
    if (this.#soon.has(kind)) return;
    const timer = setTimeout(() => {
      this.#soon.delete(kind);
      void this.refresh(kind);
    }, delayMs);
    timer.unref();
    this.#soon.set(kind, timer);
  }

  stop(): void {
    for (const t of this.#soon.values()) clearTimeout(t);
    this.#soon.clear();
  }

  #ensureQueued(def: PanelDef): Promise<string> {
    const run = this.#queue.then(() =>
      this.#ensure(def).catch((err: unknown) => {
        this.log.warn({ err, panel: def.kind }, 'panel check failed');
        return `⚠️ ${def.kind} panel: ${err instanceof Error ? err.message : String(err)}`;
      }),
    );
    this.#queue = run;
    return run;
  }

  async #ensure(def: PanelDef): Promise<string> {
    const channelId = def.channelId(this.config.current.guild);
    if (!channelId) return `⏭️ ${def.kind} panel: channel not set up yet`;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable() || !('messages' in channel)) return `⚠️ ${def.kind} panel: channel missing; run /bot setup`;

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
    // Moved to another channel: take the old copy down so its buttons don't linger.
    if (saved && saved.channelId !== channelId) {
      const old = await this.client.channels.fetch(saved.channelId).catch(() => null);
      if (old && 'messages' in old) await old.messages.delete(saved.messageId).catch(() => undefined);
    }
    await this.db.panel.upsert({
      where: { kind: def.kind },
      create: { kind: def.kind, channelId, messageId: message.id },
      update: { channelId, messageId: message.id },
    });
    return `✅ ${def.kind} panel posted`;
  }
}
