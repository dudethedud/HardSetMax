import { describe, expect, it } from 'vitest';
import { checkAccess } from './access.js';

const base = { guildId: 'g', expectedGuildId: 'g', isOwner: false, isAdministrator: false };

describe('checkAccess', () => {
  it('admin commands: admins and the owner', () => {
    expect(checkAccess('admin', base)).toEqual({ ok: false, reason: 'not-admin' });
    expect(checkAccess('admin', { ...base, isAdministrator: true })).toEqual({ ok: true });
    expect(checkAccess('admin', { ...base, isOwner: true })).toEqual({ ok: true });
  });

  it('owner commands: only the owner', () => {
    expect(checkAccess('owner', { ...base, isAdministrator: true })).toEqual({ ok: false, reason: 'not-owner' });
    expect(checkAccess('owner', { ...base, isOwner: true })).toEqual({ ok: true });
  });

  it('only in the configured server', () => {
    expect(checkAccess('admin', { ...base, guildId: null, isOwner: true })).toEqual({ ok: false, reason: 'not-in-guild' });
    expect(checkAccess('admin', { ...base, guildId: 'other', isOwner: true })).toEqual({ ok: false, reason: 'wrong-guild' });
  });
});
