import { describe, expect, it, vi } from 'vitest';
import { downloadBanner } from './banner.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const URL_OK = 'https://cdn.discordapp.com/attachments/1/2/b.png';
const respond = (body: Uint8Array, status = 200) => vi.fn(() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch;

describe('downloadBanner', () => {
  it('downloads an image from the CDN', async () => {
    const got = await downloadBanner(URL_OK, PNG.length, respond(PNG));
    expect(got).toMatchObject({ ok: true, banner: { name: 'banner.png' } });
  });

  it('never fetches from other hosts, and rejects big or non-image files', async () => {
    const f = respond(PNG);
    expect((await downloadBanner('https://example.com/b.png', 10, f)).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
    expect((await downloadBanner(URL_OK, 9 * 1024 * 1024, respond(PNG))).ok).toBe(false);
    expect((await downloadBanner(URL_OK, 5, respond(new TextEncoder().encode('<html>')))).ok).toBe(false);
    expect((await downloadBanner(URL_OK, 5, respond(PNG, 404))).ok).toBe(false);
  });
});
