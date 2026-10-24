import { describe, expect, it } from 'vitest';
import { blockedVipPerks, isLowValueChannel, pickChannel, pickLevelTop } from './autoSetup.js';

describe('isLowValueChannel', () => {
  it('spots bot, command, spam and counting channels', () => {
    for (const n of ['bot-commands', 'bots', '🤖・bot-spam', 'counting', 'cmds', 'spam']) expect(isLowValueChannel(n)).toBe(true);
  });
  it('leaves normal channels alone', () => {
    for (const n of ['general', 'memes', 'robotics', 'accounting-help', 'botany']) expect(isLowValueChannel(n)).toBe(false);
  });
});

describe('pickLevelTop', () => {
  const roles = [
    { id: 'a', name: 'Level 10', position: 3, managed: false },
    { id: 'b', name: 'Level 50', position: 6, managed: false },
    { id: 'c', name: 'Lvl 99', position: 9, managed: false }, // above the bot
    { id: 'd', name: 'Mod', position: 7, managed: false },
    { id: 'e', name: 'Level Bot', position: 5, managed: true },
  ];
  it('takes the highest level role below the bot', () => expect(pickLevelTop(roles, 8)?.id).toBe('b'));
  it('finds nothing when there are no level roles', () => expect(pickLevelTop([roles[3]!], 8)).toBeUndefined());
});

describe('pickChannel', () => {
  const ch = (name: string, isAnnouncement = false) => ({ id: name, name, isAnnouncement });
  const channels = [ch('rules'), ch('💬・general'), ch('server-news'), ch('mod-logs'), ch('updates', true)];
  it('finds general chat, logs and announcements by name, preferring announcement channels', () => {
    expect(pickChannel(channels, 'main-chat')?.id).toBe('💬・general');
    expect(pickChannel(channels, 'mod-log')?.id).toBe('mod-logs');
    expect(pickChannel(channels, 'announcements')?.id).toBe('updates');
    expect(pickChannel([ch('rules')], 'main-chat')).toBeUndefined();
  });
});

describe('blockedVipPerks', () => {
  const view = 1n, send = 2n, attach = 4n, embed = 8n;
  const base = { vipAllow: 0n, vipPerms: attach | embed, viewBit: view, sendBit: send };
  it('returns the VIP perks @everyone is denied in a channel VIPs can use', () => {
    expect(blockedVipPerks({ ...base, everyoneDeny: attach })).toBe(attach);
    expect(blockedVipPerks({ ...base, everyoneDeny: attach | embed, vipAllow: embed })).toBe(attach);
  });
  it('ignores channels @everyone cannot see or post in', () => {
    expect(blockedVipPerks({ ...base, everyoneDeny: view | attach })).toBe(0n);
    expect(blockedVipPerks({ ...base, everyoneDeny: send | attach })).toBe(0n);
  });
});
