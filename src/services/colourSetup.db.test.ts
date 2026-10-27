// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, GuildFeature, type Client, type Role } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { DEFAULT_COLOURS } from '../core/polls.js';
import { createDb, type Db } from '../db/prisma.js';
import { ColourService } from './colours.js';
import type { ModLog } from './modLog.js';
import type { RoleQueue } from './roleQueue.js';
import type { VipService } from './vipService.js';

const url = process.env['TEST_DATABASE_URL'];
const GUILD = '900000000000000001';
const VIP_ROLE = '900000000000000050';

describe.skipIf(!url)('VIP colour roles', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  beforeEach(async () => {
    await db.$transaction([
      db.userColourChoice.deleteMany(),
      db.colourOption.deleteMany(),
      db.staffRole.deleteMany(),
      db.badge.deleteMany(),
      db.crownTitle.deleteMany(),
      db.customRole.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD, vipRoleId: VIP_ROLE } });
  });
  afterAll(() => db.$disconnect());

  type FakeRole = { id: string; name: string; position: number; managed: boolean; permissions: { bitfield: bigint }; colors: { primaryColor: number; secondaryColor: number | null }; members: Collection<string, unknown>; edit: (o: { colors?: { primaryColor: number; secondaryColor?: number } }) => Promise<FakeRole> };

  async function setup(opts: { gradients: boolean; existing?: { name: string; members: number }[] }) {
    const roles = new Collection<string, FakeRole>();
    let next = 0;
    const add = (id: string, name: string, colors: { primaryColor: number; secondaryColor?: number } = { primaryColor: 0 }, members = 0) => {
      const role: FakeRole = {
        id,
        name,
        position: 5,
        managed: false,
        permissions: { bitfield: 0n },
        colors: { primaryColor: colors.primaryColor, secondaryColor: colors.secondaryColor ?? null },
        members: new Collection(Array.from({ length: members }, (_, i) => [`m${i}`, {}])),
        edit: (o) => {
          if (o.colors) role.colors = { primaryColor: o.colors.primaryColor, secondaryColor: o.colors.secondaryColor ?? null };
          return Promise.resolve(role);
        },
      };
      roles.set(id, role);
      return role;
    };
    add(VIP_ROLE, 'VIP');
    const bot = add('900000000000000099', 'Bot');
    bot.position = 50;
    for (const [i, r] of (opts.existing ?? []).entries()) add(`90000000000000030${i}`, r.name, { primaryColor: 0x123456 }, r.members);
    const guild = {
      id: GUILD,
      features: opts.gradients ? [GuildFeature.EnhancedRoleColors] : [],
      members: { me: { roles: { highest: bot } }, cache: new Collection() },
      roles: { cache: roles, create: (o: { name: string; colors: { primaryColor: number; secondaryColor?: number } }) => Promise.resolve(add(`90000000000000200${next++}`, o.name, o.colors)) },
    };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const vip = { vips: new Map() } as unknown as VipService;
    const modLog = { post: () => Promise.resolve() } as unknown as ModLog;
    const colours = new ColourService(client, GUILD, db, config, { run: () => Promise.resolve({ ok: true }) } as unknown as RoleQueue, vip, modLog, pino({ level: 'silent' }));
    const report: string[] = [];
    await colours.setup(guild as never, roles.get(VIP_ROLE) as unknown as Role, report);
    return { colours, roles, report };
  }

  it('creates the default VIP gradients as gradient roles where the server supports them', async () => {
    const t = await setup({ gradients: true });
    const options = await t.colours.options();
    expect(options.map((o) => o.name)).toEqual(DEFAULT_COLOURS.map((c) => c.name));
    const first = t.roles.get(options[0]!.roleId!)!;
    expect(first.colors).toEqual({ primaryColor: 0xff9ae2, secondaryColor: 0x9b8cff });
  });

  it('uses the first colour only on servers without gradient roles', async () => {
    const t = await setup({ gradients: false });
    const first = t.roles.get((await t.colours.options())[0]!.roleId!)!;
    expect(first.colors).toEqual({ primaryColor: 0xff9ae2, secondaryColor: null });
  });

  it('never takes over an existing role people already have, even with a matching (decorated) name', async () => {
    const t = await setup({ gradients: true, existing: [{ name: 'Ocean Glow ⸝⸝', members: 12 }, { name: 'Frostbite ⸝⸝', members: 0 }] });
    const options = await t.colours.options();
    const ocean = options.find((o) => o.name === 'Ocean Glow')!;
    const frost = options.find((o) => o.name === 'Frostbite')!;
    expect(ocean.roleId).not.toBe('900000000000000300'); // worn by 12 people: left alone, a new role is made
    expect(t.roles.get('900000000000000300')!.colors.primaryColor).toBe(0x123456);
    expect(frost.roleId).toBe('900000000000000301'); // unused: taken over
  });

  it('reset replaces old colours with the default gradients', async () => {
    const t = await setup({ gradients: true });
    await db.colourOption.deleteMany();
    await db.colourOption.create({ data: { name: 'Rose', hex: '#FF6B9D', position: 0 } });
    expect(await t.colours.resetToDefaults('100000000000000001')).toMatch(/Starlight Bloom/);
    expect((await t.colours.options()).map((o) => o.name)).toEqual(DEFAULT_COLOURS.map((c) => c.name));
  });
});
