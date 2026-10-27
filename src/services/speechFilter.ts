// 🌈 speech filter (owner-approved): for 10 minutes, a member's plain-text
// messages are reposted with rainbow flair (core/crownExtras.ts) under their name
// and avatar, with a 🌈 on the name so it's clear it's the filter, and the
// original is deleted. The Crown can use it once per Crown week, staff any time.
// Never on staff, the owner or bots. Every use is logged with a Stop button.
// Message text is only changed in memory; nothing is saved but who and until when.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  type Webhook,
} from 'discord.js';
import { RAINBOW_MINUTES, rainbowify, speechTargetError } from '../core/crownExtras.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import type { CrownService } from './crown.js';
import type { ModLog } from './modLog.js';

export const SPEECH_STOP_ID = 'speech:stop';
const WEBHOOK_NAME = 'Puppyboy Carter 🌈';

export class SpeechFilterService {
  /** targetId → when it ends (mirror of the SpeechFilter table, for a fast check per message). */
  #active = new Map<string, number>();
  #webhooks = new Map<string, Webhook>();
  /** Channels it never reposts in (#polls, where the bot deletes plain messages anyway). Set in index.ts. */
  skipChannel: (channelId: string) => boolean = () => false;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly crown: CrownService,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly random: () => number = Math.random,
  ) {}

  #guild(): Guild | undefined {
    return this.client.guilds.cache.get(this.guildId);
  }

  async #isStaff(member: GuildMember): Promise<boolean> {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const staff = new Set((await this.db.staffRole.findMany()).map((s) => s.roleId));
    return member.roles.cache.some((r) => staff.has(r.id));
  }

  /** Startup: load filters that haven't ended. */
  async load(): Promise<void> {
    const now = this.clock.now();
    await this.db.speechFilter.deleteMany({ where: { until: { lte: now } } });
    this.#active = new Map((await this.db.speechFilter.findMany()).map((f) => [f.targetId, f.until.getTime()]));
  }

  /** Who may open the Crown's form right now. */
  async crownAccess(userId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const cur = await this.crown.current();
    if (cur?.userId !== userId) return { ok: false, message: '👑 Only this week’s Crown holder can do that.' };
    if (cur.rainbowAt) return { ok: false, message: '🌈 You already used this week’s speech filter. One per Crown week.' };
    return { ok: true };
  }

  /** Starts the filter on someone. `byCrown`: the Crown's weekly use (staff: unlimited). Returns the private reply. */
  async start(actorId: string, targetId: string, byCrown: boolean): Promise<string> {
    const guild = this.#guild();
    if (!guild) return '❌ The bot is not in the server.';
    const member = guild.members.cache.get(targetId) ?? (await guild.members.fetch(targetId).catch(() => null));
    const error = speechTargetError({
      inServer: !!member,
      isBot: member?.user.bot ?? false,
      isOwner: targetId === guild.ownerId,
      isStaff: member ? await this.#isStaff(member) : false,
    });
    if (error) return `❌ ${error}`;
    const now = this.clock.now();
    if ((this.#active.get(targetId) ?? 0) > now.getTime()) return `🌈 <@${targetId}> is already filtered.`;
    if (byCrown) {
      const access = await this.crownAccess(actorId);
      if (!access.ok) return access.message;
      // Claim the week's use first, so two quick submits can't both start one.
      const { count } = await this.db.crownHolder.updateMany({ where: { userId: actorId, endedAt: null, rainbowAt: null }, data: { rainbowAt: now } });
      if (!count) return '🌈 You already used this week’s speech filter.';
    }
    const until = new Date(now.getTime() + RAINBOW_MINUTES * 60_000);
    await this.db.speechFilter.upsert({ where: { targetId }, create: { targetId, byId: actorId, byCrown, startedAt: now, until }, update: { byId: actorId, byCrown, startedAt: now, until } });
    await this.db.auditLog.create({ data: { action: 'speech.start', actorId, targetId, data: { byCrown, until: until.toISOString() } } });
    this.#active.set(targetId, until.getTime());
    const stop = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(SPEECH_STOP_ID).setLabel('Stop').setEmoji('🛑').setStyle(ButtonStyle.Danger));
    await this.modLog.post(`🌈 <@${actorId}>${byCrown ? ' (Crown)' : ''} turned on the speech filter for <@${targetId}> until <t:${Math.floor(until.getTime() / 1000)}:t>`, undefined, { components: [stop] });
    return `🌈 <@${targetId}>'s messages get rainbow flair for ${RAINBOW_MINUTES} minutes.`;
  }

  /** Ends it early (staff). Returns the private reply. */
  async stop(targetId: string, actorId: string): Promise<string> {
    const { count } = await this.db.speechFilter.deleteMany({ where: { targetId } });
    this.#active.delete(targetId);
    if (!count) return `<@${targetId}> isn't filtered.`;
    await this.db.auditLog.create({ data: { action: 'speech.stop', actorId, targetId } });
    await this.modLog.post(`🌈 <@${actorId}> stopped the speech filter for <@${targetId}>`);
    return `🛑 Stopped the speech filter for <@${targetId}>.`;
  }

  /** The Stop button on a mod-log entry: finds who it was for from the entry's mentions. */
  async stopFromLog(text: string, actorId: string): Promise<string> {
    const target = /for <@(\d+)>/.exec(text)?.[1];
    return target ? this.stop(target, actorId) : 'Couldn’t tell who that was for. Use `/vip rainbow-stop`.';
  }

  /** Every guild message comes here. Only plain text from filtered members is reposted. */
  async handleMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.guildId !== this.guildId || message.author.bot || message.webhookId) return;
    const until = this.#active.get(message.author.id);
    if (!until) return;
    if (until <= this.clock.now().getTime()) {
      this.#active.delete(message.author.id);
      await this.db.speechFilter.deleteMany({ where: { targetId: message.author.id, until: { lte: this.clock.now() } } });
      return;
    }
    const botId = this.client.user?.id;
    // Leave anything that isn't plain text, and messages to the bot (so AI chat still works).
    if (!message.content.trim() || message.attachments.size || message.stickers.size || message.poll || (botId && message.mentions.users.has(botId))) return;
    const channel = message.channel;
    if (this.skipChannel(channel.isThread() ? (channel.parentId ?? channel.id) : channel.id)) return;
    const parent = channel.isThread() ? channel.parent : channel;
    const me = message.guild.members.me;
    if (!parent || !me || !('createWebhook' in parent)) return;
    const perms = parent.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageMessages])) return;
    try {
      const hook = await this.#webhook(parent);
      const member = message.member ?? (await message.guild.members.fetch(message.author.id));
      const reply = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
      const prefix = reply ? `↪️ <@${reply.author.id}> ` : '';
      const content = rainbowify(`${prefix}${message.content}`, this.random);
      // Post first, then delete, so a failure never loses what they said.
      await hook.send({
        content,
        username: `${member.displayName} 🌈`.replace(/discord|clyde/gi, (w) => `${w[0]}\u200b${w.slice(1)}`).slice(0, 80),
        avatarURL: member.displayAvatarURL(),
        allowedMentions: { parse: [] },
        ...(channel.isThread() ? { threadId: channel.id } : {}),
      });
      await message.delete();
    } catch (err) {
      this.log.warn({ err, channelId: message.channelId }, 'speech filter repost failed');
    }
  }

  async #webhook(channel: { id: string; fetchWebhooks(): Promise<Map<string, Webhook>>; createWebhook(o: { name: string; reason?: string }): Promise<Webhook> }): Promise<Webhook> {
    const cached = this.#webhooks.get(channel.id);
    if (cached) return cached;
    const mine = [...(await channel.fetchWebhooks()).values()].find((w) => w.owner?.id === this.client.user?.id && w.name === WEBHOOK_NAME);
    const hook = mine ?? (await channel.createWebhook({ name: WEBHOOK_NAME, reason: '🌈 speech filter' }));
    this.#webhooks.set(channel.id, hook);
    return hook;
  }
}
