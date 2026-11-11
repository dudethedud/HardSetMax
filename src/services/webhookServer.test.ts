import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startWebhookServer } from './webhookServer.js';

describe('webhook server', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function start(handler: (body: string) => Promise<number>) {
    server = await startWebhookServer(0, handler, pino({ level: 'silent' }));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('passes POST /kofi bodies to the handler and answers with its status', async () => {
    const bodies: string[] = [];
    const base = await start((b) => (bodies.push(b), Promise.resolve(200)));
    const res = await fetch(`${base}/kofi`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=%7B%7D' });
    expect(res.status).toBe(200);
    expect(bodies).toEqual(['data=%7B%7D']);
  });

  it('everything else is 404; a health check answers ok; huge bodies are refused', async () => {
    const base = await start(() => Promise.resolve(200));
    expect((await fetch(`${base}/kofi`)).status).toBe(404);
    expect((await fetch(`${base}/other`, { method: 'POST', body: 'x' })).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(200);
    const big = await fetch(`${base}/kofi`, { method: 'POST', body: 'x'.repeat(100 * 1024) }).catch(() => null);
    expect(big === null || big.status === 413).toBe(true);
  });

  it('a handler error answers 500 so Ko-fi tries again', async () => {
    const base = await start(() => Promise.reject(new Error('db down')));
    expect((await fetch(`${base}/kofi`, { method: 'POST', body: 'data=x' })).status).toBe(500);
  });
});
