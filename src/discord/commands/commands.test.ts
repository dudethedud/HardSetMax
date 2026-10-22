import { InteractionContextType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from './index.js';

describe('registered commands', () => {
  it.each(COMMANDS.map((c) => [c.name, c] as const))('%s is admin-only and guild-only', (_name, command) => {
    expect(command.data.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
    expect(command.data.contexts).toEqual([InteractionContextType.Guild]);
  });

  it('names are unique', () => {
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  });
});
