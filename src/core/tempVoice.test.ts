import { describe, expect, it } from 'vitest';
import { canRename, checkRoomName, defaultRoomName, parseUserLimit, roomAction } from './tempVoice.js';

const t0 = new Date('2026-10-26T12:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);

describe('roomAction', () => {
  it('keeps a room with people in it and clears the empty timer', () => {
    expect(roomAction({ humans: 2, emptySince: t0, ownerIsVip: true }, at(120))).toEqual({ delete: false, emptySince: null });
  });

  it('deletes after 60 s empty, not before', () => {
    expect(roomAction({ humans: 0, emptySince: null, ownerIsVip: true }, t0)).toEqual({ delete: false, emptySince: t0 });
    expect(roomAction({ humans: 0, emptySince: t0, ownerIsVip: true }, at(59)).delete).toBe(false);
    expect(roomAction({ humans: 0, emptySince: t0, ownerIsVip: true }, at(60)).delete).toBe(true);
  });

  it('deletes as soon as it is empty when the owner lost VIP', () => {
    expect(roomAction({ humans: 0, emptySince: null, ownerIsVip: false }, t0).delete).toBe(true);
    expect(roomAction({ humans: 1, emptySince: null, ownerIsVip: false }, t0).delete).toBe(false);
  });
});

describe('names and limits', () => {
  it('default name uses the owner and fits', () => {
    expect(defaultRoomName('Sam')).toBe("Sam's room");
    expect([...defaultRoomName('x'.repeat(50))].length).toBeLessThanOrEqual(32);
    expect(defaultRoomName('  ')).toBe("VIP's room");
  });

  it('renames are 1–32 characters and avoid blocked words', () => {
    expect(checkRoomName('  Chill   zone ', [])).toEqual({ ok: true, name: 'Chill zone' });
    expect(checkRoomName('', []).ok).toBe(false);
    expect(checkRoomName('x'.repeat(33), []).ok).toBe(false);
    expect(checkRoomName('the B@dw0rd room', ['badword']).ok).toBe(false);
  });

  it('user limit is 0–99', () => {
    expect(parseUserLimit('0')).toBe(0);
    expect(parseUserLimit(' 99 ')).toBe(99);
    expect(parseUserLimit('100')).toBeNull();
    expect(parseUserLimit('-1')).toBeNull();
    expect(parseUserLimit('five')).toBeNull();
  });

  it('allows 2 renames per 10 minutes', () => {
    const now = 1_000_000_000;
    expect(canRename([], now)).toBe(true);
    expect(canRename([now - 1000], now)).toBe(true);
    expect(canRename([now - 1000, now - 2000], now)).toBe(false);
    expect(canRename([now - 11 * 60_000, now - 2000], now)).toBe(true);
  });
});
