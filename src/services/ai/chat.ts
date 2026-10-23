// Puppyboy Carter in main chat (SPEC §9a). Replies when @mentioned or when someone
// replies to one of its messages, in main chat only. The reply chain (up to 6
// messages) is read from Discord on the spot and never saved. The AI only writes
// text: this file never changes roles, scores, polls or settings because of it.
// One owner-approved exception: the AI can flag the message it's answering as mean
// or NSFW (core/ai/strikes.ts). Flags only ever count against that message's author,
// and enough of them stop the bot replying to that person (AiBlock). The server
// owner is never flagged or blocked.
import type { Client, Message } from 'discord.js';
import type { ConfigStore } from '../../config/configStore.js';
import { BLOCKED_OUTPUT_FALLBACK, fallbackReply, fallbackWelcome } from '../../core/ai/fallback.js';
import { buildChatMessages, buildHypeMessages, buildWelcomeMessages, type AskerStats, type ChatTurn } from '../../core/ai/prompt.js';
import { extractStrike, reachedStrikeLimit, STRIKE_WINDOW_MS } from '../../core/ai/strikes.js';
import { allowReply, containsBlockedWord, hypeLineOrNull, sanitizeAiText } from '../../core/ai/text.js';
import { isFiltered, type MessageOutcome } from '../../core/messageRules.js';
import { serverDayAt, serverDaysBetween } from '../../core/serverDay.js';
import { loadStandings, namesFor } from '../../db/activityRepo.js';
import type { Db } from '../../db/prisma.js';
import type { Logger } from '../../logger.js';
import type { Clock } from '../clock.js';
import type { CrownService } from '../crown.js';
import type { ModLog } from '../modLog.js';
import type { VipService } from '../vipService.js';
import type { AiService, Prompts } from './aiService.js';

const CHAIN_LENGTH = 6;

export class ChatService {
  /** userId → times of recent AI replies, for the per-person limit. */
  #recent = new Map<string, number[]>();
  /** Set in index.ts: where automatic AI blocks are announced. */
  modLog: ModLog | null = null;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly ai: AiService,
    private readonly vip: VipService,
    private readonly crown: CrownService,
    private readonly prompts: Prompts,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async #blocked(): Promise<string[]> {
    return (await this.db.blockedWord.findMany()).map((w) => w.word);
  }

  /** Every guild message comes here with the spam filter's verdict. */
  async handle(message: Message, outcome: MessageOutcome | null): Promise<void> {
    const botId = this.client.user?.id;
    if (!botId || !message.inGuild() || message.guildId !== this.guildId || message.author.bot) return;
    const mentioned = message.mentions.users.has(botId);
    // Why a mention got no reply, for the logs (never the message itself).
    const skipped = (reason: string) => {
      if (mentioned) this.log.info({ userId: message.author.id, channelId: message.channelId, reason }, 'AI chat: mention not answered');
    };
    if (message.channelId !== this.config.current.guild.mainChatChannelId) return skipped('not the main chat channel (/settings channel purpose:main-chat)');

    const ref = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
    if (!mentioned && ref?.author.id !== botId) return;
    if (outcome && isFiltered(outcome)) return skipped(`spam filter: ${outcome}`);

    const userId = message.author.id;
    const isOwner = message.guild.ownerId === userId;
    if (!isOwner && (await this.db.aiBlock.findUnique({ where: { userId } }))) return skipped('blacklisted (/bot ai-blacklist)');
    const now = Date.now();
    const recent = (this.#recent.get(userId) ?? []).filter((t) => t > now - 60_000);
    if (!allowReply(recent, now, this.config.current.guild.aiPerUserLimit)) {
      await message.react('👀').catch(() => undefined);
      return;
    }
    this.#recent.set(userId, [...recent, now]);

    await message.channel.sendTyping().catch(() => undefined);
    const stats = await this.statsFor(userId, message.member?.displayName ?? message.author.displayName);
    const question = this.#clean(message.content, botId);
    const res = await this.reply(stats, await this.#chain(message, botId));
    const text = res.text ?? fallbackReply(question, stats);

    await message.reply({ content: text, allowedMentions: { parse: [], users: [userId], repliedUser: true } });
    if (res.strike && !isOwner) await this.#strike(userId);
  }

  /** Counts a strike against this person; enough within a day blocks them. */
  async #strike(userId: string): Promise<void> {
    const now = this.clock.now();
    await this.db.aiStrike.create({ data: { userId, at: now } });
    const recent = await this.db.aiStrike.findMany({ where: { userId, at: { gt: new Date(now.getTime() - STRIKE_WINDOW_MS) } }, select: { at: true } });
    const limit = this.config.current.guild.aiStrikeLimit;
    this.log.info({ userId, strikes: recent.length, limit }, 'AI chat: message flagged as mean or NSFW');
    if (!reachedStrikeLimit(recent.map((r) => r.at), now, limit)) return;
    await this.db.$transaction([
      this.db.aiBlock.upsert({ where: { userId }, create: { userId, auto: true }, update: {} }),
      this.db.auditLog.create({ data: { action: 'ai.block', targetId: userId, reason: `${recent.length} mean/NSFW flags in 24 h` } }),
    ]);
    await this.modLog?.post(
      `🙊 Puppyboy Carter stopped replying to <@${userId}>: ${recent.length} messages flagged as mean or NSFW in 24 h. Undo with \`/bot ai-blacklist action:remove\`.`,
    );
  }

  /**
   * An AI reply, or null if AI is off or every provider is out (the caller then
   * uses a pre-written reply, which is counted here).
   */
  async reply(stats: AskerStats, history: ChatTurn[], { count = true } = {}): Promise<{ text: string | null; strike: boolean }> {
    if (!this.config.current.guild.aiEnabled) {
      if (count) await this.ai.recordFallback();
      return { text: null, strike: false };
    }
    const messages = buildChatMessages({ ...this.prompts, stats, info: await this.#publicInfo(), history });
    const res = await this.ai.complete(messages, { count });
    if (!res) {
      if (count) await this.ai.recordFallback();
      return { text: null, strike: false };
    }
    const { text: raw, strike } = extractStrike(res.text);
    const text = sanitizeAiText(raw);
    if (!text) return { text: null, strike };
    if (containsBlockedWord(text, await this.#blocked())) {
      this.log.warn({ provider: res.provider }, 'AI reply contained a blocked word; sent the fallback line');
      return { text: BLOCKED_OUTPUT_FALLBACK, strike };
    }
    return { text, strike };
  }

  #clean(content: string, botId: string): string {
    return content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim() || '(said hi)';
  }

  /** The reply chain, oldest first, up to 6 messages. Read from Discord; never saved. */
  async #chain(message: Message<true>, botId: string): Promise<ChatTurn[]> {
    const turns: ChatTurn[] = [];
    let current: Message | null = message;
    while (current && turns.length < CHAIN_LENGTH) {
      if (current.author.id === botId) turns.unshift({ role: 'assistant', content: current.content });
      else turns.unshift({ role: 'user', content: `${current.member?.displayName ?? current.author.displayName}: ${this.#clean(current.content, botId)}` });
      current = current.reference?.messageId ? await current.fetchReference().catch(() => null) : null;
    }
    return turns;
  }

  /** The asker's own stats (and nobody else's). */
  async statsFor(userId: string, name: string): Promise<AskerStats> {
    const cfg = this.config.current;
    const now = this.clock.now();
    const { window, ranked } = await loadStandings(this.db, cfg, now);
    const index = ranked.findIndex((s) => s.userId === userId);
    const me = ranked[index];
    const tenth = ranked[9];
    const v = this.vip.vips.get(userId);
    const today = serverDayAt(now, cfg.boundary).key;
    const pollUsedToday = v ? (await this.db.pollPost.count({ where: { userId, serverDay: today, accepted: true, kind: { in: ['vip', 'extra'] } } })) > 0 : false;
    return {
      name,
      rank: me ? index + 1 : null,
      ranked: ranked.length,
      score: me?.score ?? 0,
      activeDays: me?.activeDays ?? 0,
      windowDays: window.length,
      pointsToTop10: index >= 0 && index < 10 ? null : tenth ? Math.max(0, tenth.score - (me?.score ?? 0)) : 0,
      isVip: !!v,
      vipDays: v ? serverDaysBetween(v.since, today) : null,
      pinned: v?.pinned ?? false,
      pollUsedToday,
    };
  }

  async #publicInfo() {
    const vipIds = [...this.vip.vips.keys()];
    const crown = await this.crown.current();
    const names = await namesFor(this.db, [...vipIds, ...(crown ? [crown.userId] : [])]);
    return { vipNames: vipIds.map((id) => names.get(id) ?? 'someone'), crownName: crown ? (names.get(crown.userId) ?? 'someone') : null };
  }

  /** One hype line for a post, or null (AI off/unavailable, or it broke the rules). */
  async hypeLine(kind: 'vip-update' | 'recap', summary: string): Promise<string | null> {
    if (!this.config.current.guild.aiEnabled) return null;
    const res = await this.ai.complete(buildHypeMessages(this.prompts.personality, kind, summary), { maxTokens: 60 }).catch(() => null);
    const line = res ? hypeLineOrNull(res.text) : null;
    return line && !containsBlockedWord(line, await this.#blocked()) ? line : null;
  }

  /** Welcome for new VIPs in the lounge (falls back to a fixed message). */
  async welcome(userIds: string[]): Promise<void> {
    const channelId = this.config.current.guild.loungeTextId;
    if (!userIds.length || !channelId) return;
    const names = await namesFor(this.db, userIds);
    let text: string | null = null;
    if (this.config.current.guild.aiEnabled) {
      const res = await this.ai
        .complete(buildWelcomeMessages(this.prompts.personality, this.prompts.guide, userIds.map((id) => names.get(id) ?? 'a new VIP')), { maxTokens: 120 })
        .catch(() => null);
      const t = res ? sanitizeAiText(res.text, 300) : '';
      if (t && !/\d/.test(t) && !containsBlockedWord(t, await this.#blocked())) text = t;
    }
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isSendable()) return;
      await channel.send({
        content: `${userIds.map((id) => `<@${id}>`).join(' ')} ${text ?? fallbackWelcome()}`,
        allowedMentions: { parse: [], users: userIds },
      });
    } catch (err) {
      this.log.warn({ err }, "couldn't post the VIP welcome");
    }
  }
}
