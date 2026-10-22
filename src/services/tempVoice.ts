// Temporary VIP voice channels (SPEC §8). Created from the lounge panel in the VIP
// Lounge category (so only VIPs can see them), one per VIP. The owner controls them
// with buttons posted in the channel's text chat. Deleted after 60 s empty, or as
// soon as they're empty if the owner lost VIP.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  type Guild,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { canRename, checkRoomName, defaultRoomName, roomAction } from '../core/tempVoice.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import type { ModLog } from './modLog.js';
import type { VipService } from './vipService.js';

export const TEMP_VOICE_CREATE_ID = 'tempvoice:create';
export const TEMP_VOICE_RENAME_ID = 'tempvoice:rename';
export const TEMP_VOICE_LIMIT_ID = 'tempvoice:limit';

export class TempVoiceService {
  /** channelId → recent rename times (Discord allows 2 per 10 minutes). */
  #renames = new Map<string, number[]>();
  #sweeping: Promise<void> | null = null;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly vip: VipService,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  #guild(): Guild | undefined {
    return this.client.guilds.cache.get(this.guildId);
  }

  #voice(guild: Guild, channelId: string): VoiceChannel | null {
    const ch = guild.channels.cache.get(channelId);
    return ch?.type === ChannelType.GuildVoice ? ch : null;
  }

  /** The lounge button. Returns the private reply. */
  async create(userId: string): Promise<string> {
    if (!this.vip.vips.has(userId)) return '🔊 VIP voice channels are for VIPs only.';
    const guild = this.#guild();
    const categoryId = this.config.current.guild.loungeCategoryId;
    if (!guild || !categoryId) return '❌ The VIP Lounge isn’t set up. Ask an admin to run /setup run.';

    const existing = await this.db.tempVoiceChannel.findUnique({ where: { ownerId: userId } });
    if (existing) {
      if (this.#voice(guild, existing.channelId)) return `You already have a VIP voice channel: <#${existing.channelId}>`;
      await this.db.tempVoiceChannel.delete({ where: { channelId: existing.channelId } });
    }

    const member = guild.members.cache.get(userId);
    const channel = await guild.channels.create({
      name: defaultRoomName(member?.displayName ?? 'VIP'),
      type: ChannelType.GuildVoice,
      parent: categoryId,
      reason: `VIP voice channel for ${userId}`,
    });
    // Starts empty: the owner has 60 s to join before it's cleaned up.
    await this.db.tempVoiceChannel.create({ data: { channelId: channel.id, ownerId: userId, emptySince: this.clock.now() } });
    await channel
      .send({
        content: `🔊 <@${userId}>'s VIP voice channel. Only the owner can use these buttons.`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(TEMP_VOICE_RENAME_ID).setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(TEMP_VOICE_LIMIT_ID).setLabel('Set user limit').setEmoji('👥').setStyle(ButtonStyle.Secondary),
          ),
        ],
        allowedMentions: { parse: [] },
      })
      .catch((err: unknown) => this.log.warn({ err }, "couldn't post temp voice controls"));
    await this.db.auditLog.create({ data: { action: 'tempvoice.create', actorId: userId, targetId: channel.id } });
    return `✅ Created <#${channel.id}>. Join within a minute or it's removed. Rename it or set a user limit from its chat.`;
  }

  /** Is this user the owner of this temp channel? */
  async isOwner(userId: string, channelId: string): Promise<boolean> {
    const row = await this.db.tempVoiceChannel.findUnique({ where: { channelId } });
    return row?.ownerId === userId;
  }

  async rename(userId: string, channelId: string, raw: string): Promise<string> {
    if (!(await this.isOwner(userId, channelId))) return 'Only the channel owner can rename it.';
    const blocked = (await this.db.blockedWord.findMany()).map((w) => w.word);
    const check = checkRoomName(raw, blocked);
    if (!check.ok) return `❌ ${check.error}`;
    const now = Date.now();
    const history = (this.#renames.get(channelId) ?? []).filter((t) => t > now - 10 * 60_000);
    if (!canRename(history, now)) return '⏳ Discord allows 2 renames per 10 minutes. Try again in a few minutes.';
    const channel = this.#guild() && this.#voice(this.#guild()!, channelId);
    if (!channel) return 'This channel no longer exists.';
    await channel.setName(check.name, `Renamed by owner ${userId}`);
    this.#renames.set(channelId, [...history, now]);
    return `✅ Renamed to **${check.name}**.`;
  }

  async setLimit(userId: string, channelId: string, limit: number): Promise<string> {
    if (!(await this.isOwner(userId, channelId))) return 'Only the channel owner can change the limit.';
    const channel = this.#guild() && this.#voice(this.#guild()!, channelId);
    if (!channel) return 'This channel no longer exists.';
    await channel.setUserLimit(limit, `Limit set by owner ${userId}`);
    return limit === 0 ? '✅ No user limit.' : `✅ User limit: ${limit}.`;
  }

  onVoiceStateUpdate(before: VoiceState, after: VoiceState): void {
    if (after.guild.id !== this.guildId || before.channelId === after.channelId) return;
    void this.sweep().catch((err: unknown) => this.log.warn({ err }, 'temp voice check failed'));
  }

  /** Checks every temp channel: empty timers, deletions, and channels deleted by hand. */
  sweep(): Promise<void> {
    this.#sweeping ??= this.#sweep().finally(() => {
      this.#sweeping = null;
    });
    return this.#sweeping;
  }

  async #sweep(): Promise<void> {
    const guild = this.#guild();
    if (!guild) return;
    const now = this.clock.now();
    for (const row of await this.db.tempVoiceChannel.findMany()) {
      const channel = this.#voice(guild, row.channelId);
      if (!channel) {
        await this.db.tempVoiceChannel.delete({ where: { channelId: row.channelId } });
        this.#renames.delete(row.channelId);
        continue;
      }
      const humans = channel.members.filter((m) => !m.user.bot).size;
      const action = roomAction({ humans, emptySince: row.emptySince, ownerIsVip: this.vip.vips.has(row.ownerId) }, now);
      if (action.delete) {
        await channel.delete('VIP voice channel empty').catch((err: unknown) => this.log.warn({ err }, "couldn't delete temp voice channel"));
        await this.db.tempVoiceChannel.delete({ where: { channelId: row.channelId } });
        this.#renames.delete(row.channelId);
      } else if (action.emptySince?.getTime() !== row.emptySince?.getTime()) {
        await this.db.tempVoiceChannel.update({ where: { channelId: row.channelId }, data: { emptySince: action.emptySince } });
      }
    }
  }

  /** VIP removal hook: their channel goes once it's empty. */
  async onVipRemoved(userId: string): Promise<void> {
    if (await this.db.tempVoiceChannel.findUnique({ where: { ownerId: userId } })) await this.sweep();
  }

  /** Startup: delete saved channels that are empty (or gone), keep tracking the rest. */
  async start(): Promise<void> {
    const guild = this.#guild();
    if (!guild) return;
    const now = this.clock.now();
    let removed = 0;
    for (const row of await this.db.tempVoiceChannel.findMany()) {
      const channel = this.#voice(guild, row.channelId);
      const humans = channel?.members.filter((m) => !m.user.bot).size ?? 0;
      if (!channel || humans === 0) {
        await channel?.delete('VIP voice channel empty after restart').catch(() => undefined);
        await this.db.tempVoiceChannel.delete({ where: { channelId: row.channelId } });
        removed++;
      } else if (row.emptySince) {
        await this.db.tempVoiceChannel.update({ where: { channelId: row.channelId }, data: { emptySince: null } });
      }
    }
    if (removed) this.log.info({ removed, at: now.toISOString() }, 'removed empty VIP voice channels');
  }
}
