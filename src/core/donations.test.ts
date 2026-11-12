import { describe, expect, it } from 'vitest';
import { donorLabel, findCode, formatMoney, makeCode, parseKofi, progressBar, toCents, tokenMatches, topDonors } from './donations.js';

const TOKEN = 'secret-token-123';
const body = (over: Record<string, unknown> = {}) =>
  new URLSearchParams({
    data: JSON.stringify({
      verification_token: TOKEN,
      message_id: 'msg-1',
      type: 'Donation',
      is_public: true,
      from_name: 'Bubbles',
      message: 'love the server! SH-7k2f',
      amount: '5.00',
      currency: 'USD',
      email: 'someone@example.com',
      ...over,
    }),
  }).toString();

describe('Ko-fi webhook', () => {
  it('reads a donation, with the donor code from the message and no email', () => {
    const r = parseKofi(body(), TOKEN);
    expect(r).toEqual({ ok: true, donation: { kofiId: 'msg-1', displayName: 'Bubbles', amountCents: 500, currency: 'USD', isPublic: true, code: 'SH-7K2F' } });
    expect(JSON.stringify(r)).not.toContain('example.com');
  });

  it('a private donation is anonymous and not linked to anyone', () => {
    expect(parseKofi(body({ is_public: false }), TOKEN)).toMatchObject({ ok: true, donation: { displayName: 'Anonymous', isPublic: false, code: null } });
  });

  it('refuses a wrong token and bad data; ignores shop orders and commissions', () => {
    expect(parseKofi(body({ verification_token: 'guess' }), TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(parseKofi('data=not-json', TOKEN)).toMatchObject({ ok: false, status: 400 });
    expect(parseKofi('', TOKEN)).toMatchObject({ ok: false, status: 400 });
    expect(parseKofi(body({ amount: '-3' }), TOKEN)).toMatchObject({ ok: false, status: 400 });
    expect(parseKofi(body({ type: 'Shop Order' }), TOKEN)).toMatchObject({ ok: 'ignored' });
    expect(parseKofi(body({ type: 'Subscription' }), TOKEN)).toMatchObject({ ok: true });
  });

  it('token check', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
  });
});

describe('donation helpers', () => {
  it('money', () => {
    expect(toCents('3')).toBe(300);
    expect(toCents('3.5')).toBe(350);
    expect(toCents('10.99')).toBe(1099);
    expect(toCents('0')).toBeNull();
    expect(toCents('1e3')).toBeNull();
    expect(formatMoney(1099)).toBe('$10.99');
    expect(formatMoney(500, 'EUR')).toBe('5.00 EUR');
  });

  it('codes: readable, found in any case, prefix required', () => {
    const code = makeCode(Uint8Array.from([0, 1, 2, 3]));
    expect(code).toMatch(/^SH-[A-Z2-9]{4}$/);
    expect(findCode(`hi ${code.toLowerCase()} :)`)).toBe(code);
    expect(findCode('7K2F')).toBeNull();
    expect(findCode(null)).toBeNull();
  });

  it('progress bar', () => {
    expect(progressBar(4000, 10000)).toBe('▰▰▰▰▱▱▱▱▱▱ 40%');
    expect(progressBar(15000, 10000)).toBe('▰▰▰▰▰▰▰▰▰▰ 150%');
  });

  it('top donors: members and Ko-fi names add up; anonymous and private are left out', () => {
    const rows = [
      { userId: '1', displayName: 'a', amountCents: 300, isPublic: true },
      { userId: '1', displayName: 'a', amountCents: 300, isPublic: true },
      { userId: null, displayName: 'Bubbles', amountCents: 500, isPublic: true },
      { userId: null, displayName: 'Anonymous', amountCents: 9000, isPublic: true },
      { userId: '2', displayName: 'b', amountCents: 9000, isPublic: false },
    ];
    expect(topDonors(rows)).toEqual([
      { label: '<@1>', cents: 600 },
      { label: '**Bubbles**', cents: 500 },
    ]);
    expect(donorLabel({ userId: null, displayName: '**@everyone**', isPublic: true })).toBe('**everyone**');
    expect(donorLabel({ userId: null, displayName: '{blue_1|x}', isPublic: true })).toBe('**blue1x**');
    expect(donorLabel({ userId: '9', displayName: 'x', isPublic: false })).toBe('Someone');
  });
});
