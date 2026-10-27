import { describe, expect, it, vi } from 'vitest';
import { downloadIcon } from './iconImage.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const URL_OK = 'https://cdn.discordapp.com/attachments/1/2/icon.png';
const respond = (body: Uint8Array, status = 200) => vi.fn(() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch;

describe('downloadIcon', () => {
  it('downloads a PNG from the CDN', async () => {
    const got = await downloadIcon(URL_OK, respond(PNG));
    expect(got).toMatchObject({ ok: true, type: 'image/png' });
    if (got.ok) expect([...got.data]).toEqual([...PNG]);
  });

  it('never fetches from other hosts', async () => {
    const f = respond(PNG);
    expect((await downloadIcon('https://example.com/icon.png', f)).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('stops at 256 KB and rejects files that are not PNG/JPG or failed', async () => {
    const big = new Uint8Array(300 * 1024);
    big.set(PNG);
    expect((await downloadIcon(URL_OK, respond(big))).ok).toBe(false);
    expect((await downloadIcon(URL_OK, respond(new TextEncoder().encode('<html>')))).ok).toBe(false);
    expect((await downloadIcon(URL_OK, respond(PNG, 404))).ok).toBe(false);
    expect((await downloadIcon(URL_OK, () => Promise.reject(new Error('boom')))).ok).toBe(false);
  });
});
