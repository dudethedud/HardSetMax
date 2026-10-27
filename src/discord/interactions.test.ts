import { Collection, PermissionFlagsBits } from 'discord.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppContext } from './commands/types.js';
import { handleInteraction } from './interactions.js';

const GUILD = '900000000000000001';
const OWNER = '100000000000000099';
const STAFF_ROLE = '900000000000000098';

type Who = 'owner' | 'admin' | 'staff' | 'member';

/** A fake slash command interaction: just enough for the handler. */
function command(name: string, sub: string | null, who: Who) {
  const replies: string[] = [];
  let deferred = false;
  const interaction = {
    guildId: GUILD,
    commandName: name,
    user: { id: who === 'owner' ? OWNER : '100000000000000001' },
    guild: { ownerId: OWNER },
    member: { roles: { cache: new Collection(who === 'staff' ? [[STAFF_ROLE, { id: STAFF_ROLE }]] : []) } },
    memberPermissions: { has: (p: bigint) => p === PermissionFlagsBits.Administrator && who === 'admin' },
    options: { getSubcommand: () => sub, getSubcommandGroup: () => null, getString: () => null, getChannel: () => null },
    isButton: () => false,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isModalSubmit: () => false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    inCachedGuild: () => true,
    get deferred() {
      return deferred;
    },
    replied: false,
    reply: (o: { content: string }) => (replies.push(o.content), Promise.resolve()),
    deferReply: () => ((deferred = true), Promise.resolve()),
    editReply: (o: string | { content: string }) => (replies.push(typeof o === 'string' ? o : o.content), Promise.resolve()),
    showModal: () => (replies.push('<modal>'), Promise.resolve()),
  };
  return { interaction, replies };
}

const ctx = {
  env: { GUILD_ID: GUILD },
  log: pino({ level: 'silent' }),
  db: {
    staffRole: { findMany: () => Promise.resolve([{ roleId: STAFF_ROLE }]) },
    modalDraft: { upsert: () => Promise.resolve() },
  },
  clock: { now: () => new Date('2026-10-26T12:00:00Z') },
  config: { current: { guild: { announceChannelId: '900000000000000070' } } },
  polls: { status: () => Promise.resolve('polls status') },
} as unknown as AppContext;

async function run(name: string, sub: string | null, who: Who): Promise<string[]> {
  const { interaction, replies } = command(name, sub, who);
  await handleInteraction(interaction as never, ctx);
  return replies;
}

describe('command access', () => {
  it('staff can use staff subcommands', async () => {
    expect(await run('vip', 'polls', 'staff')).toEqual(['polls status']);
    expect(await run('vip', 'polls', 'admin')).toEqual(['polls status']);
    expect(await run('vip', 'polls', 'member')).toEqual(['Staff only.']);
  });

  it('admin subcommands need Administrator (or the owner)', async () => {
    expect(await run('vip', 'reshuffle', 'staff')).toEqual(['Admins only.']);
    expect(await run('settings', 'view', 'staff')).toEqual(['Admins only.']);
  });

  it('/announce is the owner’s alone, even over admins', async () => {
    expect(await run('announce', null, 'admin')).toEqual(['Only the server owner can use this.']);
    expect(await run('announce', null, 'staff')).toEqual(['Only the server owner can use this.']);
    expect(await run('announce', null, 'owner')).toEqual(['<modal>']);
  });
});

describe('autocomplete', () => {
  async function suggest(who: Who): Promise<unknown[]> {
    const { interaction } = command('bot', 'ai-provider', who);
    let shown: unknown[] = ['not answered'];
    const auto = {
      ...interaction,
      isChatInputCommand: () => false,
      isAutocomplete: () => true,
      options: { ...interaction.options, getFocused: () => '' },
      respond: (choices: unknown[]) => ((shown = choices), Promise.resolve()),
    };
    const withProviders = { ...ctx, ai: { providers: () => Promise.resolve([{ name: 'groq', model: 'm', enabled: true }]) } } as unknown as AppContext;
    await handleInteraction(auto as never, withProviders);
    return shown;
  }

  it('suggests to people who can run the subcommand, and shows nothing to others', async () => {
    expect(await suggest('admin')).toEqual([{ name: 'groq (m)', value: 'groq' }]);
    expect(await suggest('staff')).toEqual([]);
    expect(await suggest('member')).toEqual([]);
  });
});

describe('setup menus', () => {
  it('only admins (or the owner) can use them', async () => {
    for (const [who, allowed] of [['staff', false], ['member', false], ['admin', true]] as const) {
      const { interaction, replies } = command('bot', null, who);
      let ran = false;
      const pick = {
        ...interaction,
        customId: 'setup:pick:announcements',
        values: [],
        isChatInputCommand: () => false,
        isChannelSelectMenu: () => true,
        deferReply: () => ((ran = true), Promise.resolve()),
      };
      await handleInteraction(pick as never, ctx);
      expect(ran).toBe(allowed);
      if (!allowed) expect(replies).toEqual(['Admins only.']);
    }
  });
});
