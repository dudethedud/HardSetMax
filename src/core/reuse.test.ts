import { describe, expect, it } from 'vitest';
import { bindRoleError, pickByName } from './reuse.js';

describe('pickByName', () => {
  const roles = [
    { id: '1', name: 'Moderator' },
    { id: '2', name: '  vip ' },
    { id: '3', name: 'VIP' },
    { id: '4', name: 'Crown' },
  ];
  it('matches ignoring case and spacing, in the order the names are given', () => {
    expect(pickByName(roles, ['VIP'])?.id).toBe('2');
    expect(pickByName(roles, ['👑 Crown', 'Crown'])?.id).toBe('4');
    expect(pickByName(roles, ['Polls'])).toBeUndefined();
    // Works with a one-time iterator (like Collection.values()) and later names.
    expect(pickByName(roles.values(), ['Nope', 'Crown'])?.id).toBe('4');
  });
  it('ignores decorations around the name', () => {
    expect(pickByName([{ id: 'p', name: 'Polls ⸝⸝' }], ['Polls'])?.id).toBe('p');
    expect(pickByName([{ id: 'l', name: '・Level 100 ⸝⸝' }], ['level 100'])?.id).toBe('l');
    expect(pickByName([{ id: 'x', name: 'Pollster' }], ['Polls'])).toBeUndefined();
  });

  it('skips roles it was told to skip', () => {
    expect(pickByName(roles, ['vip'], (r) => r.id === '2')?.id).toBe('3');
  });
});

describe('bindRoleError', () => {
  const opts = { everyoneId: '0', botTopPosition: 10, usedElsewhere: false };
  it('allows a normal role below the bot', () => expect(bindRoleError({ id: '5', managed: false, position: 3 }, opts)).toBeNull());
  it('refuses @everyone, bot roles, roles above the bot and roles in use', () => {
    expect(bindRoleError({ id: '0', managed: false, position: 0 }, opts)).toMatch(/everyone/);
    expect(bindRoleError({ id: '5', managed: true, position: 3 }, opts)).toMatch(/bot or integration/);
    expect(bindRoleError({ id: '5', managed: false, position: 10 }, opts)).toMatch(/above the bot/);
    expect(bindRoleError({ id: '5', managed: false, position: 3 }, { ...opts, usedElsewhere: true })).toMatch(/already used/);
  });
});
