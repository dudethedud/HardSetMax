import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Interaction } from 'discord.js';
import { MENU_SELECT_PREFIX } from '../services/colourMenus.js';
import type { AppContext } from './commands/types.js';
import { handleInteraction } from './interactions.js';

const GUILD = '900000000000000001';
const ctx = (pick = vi.fn(() => Promise.resolve('🎨 ok'))) =>
  ({ env: { GUILD_ID: GUILD }, log: pino({ level: 'silent' }), colours: { pick, summaries: () => Promise.resolve([{ id: 1, title: 'Pinks', emoji: null, colours: [] }]) } }) as unknown as AppContext;

const base = (over: Record<string, unknown>) =>
  ({
    guildId: GUILD,
    guild: { ownerId: 'owner' },
    user: { id: 'u1' },
    inCachedGuild: () => true,
    isStringSelectMenu: () => false,
    isButton: () => false,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    ...over,
  }) as unknown as Interaction;

describe('interactions', () => {
  it('a member without Administrator is refused /colours', async () => {
    const reply = vi.fn(() => Promise.resolve());
    const deferReply = vi.fn();
    await handleInteraction(base({ isChatInputCommand: () => true, commandName: 'colours', memberPermissions: { has: () => false }, reply, deferReply }), ctx());
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Admins only.' }));
    expect(deferReply).not.toHaveBeenCalled();
  });

  it('autocomplete suggests nothing to non-admins', async () => {
    const respond = vi.fn(() => Promise.resolve());
    await handleInteraction(base({ isAutocomplete: () => true, commandName: 'colours', memberPermissions: { has: () => false }, respond }), ctx());
    expect(respond).toHaveBeenCalledWith([]);
  });

  it('routes a menu pick to the service and answers privately', async () => {
    const pick = vi.fn(() => Promise.resolve('🎨 You’re now Rose!'));
    const editReply = vi.fn(() => Promise.resolve());
    const member = { id: 'u1' };
    await handleInteraction(
      base({
        isStringSelectMenu: () => true,
        customId: `${MENU_SELECT_PREFIX}7`,
        values: ['900000000000000020'],
        member,
        deferReply: vi.fn(() => Promise.resolve()),
        editReply,
        message: { components: [], edit: () => Promise.resolve() },
      }),
      ctx(pick),
    );
    expect(pick).toHaveBeenCalledWith(member, 7, '900000000000000020');
    expect(editReply).toHaveBeenCalledWith({ content: '🎨 You’re now Rose!', allowedMentions: { parse: [] } });
  });

  it('an unknown dropdown says it no longer works', async () => {
    const reply = vi.fn(() => Promise.resolve());
    await handleInteraction(base({ isStringSelectMenu: () => true, customId: 'old:thing', reply }), ctx());
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'This menu no longer works.' }));
  });
});
