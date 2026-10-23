import { describe, expect, it } from 'vitest';
import { checkAccess } from './access.js';
import { parseConfigValue } from './configKeys.js';

const GUILD = '123456789012345678';

describe('checkAccess', () => {
  const base = { guildId: GUILD, expectedGuildId: GUILD, isOwner: false, isAdministrator: false, isStaff: false };

  it('lets each level through, and everything below it', () => {
    expect(checkAccess('owner', { ...base, isOwner: true })).toEqual({ ok: true });
    expect(checkAccess('admin', { ...base, isOwner: true })).toEqual({ ok: true });
    expect(checkAccess('admin', { ...base, isAdministrator: true })).toEqual({ ok: true });
    expect(checkAccess('staff', { ...base, isAdministrator: true })).toEqual({ ok: true });
    expect(checkAccess('staff', { ...base, isStaff: true })).toEqual({ ok: true });
  });

  it('rejects lower levels, DMs and other guilds', () => {
    expect(checkAccess('owner', { ...base, isAdministrator: true, isStaff: true })).toEqual({ ok: false, reason: 'not-owner' });
    expect(checkAccess('admin', { ...base, isStaff: true })).toEqual({ ok: false, reason: 'not-admin' });
    expect(checkAccess('staff', base)).toEqual({ ok: false, reason: 'not-staff' });
    expect(checkAccess('staff', { ...base, guildId: null, isOwner: true })).toEqual({ ok: false, reason: 'not-in-guild' });
    expect(checkAccess('staff', { ...base, guildId: '999999999999999999', isOwner: true })).toEqual({ ok: false, reason: 'wrong-guild' });
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
