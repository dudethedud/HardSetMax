// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, ComponentType, MessageFlags, PermissionFlagsBits, PermissionsBitField, type Client, type GuildMember, type Role } from 'discord.js';
import { createDb, type Db } from '../db/prisma.js';
import { ColourMenuService, MENU_SELECT_PREFIX, REP_MESSAGE } from './colourMenus.js';

const url = process.env['TEST_DATABASE_URL'];
const GUILD = '900000000000000001';
const BOT_TOP = '900000000000000099';
const TAG = '900000000000000010';
const STATUS = '900000000000000011';
const ROSE = '900000000000000020';
const GOLD = '900000000000000021';
const MOCHA = '900000000000000022';
const MOD = '900000000000000030';
const HIGH = '900000000000000031';
const LOG = '900000000000000040';
const CHANNEL = '900000000000000041';
const USER = '100000000000000001';

describe.skipIf(!url)('colour menus', () => {
  const db: Db = createDb({ connectionString: url }, 3);

  beforeEach(async () => {
    await db.$transaction([db.menuColour.deleteMany(), db.colourMenu.deleteMany(), db.unlockRole.deleteMany(), db.settings.deleteMany()]);
  });
  afterAll(() => db.$disconnect());

  function setup() {
    const roles = new Collection<string, Role>();
    const guild = {
      id: GUILD,
      roles: { cache: roles },
      members: { me: { roles: { highest: { position: 50 } } }, fetch: () => Promise.resolve(members) },
    } as unknown as Role['guild'];
    const role = (id: string, name: string, position: number, perms: bigint = 0n, managed = false) => {
      const r = { id, name, position, managed, guild, permissions: new PermissionsBitField(perms), toString: () => `<@&${id}>` } as unknown as Role;
      roles.set(id, r);
      return r;
    };
    role(BOT_TOP, 'Bot', 50);
    const roleObjs = {
      tag: role(TAG, 'Repper (tag)', 5),
      status: role(STATUS, 'Repper (status)', 5),
      rose: role(ROSE, 'Rose ⸝⸝', 10),
      gold: role(GOLD, 'Gold ⸝⸝', 10),
      mocha: role(MOCHA, 'Mocha ⸝⸝', 10),
      mod: role(MOD, 'Mod colour', 10, PermissionFlagsBits.KickMembers),
      high: role(HIGH, 'Above bot', 60),
    };
    const members = new Collection<string, GuildMember>();
    const changes: string[] = [];
    const member = (id: string, start: string[]) => {
      const cache = new Collection<string, Role>(start.map((r) => [r, roles.get(r)!]));
      const m = {
        id,
        guild,
        user: { bot: false },
        roles: {
          cache,
          set: (ids: string[]) => {
            cache.clear();
            for (const r of ids) cache.set(r, roles.get(r)!);
            changes.push(`set:${ids.join(',')}`);
            return Promise.resolve();
          },
          remove: (ids: string[]) => {
            for (const r of ids) cache.delete(r);
            changes.push(`remove:${ids.join(',')}`);
            return Promise.resolve();
          },
        },
      } as unknown as GuildMember;
      members.set(id, m);
      return m;
    };
    const sent: { channelId: string; opts: Record<string, unknown> }[] = [];
    const messages = new Map<string, { id: string; edits: unknown[]; deleted: boolean; edit: (o: unknown) => Promise<unknown>; delete: () => Promise<unknown> }>();
    const channel = (channelId: string) => ({
      id: channelId,
      isSendable: () => true,
      isTextBased: () => true,
      messages: { fetch: (mid: string) => (messages.get(mid) && !messages.get(mid)!.deleted ? Promise.resolve(messages.get(mid)) : Promise.reject(new Error('Unknown Message'))) },
      send: (opts: Record<string, unknown>) => {
        sent.push({ channelId, opts });
        const msg = { id: `m${sent.length}`, edits: [] as unknown[], deleted: false, edit: (o: unknown) => (msg.edits.push(o), Promise.resolve(msg)), delete: () => ((msg.deleted = true), Promise.resolve(msg)) };
        messages.set(msg.id, msg);
        return Promise.resolve(msg);
      },
    });
    const client = { guilds: { cache: new Map([[GUILD, guild]]) }, channels: { fetch: (id: string) => Promise.resolve(channel(id)) } } as unknown as Client;
    const service = new ColourMenuService(client, GUILD, db, pino({ level: 'silent' }));
    return { service, guild, roles: roleObjs, member, changes, sent, messages, channel };
  }

  async function withMenus(t: ReturnType<typeof setup>) {
    await t.service.createMenu('Pinks/Magentas', '🫐', null);
    await t.service.createMenu('Golds/Browns', null, null);
    const [pinks, golds] = await t.service.menus();
    await t.service.addColour(pinks!.id, t.roles.rose);
    await t.service.addColour(golds!.id, t.roles.gold);
    await t.service.addColour(golds!.id, t.roles.mocha);
    await t.service.addUnlockRole(t.roles.tag);
    await t.service.addUnlockRole(t.roles.status);
    return { pinks: pinks!.id, golds: golds!.id };
  }

  it('only safe, reachable roles go in menus, once', async () => {
    const t = setup();
    await t.service.createMenu('Pinks', null, null);
    const [menu] = await t.service.menus();
    expect(await t.service.addColour(menu!.id, t.roles.mod)).toMatch(/moderator or admin/);
    expect(await t.service.addColour(menu!.id, t.roles.high)).toMatch(/above the bot/);
    expect(await t.service.addColour(menu!.id, t.roles.rose)).toMatch(/Added/);
    expect(await t.service.addColour(menu!.id, t.roles.rose)).toMatch(/already in/);
    await t.service.addUnlockRole(t.roles.tag);
    expect(await t.service.addColour(menu!.id, t.roles.tag)).toMatch(/unlock role/);
    expect(await t.service.addUnlockRole(t.roles.rose)).toMatch(/colour role/);
  });

  it('reppers pick one colour across all menus; others are told how to unlock', async () => {
    const t = setup();
    const m = await withMenus(t);
    const stranger = t.member(USER, ['member']);
    expect(await t.service.pick(stranger, m.pinks, ROSE)).toBe(REP_MESSAGE);
    expect(t.changes).toEqual([]);

    const repper = t.member('100000000000000002', ['member', TAG]);
    expect(await t.service.pick(repper, m.pinks, ROSE)).toMatch(/You're now/);
    expect([...repper.roles.cache.keys()]).toEqual(['member', TAG, ROSE]);
    // Picking from another menu swaps it.
    expect(await t.service.pick(repper, m.golds, GOLD)).toMatch(/You're now/);
    expect([...repper.roles.cache.keys()]).toEqual(['member', TAG, GOLD]);
    expect(await t.service.pick(repper, m.golds, GOLD)).toMatch(/already wearing/);
    // A colour from a different menu than the dropdown is refused.
    expect(await t.service.pick(repper, m.pinks, GOLD)).toMatch(/isn’t available/);
    expect(await t.service.pick(repper, m.golds, 'none')).toMatch(/removed/);
    expect([...repper.roles.cache.keys()]).toEqual(['member', TAG]);
  });

  it('losing the last unlock role takes the colour off (and logs it); keeping one does not', async () => {
    const t = setup();
    await withMenus(t);
    await t.service.setLogChannel(LOG);
    const both = t.member('100000000000000003', [TAG, STATUS, ROSE]);
    both.roles.cache.delete(TAG);
    expect(await t.service.check(both)).toBe(0);
    both.roles.cache.delete(STATUS);
    expect(await t.service.check(both)).toBe(1);
    expect([...both.roles.cache.keys()]).toEqual([]);
    expect(t.sent.at(-1)).toMatchObject({ channelId: LOG, opts: { allowedMentions: { parse: [] } } });
    expect(String(t.sent.at(-1)!.opts['content'])).toMatch(/no longer rep the server/);
  });

  it('the sweep fixes everyone; removing an unlock role sweeps too', async () => {
    const t = setup();
    await withMenus(t);
    t.member('100000000000000004', [ROSE]);
    t.member('100000000000000005', [STATUS, GOLD]);
    expect(await t.service.sweep(t.guild)).toBe(1);
    expect(await t.service.removeUnlockRole(STATUS)).toMatch(/Took colours off 1/);
  });

  it('a menu is a banner plus a box with the heading, the roles, "Max Selection: 1" and the dropdown', async () => {
    const t = setup();
    await t.service.createMenu('Pinks/Magentas', '🫐', { name: 'banner.png', data: Buffer.from([1, 2, 3]) });
    const [menu] = await t.service.menus();
    await t.service.addColour(menu!.id, t.roles.rose);
    const [full] = await t.service.menus();
    const out = t.service.render(full!, t.guild);
    expect(out.flags).toBe(MessageFlags.IsComponentsV2);
    const json = (out.components as { toJSON(): { type: number; components?: { type: number; content?: string; components?: { custom_id?: string; placeholder?: string; options?: { label: string; value: string }[] }[] }[] } }[]).map((c) => c.toJSON());
    expect(json[0]!.type).toBe(ComponentType.MediaGallery);
    const box = json[1]!;
    expect(box.type).toBe(ComponentType.Container);
    expect(box.components![0]!.content).toBe('## 🫐 __Pinks/Magentas__');
    expect(box.components![2]!.content).toBe(`<@&${ROSE}>\n╰ Max Selection: **1**`);
    const select = box.components![4]!.components![0]!;
    expect(select).toMatchObject({ custom_id: MENU_SELECT_PREFIX + menu!.id, placeholder: 'Make a selection' });
    expect(select.options!.map((o) => o.value)).toEqual([ROSE, 'none']);
  });

  it('posts menus in order, then edits them in place; fresh reposts', async () => {
    const t = setup();
    await withMenus(t);
    expect(await t.service.post(t.channel(CHANNEL) as never, false)).toMatch(/2 posted, 0 updated/);
    expect(t.sent.map((s) => s.channelId)).toEqual([CHANNEL, CHANNEL]);
    expect(await t.service.post(t.channel(CHANNEL) as never, false)).toMatch(/0 posted, 2 updated/);
    // Adding a colour updates the posted message.
    const [pinks] = await t.service.menus();
    expect(await t.service.addColour(pinks!.id, t.roles.mocha)).toMatch(/already in/);
    expect(await t.service.removeColour(MOCHA)).toMatch(/posted menu is updated/);
    expect(await t.service.post(t.channel(CHANNEL) as never, true)).toMatch(/2 posted, 0 updated/);
    expect(t.messages.get('m1')!.deleted).toBe(true);
  });

  it('summaries (autocomplete, list) never load banners', async () => {
    const t = setup();
    await t.service.createMenu('Pinks', '🍓', { name: 'banner.gif', data: Buffer.alloc(1024 * 1024, 7) });
    const [menu] = await t.service.menus();
    await t.service.addColour(menu!.id, t.roles.rose);
    const [summary] = await t.service.summaries();
    expect(summary).toEqual({ id: menu!.id, title: 'Pinks', emoji: '🍓', position: 0, channelId: null, messageId: null, colours: [{ roleId: ROSE }] });
    expect(summary).not.toHaveProperty('banner');
  });
});
