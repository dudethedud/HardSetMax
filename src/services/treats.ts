// VIP treats (owner-approved): once per server-day a VIP gives a 🦴 treat to any
// member, and Carter announces it in main chat (no pings). Cosmetic: treats show
// on the profile card and the weekly recap, and never change scores.
import type { Client, GuildMember } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { serverDayAt } from '../core/serverDay.js';
import { treatLine, treatTargetError } from '../core/vipExtras.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import type { ModLog } from './modLog.js';
import type { VipService } from './vipService.js';

export class TreatService {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly vip: VipService,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly random: () => number = Math.random,
  ) {}

  #day() {
    return serverDayAt(this.clock.now(), this.config.current.boundary);
  }

  /** Who may open the treat picker right now. */
  async access(userId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!this.vip.vips.has(userId)) return { ok: false, message: '🦴 Treats are a VIP perk.' };
    const day = this.#day();
    if (await this.db.treat.findUnique({ where: { giverId_serverDay: { giverId: userId, serverDay: day.key } } })) {
      return { ok: false, message: `🦴 You've given today's treat. Next one <t:${Math.floor(day.end.getTime() / 1000)}:R>.` };
    }
    return { ok: true };
  }

  /** Gives today's treat. Returns the private reply. */
  async give(giverId: string, receiverId: string): Promise<string> {
    const access = await this.access(giverId);
    if (!access.ok) return access.message;
    const guild = this.client.guilds.cache.get(this.guildId);
    const member: GuildMember | null = guild ? (guild.members.cache.get(receiverId) ?? (await guild.members.fetch(receiverId).catch(() => null))) : null;
    const error = treatTargetError({ giverId, receiverId, isBot: member?.user.bot ?? false, inServer: !!member });
    if (error) return `❌ ${error}`;
    const g = this.config.current.guild;
    const channelId = g.mainChatChannelId ?? g.announceChannelId;
    if (!channelId) return '❌ There’s no main chat channel set yet. Ask an admin.';
    const serverDay = this.#day().key;
    // Claim today's treat first, so two quick clicks can't both count.
    const { count } = await this.db.treat.createMany({ data: [{ giverId, serverDay, receiverId, createdAt: this.clock.now() }], skipDuplicates: true });
    if (!count) return "🦴 You've given today's treat.";
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isSendable()) throw new Error('the channel is missing');
      const message = await channel.send({ content: `🦴 <@${giverId}> gave <@${receiverId}> a treat! Carter: ${treatLine(this.random())}`, allowedMentions: { parse: [] } });
      return `✅ Treat given: ${message.url}`;
    } catch (err) {
      await this.db.treat.deleteMany({ where: { giverId, serverDay } });
      this.log.warn({ err }, "couldn't post a treat");
      return "❌ Couldn't give the treat. You can try again.";
    }
  }

  /** Treats someone has received: all time, and since `since`. */
  async received(userId: string, since: Date): Promise<{ total: number; recent: number }> {
    const [total, recent] = await Promise.all([
      this.db.treat.count({ where: { receiverId: userId } }),
      this.db.treat.count({ where: { receiverId: userId, createdAt: { gte: since } } }),
    ]);
    return { total, recent };
  }

  /** Who got the most treats between two times (ties: the one reached first). */
  async top(from: Date, to: Date): Promise<{ userId: string; count: number } | null> {
    const rows = await this.db.treat.groupBy({ by: ['receiverId'], where: { createdAt: { gte: from, lt: to } }, _count: { _all: true }, _min: { createdAt: true } });
    const best = rows.sort((a, b) => b._count._all - a._count._all || a._min.createdAt!.getTime() - b._min.createdAt!.getTime())[0];
    return best ? { userId: best.receiverId, count: best._count._all } : null;
  }
}
