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
export const CROWN_POWERS_ID = 'crown:powers';
export const CROWN_PARDON_ID = 'crown:pardon';
export const CROWN_MOOD_ID = 'crown:mood';
export const CROWN_SPOTLIGHT_ID = 'crown:spotlight';
export const CROWN_THEME_ID = 'crown:theme';
export const CROWN_RAINBOW_ID = 'crown:rainbow';
export const VIP_PROFILE_ID = 'vip:profile';
export const VIP_SHOUTOUT_ID = 'vip:shoutout';
export const VIP_TREAT_ID = 'vip:treat';
export const VIP_COLOUR_REQUEST_ID = 'vip:colour-request';

/** The Crown's buttons, shown privately to the Crown holder from the panel's Crown powers button. */
export function crownPowersRows(): ActionRowBuilder<ButtonBuilder>[] {
  const b = (id: string, label: string, emoji: string) => new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b(CROWN_CREATE_ID, 'Create your role', '👑').setStyle(ButtonStyle.Primary),
      b(CROWN_EDIT_ID, 'Edit your role', '✏️'),
      b(CROWN_TITLES_ID, 'Titles', '🎖️'),
      b(CROWN_DECREE_ID, 'Decree', '📜'),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      b(CROWN_PARDON_ID, 'Pardon', '🛡️'),
      b(CROWN_MOOD_ID, "Carter's mood", '🎭'),
      b(CROWN_SPOTLIGHT_ID, 'Spotlight', '📌'),
      b(CROWN_THEME_ID, 'Theme', '🎵'),
      b(CROWN_RAINBOW_ID, 'Rainbow speech', '🌈'),
    ),
  ];
}

/** The VIP lounge panel: perks, the colour dropdown, the VIP buttons and the Crown powers button. */
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
            '**⭐ VIP perks**',
            '• Image, embed, emoji, sticker and soundboard perms everywhere',
            '• This lounge, your own voice channel, a VIP colour (pick below) and VIP polls',
            '• 📣 A daily shoutout, 🦴 a daily treat to give, 🎨 colour suggestions, a 🪪 profile card',
            '• 💎 14 days in a row makes you a Veteran: a second daily shoutout',
            '• 🐶 Carter answers VIPs first when he’s busy',
            '',
            '**👑 Crown of the week** (the #1 VIP): a custom role, a 👑 name, three titles to hand out, a decree, a pardon, Carter’s mood, a spotlight, the theme, rainbow speech and a voice hall. All under **👑 Crown powers**.',
            '',
            'Stay active to keep your slot. VIPs keep it down to rank #13, and nobody loses it in their first 5 days.',
          ].join('\n'),
        );
      const vipRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(VIP_PROFILE_ID).setLabel('My profile').setEmoji('🪪').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(VIP_SHOUTOUT_ID).setLabel('Shoutout').setEmoji('📣').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(TEMP_VOICE_CREATE_ID).setLabel('Create VIP voice').setEmoji('🔊').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(VIP_TREAT_ID).setLabel('Give a treat').setEmoji('🦴').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(VIP_COLOUR_REQUEST_ID).setLabel('Suggest a colour').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
      );
      // The Crown's buttons open privately (crownPowersMenu), so the panel stays short for everyone else.
      const crownRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(CROWN_POWERS_ID).setLabel('Crown powers').setEmoji('👑').setStyle(ButtonStyle.Primary),
      );
      const colourRows = options.length
        ? [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(COLOUR_PICKER_ID)
                .setPlaceholder('🎨 Pick your VIP colour')
                .addOptions(
                  ...options.map((o) => new StringSelectMenuOptionBuilder().setLabel(o.name).setValue(String(o.id)).setDescription(o.hex2 ? `${o.hex} → ${o.hex2} gradient` : o.hex)),
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
