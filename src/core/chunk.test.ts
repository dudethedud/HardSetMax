import { describe, expect, it } from 'vitest';
import { chunkLines } from './chunk.js';

describe('chunkLines', () => {
  it('keeps short reports in one message', () => {
    expect(chunkLines(['a', 'b'])).toEqual(['a\nb']);
    expect(chunkLines([])).toEqual([]);
  });

  it('splits between lines, never losing one', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(80)}`);
    const parts = chunkLines(lines, 2000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 2000)).toBe(true);
    expect(parts.join('\n').split('\n')).toEqual(lines);
  });

  it('cuts a single line that is too long on its own', () => {
    expect(chunkLines(['y'.repeat(30)], 10)).toEqual([`${'y'.repeat(9)}…`]);
  });
});
