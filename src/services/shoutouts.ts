// VIP shoutouts: once per server-day, a VIP can post a short message from the
// bot in main chat (or announcements, if main chat isn't set). Mentions are
// stripped and nothing pings. Only that it happened is saved, never the text.
import type { Client } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { cleanPublicText } from '../core/perks.js';
import { serverDayAt } from '../core/serverDay.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import type { ModLog } from './modLog.js';
import type { VipService } from './vipService.js';

export const SHOUTOUT_MAX = 200;

export class ShoutoutService {
  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly vip: VipService,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  #day() {
    return serverDayAt(this.clock.now(), this.config.current.boundary);
  }

  #channelId(): string | null {
    const g = this.config.current.guild;
    return g.mainChatChannelId ?? g.announceChannelId;
  }

  /** Who may open the shoutout form right now. */
  async access(userId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.vip.hasPerk(userId, 'shoutout')) return { ok: false, message: '📣 Shoutouts are a VIP perk.' };
    if (!this.#channelId()) return { ok: false, message: '❌ There’s no main chat channel set yet. Ask an admin.' };
    const day = this.#day();
    if (await this.db.shoutout.findUnique({ where: { userId_serverDay: { userId, serverDay: day.key } } })) {
      return { ok: false, message: `📣 You've used today's shoutout. The next one is ready <t:${Math.floor(day.end.getTime() / 1000)}:R>.` };
    }
    return { ok: true };
  }

  /** Posts the shoutout. Returns the private reply. */
  async post(userId: string, raw: string): Promise<string> {
    const access = await this.access(userId);
    if (!access.ok) return access.message;
    const blocked = (await this.db.blockedWord.findMany()).map((w) => w.word);
    const clean = cleanPublicText(raw, blocked, SHOUTOUT_MAX);
    if (!clean.ok) return `❌ ${clean.error}`;
    const serverDay = this.#day().key;
    // Claim today's shoutout first, so two quick submits can't both post.
    const { count } = await this.db.shoutout.createMany({ data: [{ userId, serverDay }], skipDuplicates: true });
    if (!count) return "📣 You've used today's shoutout.";
    let message;
    try {
      const channel = await this.client.channels.fetch(this.#channelId()!);
      if (!channel?.isSendable()) throw new Error('the channel is missing');
      const label = this.vip.vips.has(userId) ? 'VIP shoutout' : 'Shoutout'; // title holders (Advisor, Champion) aren't VIPs
      message = await channel.send({ content: `📣 **${label} from <@${userId}>:** ${clean.text}`, allowedMentions: { parse: [] } });
    } catch (err) {
      await this.db.shoutout.delete({ where: { userId_serverDay: { userId, serverDay } } }).catch(() => undefined);
      this.log.warn({ err }, "couldn't post a shoutout");
      return "❌ Couldn't post your shoutout. You can try again.";
    }
    await this.db.shoutout
      .update({ where: { userId_serverDay: { userId, serverDay } }, data: { messageId: message.id } })
      .catch((err: unknown) => this.log.warn({ err }, "couldn't save the shoutout's message ID"));
    await this.modLog.post(`📣 <@${userId}> posted a VIP shoutout: ${message.url}`);
    return `✅ Shoutout posted: ${message.url}`;
  }
}
