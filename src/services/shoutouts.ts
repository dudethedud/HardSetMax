// VIP shoutouts: once per server-day, a VIP can post a short message from the
// bot in main chat (or announcements, if main chat isn't set). Veterans (VIP for
// 14+ days in a row) get a second one. Mentions are stripped and nothing pings.
// Only that it happened is saved, never the text.
import type { Client } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { cleanPublicText } from '../core/perks.js';
import { serverDayAt, serverDaysBetween } from '../core/serverDay.js';
import { isVeteran } from '../core/vipExtras.js';
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

  /** VIP for 14+ server-days in a row: a second shoutout each day. */
  #veteran(userId: string): boolean {
    const v = this.vip.vips.get(userId);
    return !!v && isVeteran(serverDaysBetween(v.since, this.#day().key));
  }

  /** Which of today's shoutouts is free: the first, a veteran's second, or none. */
  async #free(userId: string): Promise<'first' | 'second' | null> {
    const day = this.#day().key;
    if (!(await this.db.shoutout.findUnique({ where: { userId_serverDay: { userId, serverDay: day } } }))) return 'first';
    if (!this.#veteran(userId)) return null;
    const used = await this.db.perkUse.findUnique({ where: { userId_perk_period: { userId, perk: 'shoutout-2', period: day } } });
    return used ? null : 'second';
  }

  /** Who may open the shoutout form right now. */
  async access(userId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.vip.hasPerk(userId, 'shoutout')) return { ok: false, message: '📣 Shoutouts are a VIP perk.' };
    if (!this.#channelId()) return { ok: false, message: '❌ There’s no main chat channel set yet. Ask an admin.' };
    if (!(await this.#free(userId))) {
      const day = this.#day();
      const note = this.#veteran(userId) ? ' (both of your veteran shoutouts)' : '';
      return { ok: false, message: `📣 You've used today's shoutout${note}. The next one is ready <t:${Math.floor(day.end.getTime() / 1000)}:R>.` };
    }
    return { ok: true };
  }

  /** Claims a shoutout first, so two quick submits can't both post. Returns which one, or null. */
  async #claim(userId: string, serverDay: string): Promise<'first' | 'second' | null> {
    const { count } = await this.db.shoutout.createMany({ data: [{ userId, serverDay }], skipDuplicates: true });
    if (count) return 'first';
    if (!this.#veteran(userId)) return null;
    const second = await this.db.perkUse.createMany({ data: [{ userId, perk: 'shoutout-2', period: serverDay }], skipDuplicates: true });
    return second.count ? 'second' : null;
  }

  /** Posts the shoutout. Returns the private reply. */
  async post(userId: string, raw: string): Promise<string> {
    const access = await this.access(userId);
    if (!access.ok) return access.message;
    const blocked = (await this.db.blockedWord.findMany()).map((w) => w.word);
    const clean = cleanPublicText(raw, blocked, SHOUTOUT_MAX);
    if (!clean.ok) return `❌ ${clean.error}`;
    const serverDay = this.#day().key;
    const which = await this.#claim(userId, serverDay);
    if (!which) return "📣 You've used today's shoutout.";
    let message;
    try {
      const channel = await this.client.channels.fetch(this.#channelId()!);
      if (!channel?.isSendable()) throw new Error('the channel is missing');
      const label = this.vip.vips.has(userId) ? 'VIP shoutout' : 'Shoutout'; // title holders (Advisor, Champion) aren't VIPs
      message = await channel.send({ content: `📣 **${label} from <@${userId}>:** ${clean.text}`, allowedMentions: { parse: [] } });
    } catch (err) {
      if (which === 'first') await this.db.shoutout.delete({ where: { userId_serverDay: { userId, serverDay } } }).catch(() => undefined);
      else await this.db.perkUse.deleteMany({ where: { userId, perk: 'shoutout-2', period: serverDay } });
      this.log.warn({ err }, "couldn't post a shoutout");
      return "❌ Couldn't post your shoutout. You can try again.";
    }
    if (which === 'first') {
      await this.db.shoutout
        .update({ where: { userId_serverDay: { userId, serverDay } }, data: { messageId: message.id } })
        .catch((err: unknown) => this.log.warn({ err }, "couldn't save the shoutout's message ID"));
    }
    await this.modLog.post(`📣 <@${userId}> posted a VIP shoutout: ${message.url}`);
    return `✅ Shoutout posted: ${message.url}`;
  }
}
