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

  it('everyone: any member, but only in the server', () => {
    expect(checkAccess('everyone', base)).toEqual({ ok: true });
    expect(checkAccess('everyone', { ...base, guildId: null })).toEqual({ ok: false, reason: 'not-in-guild' });
  });

  it('manage-server: Manage Server, admins or the owner', () => {
    expect(checkAccess('manage-server', base)).toEqual({ ok: false, reason: 'not-staff' });
    expect(checkAccess('manage-server', { ...base, canManageServer: true })).toEqual({ ok: true });
    expect(checkAccess('manage-server', { ...base, isAdministrator: true })).toEqual({ ok: true });
    // Manage Server isn't enough for admin commands.
    expect(checkAccess('admin', { ...base, canManageServer: true })).toEqual({ ok: false, reason: 'not-admin' });
  });

  it('only in the configured server', () => {
    expect(checkAccess('admin', { ...base, guildId: null, isOwner: true })).toEqual({ ok: false, reason: 'not-in-guild' });
    expect(checkAccess('admin', { ...base, guildId: 'other', isOwner: true })).toEqual({ ok: false, reason: 'wrong-guild' });
  });
});
