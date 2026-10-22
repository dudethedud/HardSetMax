import type { Db } from '../db/prisma.js';
import type { GuildConfig } from '../generated/prisma/client.js';
import type { DayBoundary } from '../core/serverDay.js';

/** The guild's config row, created with defaults the first time. */
export function getGuildConfig(db: Db, guildId: string): Promise<GuildConfig> {
  return db.guildConfig.upsert({ where: { guildId }, create: { guildId }, update: {} });
}

export function dayBoundaryOf(config: GuildConfig): DayBoundary {
  return { timezone: config.timezone, time: config.dayBoundary };
}
