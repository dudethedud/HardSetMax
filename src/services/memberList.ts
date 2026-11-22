// The full member list, fetched over the gateway. Discord allows few of these
// requests at a time per server: callers asking while one is running share it, and a
// rate limit is waited out (Discord says how long) instead of failing the caller.
import type { Collection, Guild, GuildMember } from 'discord.js';

const MAX_RETRIES = 3;
const inFlight = new WeakMap<Guild, Promise<Collection<string, GuildMember>>>();

/** How long Discord asked us to wait (ms), if `err` is a gateway rate limit. */
export function retryAfterMs(err: unknown): number | null {
  const seconds = (err as { data?: { retry_after?: unknown } } | null)?.data?.retry_after;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function fetchAllMembers(guild: Guild, wait: (ms: number) => Promise<void> = sleep): Promise<Collection<string, GuildMember>> {
  const running = inFlight.get(guild);
  if (running) return running;
  const request = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await guild.members.fetch();
      } catch (err) {
        const retry = retryAfterMs(err);
        if (retry === null || attempt >= MAX_RETRIES) throw err;
        await wait(retry + 500);
      }
    }
  })().finally(() => inFlight.delete(guild));
  inFlight.set(guild, request);
  return request;
}
