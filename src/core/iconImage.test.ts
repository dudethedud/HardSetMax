import { describe, expect, it } from 'vitest';
import { checkIconBytes, isDiscordCdnUrl, sniffImageType } from './iconImage.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]);

describe('role icon images', () => {
  it("only downloads from Discord's CDN over https", () => {
    expect(isDiscordCdnUrl('https://cdn.discordapp.com/attachments/1/2/icon.png?ex=1')).toBe(true);
    expect(isDiscordCdnUrl('https://media.discordapp.net/attachments/1/2/icon.png')).toBe(true);
    expect(isDiscordCdnUrl('http://cdn.discordapp.com/attachments/1/2/icon.png')).toBe(false);
    expect(isDiscordCdnUrl('https://cdn.discordapp.com.evil.example/icon.png')).toBe(false);
    expect(isDiscordCdnUrl('https://evil.example/cdn.discordapp.com/icon.png')).toBe(false);
    expect(isDiscordCdnUrl('not a url')).toBe(false);
  });

  it('checks the real file type from its bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPG)).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBeNull();
  });

  it('rejects empty, oversized or non-image files', () => {
    expect(checkIconBytes(PNG)).toEqual({ ok: true, type: 'image/png' });
    expect(checkIconBytes(new Uint8Array()).ok).toBe(false);
    const big = new Uint8Array(256 * 1024 + 1);
    big.set(PNG);
    expect(checkIconBytes(big).ok).toBe(false);
    expect(checkIconBytes(new TextEncoder().encode('<svg></svg>')).ok).toBe(false);
  });
});
