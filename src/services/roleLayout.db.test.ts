// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Collection, type Guild } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { createDb, type Db } from '../db/prisma.js';
import { arrangeRoles } from './roleLayout.js';

const url = process.env['TEST_DATABASE_URL'];
const GUILD = '900000000000000001';

describe.skipIf(!url)('role layout', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  beforeEach(async () => {
    await db.$transaction([
      db.crownHolder.deleteMany(),
      db.customRole.deleteMany(),
      db.crownTitle.deleteMany(),
      db.colourOption.deleteMany(),
      db.badge.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
  });
  afterAll(() => db.$disconnect());

  it('stacks every bot role together around VIP, leaving other roles alone', async () => {
    // The server from the owner's screenshot, jumbled: bottom (@everyone) to top (bot).
    const start = ['@everyone', 'Legend', 'Veteran', 'Regular', 'Jester', 'Advisor', 'Champion', 'Polls', 'Mod', 'Level 50', 'VIP', 'Snow', 'Rose', 'Crown', 'Bot'];
    type FakeRole = { id: string; name: string; position: number; rawPosition: number };
    const roles = new Collection<string, FakeRole>();
    start.forEach((name, i) => roles.set(name, { id: name, name, position: i, rawPosition: i }));
    const guild = {
      id: GUILD,
      members: { me: { roles: { highest: roles.get('Bot') } } },
      roles: {
        cache: roles,
        fetch: () => Promise.resolve(roles),
        setPositions: (list: { role: string; position: number }[]) => {
          for (const { role, position } of list) Object.assign(roles.get(role)!, { position, rawPosition: position });
          return Promise.resolve();
        },
      },
    } as unknown as Guild;

    await db.guildConfig.create({ data: { guildId: GUILD, vipRoleId: 'VIP', crownRoleId: 'Crown', pollsRoleId: 'Polls', levelRolesTopId: 'Level 50' } });
    await db.colourOption.createMany({ data: [{ name: 'Rose', hex: '#FF7AA8', position: 0, roleId: 'Rose' }, { name: 'Snow', hex: '#FFFFFF', position: 1, roleId: 'Snow' }] });
    await db.crownTitle.createMany({ data: [{ slot: 'champion', name: 'Champion', roleId: 'Champion' }, { slot: 'advisor', name: 'Advisor', roleId: 'Advisor' }, { slot: 'jester', name: 'Jester', roleId: 'Jester' }] });
    await db.badge.createMany({ data: [{ weeks: 4, name: 'Regular', roleId: 'Regular' }, { weeks: 12, name: 'Veteran', roleId: 'Veteran' }, { weeks: 26, name: 'Legend', roleId: 'Legend' }] });
    const config = new ConfigStore(db, GUILD);
    await config.load();

    expect(await arrangeRoles(guild, db, config.current.guild)).toBeNull();
    const topDown = [...roles.values()].sort((a, b) => b.position - a.position).map((r) => r.id);
    expect(topDown).toEqual(['Bot', 'Rose', 'Snow', 'Crown', 'Champion', 'Advisor', 'Jester', 'VIP', 'Polls', 'Regular', 'Veteran', 'Legend', 'Level 50', 'Mod', '@everyone']);
  });
});
