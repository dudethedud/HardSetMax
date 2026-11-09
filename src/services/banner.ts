// Downloads an uploaded menu banner from Discord's CDN, with a time and size limit.
import { BANNER_MAX_BYTES, imageExtension, isDiscordCdnUrl } from '../core/banner.js';
import type { Banner } from './colourMenus.js';

const TIMEOUT_MS = 15_000;
const TOO_BIG = 'The banner must be 8 MB or smaller.';

export type BannerDownload = { ok: true; banner: Banner } | { ok: false; error: string };

export async function downloadBanner(url: string, size: number, fetchImpl: typeof fetch = fetch): Promise<BannerDownload> {
  if (!isDiscordCdnUrl(url)) return { ok: false, error: 'The banner must be uploaded to Discord.' };
  if (size > BANNER_MAX_BYTES) return { ok: false, error: TOO_BIG };
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !res.body) return { ok: false, error: "Couldn't download the banner. Try uploading it again." };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > BANNER_MAX_BYTES) return { ok: false, error: TOO_BIG };
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const ext = imageExtension(data);
    return ext ? { ok: true, banner: { name: `banner.${ext}`, data } } : { ok: false, error: 'The banner must be a PNG, JPG, GIF or WebP image.' };
  } catch {
    return { ok: false, error: "Couldn't download the banner. Try uploading it again." };
  }
}
