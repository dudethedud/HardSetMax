// Role icon images: only ever downloaded from Discord's own file servers, and
// only real PNG/JPG files (checked by their first bytes, not just the name).
import { ROLE_ICON_MAX_BYTES } from './crown.js';

const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** Whether a URL points at an uploaded file on Discord's CDN (https only). */
export function isDiscordCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && DISCORD_CDN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** The image type from its first bytes, or null if it isn't a PNG or JPG. */
export function sniffImageType(data: Uint8Array): 'image/png' | 'image/jpeg' | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= 8 && png.every((b, i) => data[i] === b)) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  return null;
}

export type IconCheck = { ok: true; type: 'image/png' | 'image/jpeg' } | { ok: false; error: string };

/** Checks downloaded bytes before they become a role icon. */
export function checkIconBytes(data: Uint8Array): IconCheck {
  if (data.length === 0) return { ok: false, error: 'The image was empty.' };
  if (data.length > ROLE_ICON_MAX_BYTES) return { ok: false, error: 'The icon image must be 256 KB or smaller (Discord’s limit for role icons).' };
  const type = sniffImageType(data);
  return type ? { ok: true, type } : { ok: false, error: 'The icon image must be a PNG or JPG.' };
}
