import { describe, expect, it } from 'vitest';
import { Collection, type Guild } from 'discord.js';
import { fetchAllMembers, retryAfterMs } from './memberList.js';

const rateLimited = (seconds: number) => Object.assign(new Error('Request with opcode 8 was rate limited.'), { data: { retry_after: seconds, opcode: 8 } });

function fakeGuild(results: (Error | 'ok')[]) {
  let calls = 0;
  const members = new Collection([['1', {}]]);
  const guild = {
    members: {
      fetch: () => {
        const r = results[Math.min(calls++, results.length - 1)];
        return r === 'ok' ? Promise.resolve(members) : Promise.reject(r!);
      },
    },
  } as unknown as Guild;
  return { guild, members, calls: () => calls };
}

describe('fetching every member', () => {
  it('reads how long Discord asked to wait', () => {
    expect(retryAfterMs(rateLimited(28.809))).toBe(28809);
    expect(retryAfterMs(new Error('Missing Access'))).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });

  it('two callers at once share one request', async () => {
    const t = fakeGuild(['ok']);
    const [a, b] = await Promise.all([fetchAllMembers(t.guild), fetchAllMembers(t.guild)]);
    expect(a).toBe(t.members);
    expect(b).toBe(t.members);
    expect(t.calls()).toBe(1);
    // Done: the next call asks again.
    await fetchAllMembers(t.guild);
    expect(t.calls()).toBe(2);
  });

  it('waits out a rate limit, then tries again', async () => {
    const t = fakeGuild([rateLimited(2), 'ok']);
    const waits: number[] = [];
    expect(await fetchAllMembers(t.guild, (ms) => (waits.push(ms), Promise.resolve()))).toBe(t.members);
    expect(waits).toEqual([2500]);
  });

  it('other errors, or rate limits that keep coming, still fail', async () => {
    await expect(fetchAllMembers(fakeGuild([new Error('Missing Access')]).guild, () => Promise.resolve())).rejects.toThrow('Missing Access');
    const t = fakeGuild([rateLimited(1)]);
    await expect(fetchAllMembers(t.guild, () => Promise.resolve())).rejects.toThrow('rate limited');
    expect(t.calls()).toBe(4);
  });
});
