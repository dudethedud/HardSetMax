import { describe, expect, it } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { COMMANDS } from './index.js';

describe('commands', () => {
  it('/colours and /donations, both admin only and guild only', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['colours', 'donations']);
    for (const c of COMMANDS) {
      expect(c.level).toBe('admin');
      expect(c.data.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
      expect(c.data.contexts).toEqual([0]);
    }
    expect((COMMANDS[1]!.data.options ?? []).map((o) => o.name)).toEqual(['setup', 'goal', 'banner', 'tier', 'donor-role', 'add', 'remove', 'list', 'reset']);
  });

  it('has the menu, unlock-role, post and log-channel commands', () => {
    const options = (COMMANDS[0]!.data.options ?? []) as { name: string; options?: { name: string }[] }[];
    expect(options.map((o) => o.name)).toEqual(['menu', 'unlock-role', 'post', 'log-channel']);
    expect(options[0]!.options!.map((o) => o.name)).toEqual(['create', 'edit', 'delete', 'add-role', 'remove-role', 'list']);
    expect(options[1]!.options!.map((o) => o.name)).toEqual(['add', 'remove', 'list']);
  });
});
