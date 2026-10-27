// Downloads an uploaded role icon from Discord's CDN, with a time and size limit.
import { checkIconBytes, isDiscordCdnUrl } from '../core/iconImage.js';
import { ROLE_ICON_MAX_BYTES } from '../core/crown.js';

const TIMEOUT_MS = 10_000;

export type IconDownload = { ok: true; data: Buffer; type: string } | { ok: false; error: string };

export async function downloadIcon(url: string, fetchImpl: typeof fetch = fetch): Promise<IconDownload> {
  if (!isDiscordCdnUrl(url)) return { ok: false, error: 'The image must be uploaded to Discord.' };
  try {
    const res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !res.body) return { ok: false, error: "Couldn't download the image. Try uploading it again." };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      // Stop reading early instead of downloading something huge.
      if (size > ROLE_ICON_MAX_BYTES) return { ok: false, error: 'The icon image must be 256 KB or smaller (Discord’s limit for role icons).' };
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const check = checkIconBytes(data);
    return check.ok ? { ok: true, data, type: check.type } : check;
  } catch {
    return { ok: false, error: "Couldn't download the image. Try uploading it again." };
  }
}
