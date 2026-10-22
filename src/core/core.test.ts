import { describe, expect, it } from 'vitest';
import { checkAdmin } from './adminCheck.js';
import { parseConfigValue } from './configKeys.js';

const GUILD = '123456789012345678';

describe('checkAdmin', () => {
  it('allows an administrator in the configured guild', () => {
    expect(checkAdmin({ guildId: GUILD, expectedGuildId: GUILD, isAdministrator: true })).toEqual({ ok: true });
  });

  it('rejects non-admins, DMs and other guilds', () => {
    expect(checkAdmin({ guildId: GUILD, expectedGuildId: GUILD, isAdministrator: false })).toEqual({
      ok: false,
      reason: 'not-admin',
    });
    expect(checkAdmin({ guildId: null, expectedGuildId: GUILD, isAdministrator: true })).toEqual({
      ok: false,
      reason: 'not-in-guild',
    });
    expect(checkAdmin({ guildId: '999999999999999999', expectedGuildId: GUILD, isAdministrator: true })).toEqual({
      ok: false,
      reason: 'wrong-guild',
    });
  });
});

describe('parseConfigValue', () => {
  it('accepts valid values and maps them to fields', () => {
    expect(parseConfigValue('timezone', ' Europe/London ')).toEqual({
      ok: true,
      key: 'timezone',
      field: 'timezone',
      value: 'Europe/London',
    });
    expect(parseConfigValue('day-boundary', '04:30')).toMatchObject({ ok: true, field: 'dayBoundary', value: '04:30' });
  });

  it('rejects bad values and unknown keys', () => {
    expect(parseConfigValue('timezone', 'Nowhere/Land').ok).toBe(false);
    expect(parseConfigValue('day-boundary', '25:00').ok).toBe(false);
    expect(parseConfigValue('nope', 'x').ok).toBe(false);
    expect(parseConfigValue('toString', 'x').ok).toBe(false);
  });
});
