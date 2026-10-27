import { describe, expect, it } from 'vitest';
import { cleanPublicText, crownNickname, crownRoomName, isTitleSlot, JESTER_TRICKS, pickTrick, standingLine, TITLE_SLOTS, titlePerks, titleTargetError } from './perks.js';

describe('crownNickname', () => {
  it('adds the crown and fits 32 characters', () => {
    expect(crownNickname('Alex')).toBe('👑 Alex');
    const long = crownNickname('A'.repeat(40));
    expect([...long].length).toBe(32);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('crownRoomName', () => {
  it('names the hall', () => {
    expect(crownRoomName('  Sam  ')).toBe("👑 Sam's Hall");
    expect(crownRoomName('')).toBe("👑 Crown's Hall");
    expect([...crownRoomName('B'.repeat(50))].length).toBeLessThanOrEqual(34);
  });
});

describe('cleanPublicText', () => {
  it('removes mentions and breaks up @everyone', () => {
    const r = cleanPublicText('hi <@123> and <@&456> in <#789> @everyone @Here', [], 200);
    expect(r.ok && r.text).toBe('hi and in @​everyone @​Here');
  });

  it('rejects empty, too long and blocked text', () => {
    expect(cleanPublicText('  <@1> ', [], 200)).toEqual({ ok: false, error: 'Write something first.' });
    expect(cleanPublicText('x'.repeat(201), [], 200).ok).toBe(false);
    expect(cleanPublicText('you are a b4dword!', ['badword'], 200).ok).toBe(false);
    expect(cleanPublicText('bad word apart', ['badword'], 200).ok).toBe(true);
  });

  it('keeps line breaks but squeezes blank runs', () => {
    expect(cleanPublicText('a\n\n\n\nb', [], 200)).toEqual({ ok: true, text: 'a\n\nb' });
  });
});

describe('titleTargetError', () => {
  const ok = { targetId: '2', crownId: '1', isBot: false, isStaff: false, inServer: true };
  it('allows regular members', () => expect(titleTargetError(ok)).toBeNull());
  it('blocks bots, self, staff and leavers', () => {
    expect(titleTargetError({ ...ok, isBot: true })).toMatch(/Bots/);
    expect(titleTargetError({ ...ok, targetId: '1' })).toMatch(/yourself/);
    expect(titleTargetError({ ...ok, isStaff: true })).toMatch(/Staff/);
    expect(titleTargetError({ ...ok, inServer: false })).toMatch(/not in the server/);
  });
});

describe('isTitleSlot', () => {
  it('knows the three slots', () => {
    expect(['champion', 'advisor', 'jester'].every(isTitleSlot)).toBe(true);
    expect(isTitleSlot('king')).toBe(false);
  });
});

describe('standingLine', () => {
  // 15 ranked members, scores 150, 140, …, 10.
  const scores = Array.from({ length: 15 }, (_, i) => 150 - i * 10);
  it('VIPs: margin over the first rank past the buffer', () => {
    expect(standingLine(scores, 0, true, 10, 3)).toBe('🟢 130 points ahead of rank #14.');
    expect(standingLine(scores, 13, true, 10, 3)).toMatch(/Below rank #13/);
    expect(standingLine(scores, -1, true, 10, 3)).toMatch(/Below rank #13/);
  });
  it('others: points to the last VIP slot', () => {
    expect(standingLine(scores, 11, false, 10, 3)).toBe('⬆️ 20 points to reach rank #10.');
    expect(standingLine(scores, -1, false, 10, 3)).toBe('⬆️ 60 points to reach rank #10.');
    expect(standingLine(scores, 4, false, 10, 3)).toMatch(/top 10/);
    expect(standingLine([5], -1, false, 10, 3)).toMatch(/Fewer than 10/);
  });
});

describe('title jobs', () => {
  it('the Champion is a guest VIP, the Advisor polls and shouts out, the Jester has his own buttons', () => {
    expect([...titlePerks('champion')].sort()).toEqual(['colour', 'lounge', 'poll', 'shoutout', 'voice']);
    expect([...titlePerks('advisor')].sort()).toEqual(['poll', 'shoutout']);
    expect(titlePerks('jester').size).toBe(0);
    expect(TITLE_SLOTS.every((t) => t.job.length > 0)).toBe(true);
  });

  it('tricks are picked from the fixed list, for any random number', () => {
    expect(pickTrick(0)).toBe(JESTER_TRICKS[0]);
    expect(pickTrick(0.9999)).toBe(JESTER_TRICKS.at(-1));
    expect(pickTrick(1)).toBe(JESTER_TRICKS.at(-1));
  });
});
