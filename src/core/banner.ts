// Menu banner uploads (pure checks). Only Discord's own file servers, and only
// real images (checked by their first bytes).

export const BANNER_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export function isDiscordCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && DISCORD_CDN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** The file extension for an image's first bytes, or null if it isn't PNG, JPG, GIF or WebP. */
export function imageExtension(data: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'webp';
  return null;
}
