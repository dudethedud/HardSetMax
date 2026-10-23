import { InteractionContextType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { COMMANDS, COMMANDS_BY_NAME } from './index.js';

const command = (name: string) => COMMANDS_BY_NAME.get(name)!;

describe('registered commands', () => {
  it.each(COMMANDS.map((c) => [c.name, c] as const))('%s is guild-only and hidden from regular members', (_name, c) => {
    expect([PermissionFlagsBits.Administrator.toString(), PermissionFlagsBits.ModerateMembers.toString()]).toContain(c.data.default_member_permissions);
    expect(c.data.contexts).toEqual([InteractionContextType.Guild]);
  });

  it('names are unique, and there are only a few', () => {
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
    expect(COMMANDS.map((c) => c.name).sort()).toEqual(['announce', 'bot', 'settings', 'stats', 'vip']);
  });

  it('shows staff commands to Timeout Members, the rest to Administrators', () => {
    for (const name of ['stats', 'vip', 'bot']) expect(command(name).data.default_member_permissions).toBe(PermissionFlagsBits.ModerateMembers.toString());
    for (const name of ['settings', 'announce']) expect(command(name).data.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
  });

  it('checks each subcommand at the right level', () => {
    expect(command('stats').levelFor(null, null)).toBe('staff');
    for (const sub of ['list', 'preview', 'polls', 'crown']) expect(command('vip').levelFor(sub, null)).toBe('staff');
    for (const sub of ['pin', 'unpin', 'remove', 'unblock', 'reshuffle', 'adjust', 'poll-unlock', 'crown-give', 'crown-reset', 'crown-lock']) {
      expect(command('vip').levelFor(sub, null)).toBe('admin');
    }
    expect(command('bot').levelFor('health', null)).toBe('staff');
    for (const sub of ['setup', 'ai', 'ai-provider']) expect(command('bot').levelFor(sub, null)).toBe('admin');
    expect(command('settings').levelFor('role', null)).toBe('admin');
    expect(command('announce').levelFor(null, null)).toBe('owner');
  });

  it('every subcommand is registered', () => {
    const subs = (name: string) => (command(name).data.options ?? []).map((o) => o.name).sort();
    expect(subs('vip')).toEqual(['adjust', 'crown', 'crown-give', 'crown-lock', 'crown-reset', 'list', 'pin', 'poll-unlock', 'polls', 'preview', 'remove', 'reshuffle', 'unblock', 'unpin']);
    expect(subs('settings')).toEqual(['badge', 'blocked-word', 'channel', 'channel-weight', 'colour', 'role', 'set', 'view']);
    expect(subs('bot')).toEqual(['ai', 'ai-provider', 'health', 'setup']);
  });
});
