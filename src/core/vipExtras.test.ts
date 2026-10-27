import { describe, expect, it } from 'vitest';
import { usableProviders, type ProviderState } from './ai/chain.js';
import { checkColourRequest, isVeteran, treatLine, treatTargetError, TREAT_LINES, VIP_AI_RESERVE } from './vipExtras.js';

describe('VIP extras', () => {
  it('veteran after 14 days in a row', () => {
    expect(isVeteran(13)).toBe(false);
    expect(isVeteran(14)).toBe(true);
  });

  it('treats go to someone else in the server, not bots', () => {
    const t = { giverId: '1', receiverId: '2', isBot: false, inServer: true };
    expect(treatTargetError(t)).toBeNull();
    expect(treatTargetError({ ...t, receiverId: '1' })).toMatch(/someone else/);
    expect(treatTargetError({ ...t, isBot: true })).toMatch(/Bots/);
    expect(treatTargetError({ ...t, inServer: false })).toMatch(/not in the server/);
    expect(treatLine(0)).toBe(TREAT_LINES[0]);
    expect(treatLine(1)).toBe(TREAT_LINES.at(-1));
  });

  it('colour requests: a fresh name, two readable colours, no blocked words', () => {
    const ctx = { existingNames: ['Ocean Glow'], blockedWords: ['badword'] };
    expect(checkColourRequest({ name: ' Peach   Fizz ', hex: 'ffb38a', hex2: '#ff6fb5' }, ctx)).toEqual({ ok: true, value: { name: 'Peach Fizz', hex: '#FFB38A', hex2: '#FF6FB5' } });
    const bad = checkColourRequest({ name: 'ocean glow', hex: '#000000', hex2: 'pink' }, ctx);
    expect(!bad.ok && bad.errors).toHaveLength(3);
    expect(checkColourRequest({ name: 'B4dword Blue', hex: '#3366FF', hex2: '#33CCFF' }, ctx).ok).toBe(false);
    expect(checkColourRequest({ name: 'x', hex: '#3366FF', hex2: '#33CCFF' }, ctx).ok).toBe(false);
  });

  it('non-VIP AI requests leave the last 20% of each daily cap for VIPs', () => {
    const p: ProviderState & { used: number } = { name: 'a', order: 1, enabled: true, dailyCap: 100, resetTimezone: 'UTC', cooldownUntil: null, hasKey: true, used: 80 };
    const now = new Date();
    expect(usableProviders([p], (x) => x.used, now, VIP_AI_RESERVE)).toEqual([]);
    expect(usableProviders([p], (x) => x.used, now)).toEqual([p]);
    expect(usableProviders([{ ...p, used: 79 }], (x) => x.used, now, VIP_AI_RESERVE)).toHaveLength(1);
  });
});
