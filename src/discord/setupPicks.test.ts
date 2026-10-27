import { describe, expect, it } from 'vitest';
import type { Guild } from 'discord.js';
import type { AppContext } from './commands/types.js';
import { setupMessages, setupPickRows, SETUP_RERUN_ID } from './setupPicks.js';

type Cfg = AppContext['config']['current']['guild'];
const cfg = (over: Partial<Cfg>) =>
  ({ announceChannelId: null, mainChatChannelId: null, modLogChannelId: null, levelRolesTopId: null, pollsChannelId: null, vipBoardChannelId: null, ...over }) as Cfg;
const guild = (channels: Record<string, { parentId: string | null }>) => ({ channels: { cache: new Map(Object.entries(channels)) } }) as unknown as Guild;
const ids = (rows: ReturnType<typeof setupPickRows>) => rows.map((r) => (r.toJSON().components[0] as { custom_id: string }).custom_id);

describe('setup menus', () => {
  it('offers a menu only for what setup could not fill', () => {
    expect(ids(setupPickRows(guild({}), cfg({})))).toEqual(['setup:pick:announcements', 'setup:pick:main-chat', 'setup:pick:mod-log', 'setup:pick:level-top']);
    const set = cfg({ announceChannelId: 'a', mainChatChannelId: 'b', modLogChannelId: 'c', levelRolesTopId: 'r' });
    expect(setupPickRows(guild({}), set)).toEqual([]);
  });

  it('asks for a category only for a bot channel that is not in one', () => {
    const c = cfg({ announceChannelId: 'a', mainChatChannelId: 'b', modLogChannelId: 'c', levelRolesTopId: 'r', pollsChannelId: 'p', vipBoardChannelId: 'v' });
    expect(ids(setupPickRows(guild({ p: { parentId: null }, v: { parentId: 'cat' } }), c))).toEqual(['setup:pick:polls-category']);
  });

  it('splits the report to fit and adds the menus with a run-again button, 5 rows per message', () => {
    const report = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(60)}`);
    const rows = setupPickRows(guild({}), cfg({}));
    const messages = setupMessages(report, rows);
    const text = messages.filter((m) => m.content && !m.components);
    expect(text.length).toBeGreaterThan(1);
    expect(text.every((m) => m.content!.length <= 2000)).toBe(true);
    const menus = messages.filter((m) => m.components);
    expect(menus.flatMap((m) => m.components!).length).toBe(rows.length + 1);
    expect(menus.every((m) => m.components!.length <= 5)).toBe(true);
    expect(JSON.stringify(menus.at(-1)!.components!.at(-1)!.toJSON())).toContain(SETUP_RERUN_ID);
    expect(setupMessages(['ok'], [])).toEqual([{ content: 'ok' }]);
  });
});
