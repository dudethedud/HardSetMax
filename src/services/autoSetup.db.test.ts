// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ChannelType, Collection, PermissionFlagsBits, type Guild, type Role } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { createDb, type Db } from '../db/prisma.js';
import { autoConfigure, homeCategoryId, unblockVipPerks } from './autoSetup.js';

const url = process.env['TEST_DATABASE_URL'];
const GUILD = '900000000000000001';
const P = PermissionFlagsBits;

describe.skipIf(!url)('fitting into an existing server', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  beforeEach(async () => {
    await db.$transaction([
      db.staffRole.deleteMany(),
      db.channelWeight.deleteMany(),
      db.colourOption.deleteMany(),
      db.badge.deleteMany(),
      db.crownTitle.deleteMany(),
      db.customRole.deleteMany(),
      db.auditLog.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD } });
  });
  afterAll(() => db.$disconnect());

  function fakeGuild() {
    const role = (id: string, name: string, position: number, perms = 0n, managed = false) => ({
      id,
      name,
      position,
      managed,
      permissions: { has: (p: bigint) => (perms & p) === p },
      toString: () => `<@&${id}>`,
    });
    const roles = new Collection(
      [role(GUILD, '@everyone', 0), role('lv10', 'Level 10', 1), role('lv50', 'Level 50', 2), role('mod', 'Mod', 3, P.ModerateMembers | P.ManageMessages), role('bot', 'Puppyboy Carter', 9, P.Administrator, true)].map(
        (r) => [r.id, r],
      ),
    );
    const edits: { channel: string; role: string; allow: Record<string, boolean> }[] = [];
    const channel = (id: string, name: string, type: ChannelType, opts: { everyoneDeny?: bigint; parentId?: string; locked?: boolean } = {}) => {
      const overwrites = new Collection<string, { deny: { bitfield: bigint }; allow: { bitfield: bigint } }>();
      if (opts.everyoneDeny) overwrites.set(GUILD, { deny: { bitfield: opts.everyoneDeny }, allow: { bitfield: 0n } });
      return {
        id,
        name,
        type,
        parentId: opts.parentId ?? null,
        parent: null as unknown,
        permissionsLocked: opts.locked ?? false,
        isThread: () => false,
        permissionOverwrites: {
          cache: overwrites,
          edit: (r: { id: string }, allow: Record<string, boolean>) => (edits.push({ channel: id, role: r.id, allow }), Promise.resolve()),
        },
      };
    };
    const channels = new Collection(
      [
        channel('cat', 'Community', ChannelType.GuildCategory, { everyoneDeny: P.AttachFiles }),
        channel('general', '💬・general', ChannelType.GuildText, { parentId: 'cat', locked: true }),
        channel('news', 'news', ChannelType.GuildAnnouncement, { parentId: 'cat', locked: true }),
        channel('logs', 'mod-logs', ChannelType.GuildText, { everyoneDeny: P.ViewChannel }),
        channel('cmds', 'bot-commands', ChannelType.GuildText),
        channel('memes', 'memes', ChannelType.GuildText, { everyoneDeny: P.EmbedLinks | P.AttachFiles }),
        channel('rules', 'rules', ChannelType.GuildText, { everyoneDeny: P.SendMessages | P.AttachFiles }),
      ].map((c) => [c.id, c]),
    );
    for (const c of channels.values()) c.parent = c.parentId ? channels.get(c.parentId) : null;
    const guild = { id: GUILD, roles: { cache: roles }, channels: { cache: channels }, members: { me: { roles: { highest: roles.get('bot') } } } } as unknown as Guild;
    return { guild, edits };
  }

  it('fills in the top level role, staff, channels and quiet channels, and reports each guess', async () => {
    const { guild } = fakeGuild();
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const report: string[] = [];
    await autoConfigure(guild, db, config, report);

    const cfg = config.current.guild;
    expect(cfg.levelRolesTopId).toBe('lv50');
    expect((await db.staffRole.findMany()).map((s) => s.roleId)).toEqual(['mod']);
    expect([cfg.mainChatChannelId, cfg.announceChannelId, cfg.modLogChannelId]).toEqual(['general', 'news', 'logs']);
    expect(await db.channelWeight.findMany({ select: { channelId: true, weight: true } })).toEqual([{ channelId: 'cmds', weight: 0 }]);
    expect(report).toHaveLength(6);
    expect(homeCategoryId(guild, cfg)).toBe('cat');

    // Admin changes stick: the weight isn't zeroed again, set values aren't replaced.
    await db.channelWeight.deleteMany();
    await db.guildConfig.update({ where: { guildId: GUILD }, data: { mainChatChannelId: 'memes' } });
    await config.load();
    const again: string[] = [];
    await autoConfigure(guild, db, config, again);
    expect(await db.channelWeight.count()).toBe(0);
    expect(config.current.guild.mainChatChannelId).toBe('memes');
    expect(again).toEqual([]);
  });

  it('unblocks VIP perks where a channel denies them to everyone, on the category for synced channels', async () => {
    const { guild, edits } = fakeGuild();
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const report: string[] = [];
    const vip = { id: 'vip' } as Role;
    await unblockVipPerks(guild, vip, [P.AttachFiles, P.EmbedLinks, P.UseExternalEmojis], config.current.guild, report);
    expect(edits.map((e) => [e.channel, Object.keys(e.allow).sort()])).toEqual([
      ['cat', ['AttachFiles']],
      ['memes', ['AttachFiles', 'EmbedLinks']],
    ]);
    // Not the private log channel, not the read-only rules channel, not the synced children themselves.
    expect(report[0]).toMatch(/2 place/);
  });
});
