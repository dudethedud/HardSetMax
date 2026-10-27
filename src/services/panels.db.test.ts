// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { Client } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import { createDb, type Db } from '../db/prisma.js';
import { Panels, type PanelDef } from './panels.js';

const url = process.env['TEST_DATABASE_URL'];
const GUILD = '900000000000000001';

describe.skipIf(!url)('panels', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  beforeEach(async () => {
    await db.$transaction([db.panel.deleteMany(), db.guildConfig.deleteMany({ where: { guildId: GUILD } })]);
  });
  afterAll(() => db.$disconnect());

  it('moving the lounge panel to #vip-perks posts it there and deletes the old copy', async () => {
    const messages = new Map<string, Map<string, { edit: () => Promise<void> }>>([
      ['chat', new Map()],
      ['perks', new Map()],
    ]);
    let next = 0;
    const channel = (id: string) => ({
      isSendable: () => true,
      messages: {
        fetch: (mid: string) => Promise.resolve(messages.get(id)!.get(mid) ?? null),
        delete: (mid: string) => (messages.get(id)!.delete(mid), Promise.resolve()),
      },
      send: () => {
        const mid = `m${next++}`;
        messages.get(id)!.set(mid, { edit: () => Promise.resolve() });
        return Promise.resolve({ id: mid });
      },
    });
    const client = { channels: { fetch: (id: string) => Promise.resolve(messages.has(id) ? channel(id) : null) } } as unknown as Client;
    const def: PanelDef = { kind: 'lounge', channelId: (c) => c.loungePerksId ?? c.loungeTextId, render: () => Promise.resolve({ content: 'panel' }) };

    // An older install: the panel lives in the chat channel.
    await db.guildConfig.create({ data: { guildId: GUILD, loungeTextId: 'chat' } });
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const panels = new Panels(client, db, config, pino({ level: 'silent' }), [def]);
    await panels.ensureAll();
    expect(messages.get('chat')!.size).toBe(1);

    // /bot setup creates #vip-perks: the panel moves.
    await db.guildConfig.update({ where: { guildId: GUILD }, data: { loungePerksId: 'perks' } });
    await config.load();
    expect(await panels.ensureAll()).toEqual(['✅ lounge panel posted']);
    expect(messages.get('perks')!.size).toBe(1);
    expect(messages.get('chat')!.size).toBe(0);
    expect(await panels.ensureAll()).toEqual(['✅ lounge panel up to date']);
  });
});
