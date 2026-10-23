import { describe, expect, it } from 'vitest';
import { moveNextTo, positionChanges } from './roleOrder.js';

// Bottom to top: @everyone, badge, level1, level2 (bleed's top), VIP, bot.
const order = ['everyone', 'badge', 'level1', 'level2', 'vip', 'bot'];

describe('moveNextTo', () => {
  it('moves a role up to directly above another', () => {
    expect(moveNextTo(order, 'badge', 'level2', 'above')).toEqual(['everyone', 'level1', 'level2', 'badge', 'vip', 'bot']);
  });

  it('moves a role down to directly above another', () => {
    expect(moveNextTo(order, 'vip', 'badge', 'above')).toEqual(['everyone', 'badge', 'vip', 'level1', 'level2', 'bot']);
  });

  it('fits a role between the top level role and the bot, even with no gap', () => {
    const tight = ['everyone', 'vip', 'level', 'bot'];
    expect(moveNextTo(tight, 'vip', 'level', 'above')).toEqual(['everyone', 'level', 'vip', 'bot']);
  });

  it('moves below', () => {
    expect(moveNextTo(order, 'badge', 'bot', 'below')).toEqual(['everyone', 'level1', 'level2', 'vip', 'badge', 'bot']);
  });

  it('leaves the order alone for unknown roles or a role next to itself', () => {
    expect(moveNextTo(order, 'nope', 'vip', 'above')).toEqual(order);
    expect(moveNextTo(order, 'vip', 'vip', 'above')).toEqual(order);
  });
});

describe('positionChanges', () => {
  it('only sends the roles that moved, using the raw positions of their new slots', () => {
    const raw = new Map([
      ['everyone', 0],
      ['badge', 1],
      ['level1', 5],
      ['level2', 6],
      ['vip', 9],
      ['bot', 12],
    ]);
    const after = moveNextTo(order, 'badge', 'level2', 'above');
    expect(positionChanges(order, after, raw)).toEqual([
      { id: 'level1', position: 1 },
      { id: 'level2', position: 5 },
      { id: 'badge', position: 6 },
    ]);
    expect(positionChanges(order, order, raw)).toEqual([]);
  });
});
