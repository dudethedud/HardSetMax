import { describe, expect, it } from 'vitest';
import { imageExtension, isDiscordCdnUrl } from './banner.js';

describe('banner uploads', () => {
  it("only Discord's CDN over https", () => {
    expect(isDiscordCdnUrl('https://cdn.discordapp.com/attachments/1/2/a.png')).toBe(true);
    expect(isDiscordCdnUrl('https://media.discordapp.net/attachments/1/2/a.gif')).toBe(true);
    expect(isDiscordCdnUrl('http://cdn.discordapp.com/a.png')).toBe(false);
    expect(isDiscordCdnUrl('https://cdn.discordapp.com.evil.example/a.png')).toBe(false);
    expect(isDiscordCdnUrl('nope')).toBe(false);
  });

  it('checks the real image type from its bytes', () => {
    expect(imageExtension(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(imageExtension(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(imageExtension(new TextEncoder().encode('GIF89a'))).toBe('gif');
    expect(imageExtension(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(imageExtension(new TextEncoder().encode('<svg>'))).toBeNull();
  });
});
