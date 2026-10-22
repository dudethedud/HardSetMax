// Counts messages (SPEC §2). Message text is passed to the pure rules in memory and
// never stored or logged; only each user's SpamState (numbers) is kept, and dropped
// once it can no longer matter.
import type { Message } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { channelWeight } from '../core/activityRules.js';
import { emptySpamState, evaluateMessage, isFiltered, isSpamStateIdle, type SpamState } from '../core/messageRules.js';
import { serverDayAt } from '../core/serverDay.js';
import type { ActivityBuffer } from './activityBuffer.js';

export class MessageTracker {
  #states = new Map<string, SpamState>();
  #stopped = false;

  constructor(
    private readonly guildId: string,
    private readonly config: ConfigStore,
    private readonly buffer: ActivityBuffer,
  ) {}

  handle(message: Message): void {
    if (this.#stopped || !message.inGuild() || message.guildId !== this.guildId) return;
    if (message.author.bot || message.webhookId || message.system) return;

    const { channelWeights, rules, boundary } = this.config.current;
    const channel = message.channel;
    const weight = channelWeight({ id: channel.id, parentId: channel.parentId, isThread: channel.isThread() }, channelWeights);
    if (weight <= 0) return;

    const userId = message.author.id;
    this.buffer.setName(userId, message.member?.displayName ?? message.author.displayName);

    const { state, outcome } = evaluateMessage(
      this.#states.get(userId) ?? emptySpamState(),
      { text: message.content, hasStickers: message.stickers.size > 0, at: message.createdTimestamp },
      rules,
    );
    this.#states.set(userId, state);

    const day = serverDayAt(message.createdAt, boundary).key;
    if (outcome === 'counted') this.buffer.add(userId, day, { messages: 1, weightedMessages: weight });
    else if (isFiltered(outcome)) this.buffer.add(userId, day, { filteredMessages: 1 });
  }

  /** Drops spam state that can't affect any future message (run every few minutes). */
  sweep(now = Date.now()): void {
    const rules = this.config.current.rules;
    for (const [userId, s] of this.#states) if (isSpamStateIdle(s, now, rules)) this.#states.delete(userId);
  }

  stop(): void {
    this.#stopped = true;
    this.#states.clear();
  }
}
