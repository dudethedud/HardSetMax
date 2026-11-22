import { describe, expect, it } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { COMMANDS } from './index.js';

describe('commands', () => {
  it('every command is guild only; admin, staff and public ones are hidden from the right people', () => {
    expect(COMMANDS.map((c) => [c.name, c.level])).toEqual([
      ['colours', 'admin'],
      ['donations', 'admin'],
      ['invites', 'everyone'],
      ['leaderboard', 'everyone'],
      ['invite-link', 'everyone'],
      ['invite-event', 'manage-server'],
    ]);
    const perms = { admin: PermissionFlagsBits.Administrator.toString(), 'manage-server': PermissionFlagsBits.ManageGuild.toString(), everyone: undefined };
    for (const c of COMMANDS) {
      expect(c.data.default_member_permissions).toBe(perms[c.level as keyof typeof perms]);
      expect(c.data.contexts).toEqual([0]);
    }
    expect((COMMANDS[1]!.data.options ?? []).map((o) => o.name)).toEqual(['setup', 'goal', 'banner', 'tier', 'donor-role', 'add', 'remove', 'list', 'reset']);
    expect((COMMANDS[5]!.data.options ?? []).map((o) => o.name)).toEqual(['review', 'disqualify', 'reinstate', 'set-status', 'raffle-export', 'freeze']);
  });

  it('has the menu, unlock-role, post and log-channel commands', () => {
    const options = (COMMANDS[0]!.data.options ?? []) as { name: string; options?: { name: string }[] }[];
    expect(options.map((o) => o.name)).toEqual(['menu', 'unlock-role', 'post', 'log-channel']);
    expect(options[0]!.options!.map((o) => o.name)).toEqual(['create', 'edit', 'delete', 'add-role', 'remove-role', 'list']);
    expect(options[1]!.options!.map((o) => o.name)).toEqual(['add', 'remove', 'list']);
  });
});
