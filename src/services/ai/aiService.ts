// The AI provider chain (SPEC §9a). Each request goes to the first provider that's
// enabled, has its key, is under its daily cap and isn't cooling down. On an error,
// timeout or 429 it moves on and puts the failing provider on a cooldown. If every
// provider is out, the caller uses a pre-written reply.
//
// The AI only ever returns text. Nothing here can act on what it says.
import { readFileSync } from 'node:fs';
import type { ConfigStore } from '../../config/configStore.js';
import { cooldownAfter, providerDay, usableProviders, type Failure } from '../../core/ai/chain.js';
import type { ChatMessage } from '../../core/ai/prompt.js';
import type { Db } from '../../db/prisma.js';
import type { AiProvider } from '../../generated/prisma/client.js';
import type { Logger } from '../../logger.js';
import type { Clock } from '../clock.js';

export const PREWRITTEN = 'prewritten';
const TIMEOUT_MS = 10_000;

/** The default chain (owner-approved). More providers are just more rows. */
export const DEFAULT_PROVIDERS = [
  { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant', keyEnvVar: 'GROQ_API_KEY', dailyCap: 1000, order: 1 },
  {
    name: 'cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    model: '@cf/meta/llama-3.1-8b-instruct',
    keyEnvVar: 'CLOUDFLARE_AI_TOKEN',
    dailyCap: 800,
    order: 2,
  },
];

export interface Prompts {
  personality: string;
  guide: string;
}

/** prompts/*.md, one level above src/ or dist/. */
export function loadPrompts(): Prompts {
  const read = (f: string) => readFileSync(new URL(`../../../prompts/${f}`, import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  return { personality: read('personality.md'), guide: read('vip-guide.md') };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

class ProviderError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.status === null ? failure.body : `HTTP ${failure.status}`);
  }
}

export class AiService {
  constructor(
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly env: NodeJS.ProcessEnv,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  /** Adds the default providers the first time. */
  async ensureProviders(): Promise<void> {
    if ((await this.db.aiProvider.count()) === 0) await this.db.aiProvider.createMany({ data: DEFAULT_PROVIDERS });
  }

  providers(): Promise<AiProvider[]> {
    return this.db.aiProvider.findMany({ orderBy: { order: 'asc' } });
  }

  #key(p: AiProvider): string | undefined {
    return this.env[p.keyEnvVar] || undefined;
  }

  #url(p: AiProvider): string | null {
    let missing = false;
    const base = p.baseUrl.replace(/\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const v = this.env[name];
      if (!v) missing = true;
      return encodeURIComponent(v ?? '');
    });
    return missing ? null : `${base.replace(/\/$/, '')}/chat/completions`;
  }

  async usedToday(p: Pick<AiProvider, 'name' | 'resetTimezone'>, now = this.clock.now()): Promise<number> {
    const row = await this.db.aiUsage.findUnique({ where: { provider_providerDay: { provider: p.name, providerDay: providerDay(p, now) } } });
    return row?.count ?? 0;
  }

  async #count(provider: string, day: string): Promise<void> {
    await this.db.aiUsage.upsert({
      where: { provider_providerDay: { provider, providerDay: day } },
      create: { provider, providerDay: day, count: 1 },
      update: { count: { increment: 1 } },
    });
  }

  /** Counts a pre-written reply (shown in /bot ai action:status). Pre-written replies reset at 00:00 UTC. */
  async recordFallback(): Promise<void> {
    await this.#count(PREWRITTEN, providerDay({ resetTimezone: 'UTC' }, this.clock.now()));
  }

  /**
   * Text from the first provider that answers, or null if all are out.
   * `count: false` (for /bot ai action:test) doesn't use up the daily cap.
   */
  async complete(messages: ChatMessage[], { maxTokens = 160, count = true } = {}): Promise<{ text: string; provider: string } | null> {
    const now = this.clock.now();
    const all = await this.providers();
    const used = new Map(await Promise.all(all.map(async (p) => [p.name, await this.usedToday(p, now)] as const)));
    const usable = usableProviders(
      all.map((p) => ({ ...p, hasKey: !!this.#key(p) && this.#url(p) !== null })),
      (p) => used.get(p.name) ?? 0,
      now,
    );

    for (const p of usable) {
      try {
        const text = await this.#call(p, messages, maxTokens);
        if (count) await this.#count(p.name, providerDay(p, now));
        if (p.lastError) await this.db.aiProvider.update({ where: { name: p.name }, data: { lastError: null } });
        return { text, provider: p.name };
      } catch (err) {
        const failure: Failure = err instanceof ProviderError ? err.failure : { status: null, body: err instanceof Error ? err.message : String(err) };
        const until = cooldownAfter(failure, p, this.clock.now());
        const lastError = `${failure.status ?? 'network/timeout'}: ${failure.body.slice(0, 200)}`;
        this.log.warn({ provider: p.name, status: failure.status, until }, 'AI provider failed; trying the next one');
        await this.db.aiProvider.update({ where: { name: p.name }, data: { cooldownUntil: until, lastError } });
      }
    }
    return null;
  }

  async #call(p: AiProvider, messages: ChatMessage[], maxTokens: number): Promise<string> {
    const url = this.#url(p)!;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#key(p)}` },
        body: JSON.stringify({ model: p.model, messages, max_tokens: maxTokens, temperature: 0.8 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ProviderError({ status: null, body: err instanceof Error && err.name === 'TimeoutError' ? 'timed out after 10 s' : String(err) });
    }
    const body = await res.text();
    if (!res.ok) throw new ProviderError({ status: res.status, body });
    let text: unknown;
    try {
      text = (JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    } catch {
      throw new ProviderError({ status: res.status, body: 'response was not JSON' });
    }
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError({ status: res.status, body: 'empty reply' });
    return text;
  }

  /** /bot ai action:status lines. */
  async status(): Promise<string> {
    const now = this.clock.now();
    const lines = [`**AI chat:** ${this.config.current.guild.aiEnabled ? 'on' : 'off (pre-written replies only)'}`];
    for (const p of await this.providers()) {
      const used = await this.usedToday(p, now);
      const state = !p.enabled ? 'disabled' : !this.#key(p) || !this.#url(p) ? 'no API key set' : p.cooldownUntil && p.cooldownUntil > now ? `cooling down until <t:${Math.floor(p.cooldownUntil.getTime() / 1000)}:t>` : 'ready';
      lines.push(`• **${p.name}** (${p.model}): ${used}/${p.dailyCap} today, ${state}${p.lastError ? ` · last error: ${p.lastError.slice(0, 120)}` : ''}`);
    }
    lines.push(`• pre-written replies today: ${await this.usedToday({ name: PREWRITTEN, resetTimezone: 'UTC' }, now)}`);
    return lines.join('\n');
  }
}
