// In-memory copy of the guild's settings and channel weights, used on every
// message. Reloaded after any /config change.
import { messageRulesConfig, reshuffleConfig } from '../core/configKeys.js';
import type { MessageRulesConfig } from '../core/messageRules.js';
import type { ReshuffleConfig } from '../core/reshuffle.js';
import type { DayBoundary } from '../core/serverDay.js';
import type { Db } from '../db/prisma.js';
import type { GuildConfig } from '../generated/prisma/client.js';
import { dayBoundaryOf, getGuildConfig } from './guildConfig.js';

export interface RuntimeConfig {
  guild: GuildConfig;
  boundary: DayBoundary;
  rules: MessageRulesConfig;
  reshuffle: ReshuffleConfig;
  channelWeights: ReadonlyMap<string, number>;
}

export class ConfigStore {
  #current: RuntimeConfig | null = null;

  constructor(
    private readonly db: Db,
    private readonly guildId: string,
  ) {}

  get current(): RuntimeConfig {
    if (!this.#current) throw new Error('ConfigStore used before load()');
    return this.#current;
  }

  async load(): Promise<RuntimeConfig> {
    const [guild, weights] = await Promise.all([getGuildConfig(this.db, this.guildId), this.db.channelWeight.findMany()]);
    this.#current = {
      guild,
      boundary: dayBoundaryOf(guild),
      rules: messageRulesConfig(guild),
      reshuffle: reshuffleConfig(guild),
      channelWeights: new Map(weights.map((w) => [w.channelId, w.weight])),
    };
    return this.#current;
  }
}
