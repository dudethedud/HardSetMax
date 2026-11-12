import { describe, expect, it } from 'vitest';
import { fillEmojis } from './emojiText.js';

describe('fillEmojis', () => {
  const server: Record<string, string> = { animblueheart: '<a:animBlueHeart:111>', blue_1: '<:blue_1:222>' };
  const lookup = (name: string) => server[name.toLowerCase()] ?? null;

  it('uses the server emoji by name (any case), or the fallback when it is missing', () => {
    expect(fillEmojis('{animBlueHeart|💙} hi {blue_1|1.} {gone|✦}', lookup)).toBe('<a:animBlueHeart:111> hi <:blue_1:222> ✦');
  });

  it('leaves other braces alone', () => {
    expect(fillEmojis('{not a token} {x|y}', lookup)).toBe('{not a token} {x|y}');
  });
});
