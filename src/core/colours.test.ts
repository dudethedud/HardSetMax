import { describe, expect, it } from 'vitest';
import { colourRoleError, coloursToStrip, isRepper, rolesAfterPick } from './colours.js';

const set = (...ids: string[]) => new Set(ids);

describe('colour rules', () => {
  it('any one unlock role makes a repper', () => {
    expect(isRepper(set('a', 'tag'), set('tag', 'status'))).toBe(true);
    expect(isRepper(set('a'), set('tag', 'status'))).toBe(false);
    expect(isRepper(set('a'), set())).toBe(false);
  });

  it('picking a colour replaces every other menu colour (one across all menus) and keeps other roles', () => {
    const colours = set('rose', 'gold', 'mocha');
    expect(rolesAfterPick(['member', 'rose', 'mocha', 'level5'], colours, 'gold')).toEqual(['member', 'level5', 'gold']);
    expect(rolesAfterPick(['member', 'rose'], colours, null)).toEqual(['member']);
    expect(rolesAfterPick(['member', 'gold'], colours, 'gold')).toEqual(['member', 'gold']);
  });

  it('losing the last unlock role strips menu colours only', () => {
    const unlock = set('tag', 'status');
    const colours = set('rose', 'gold');
    expect(coloursToStrip(set('member', 'rose'), unlock, colours)).toEqual(['rose']);
    expect(coloursToStrip(set('member', 'rose', 'status'), unlock, colours)).toEqual([]);
    expect(coloursToStrip(set('member', 'level5'), unlock, colours)).toEqual([]);
    // Nothing set up yet: never strip.
    expect(coloursToStrip(set('rose'), set(), colours)).toEqual([]);
  });

  it('only safe, reachable roles can be colours', () => {
    const ok = { id: 'r', everyoneId: 'g', managed: false, belowBot: true, dangerous: false };
    expect(colourRoleError(ok)).toBeNull();
    expect(colourRoleError({ ...ok, id: 'g' })).toMatch(/@everyone/);
    expect(colourRoleError({ ...ok, managed: true })).toMatch(/bot or integration/);
    expect(colourRoleError({ ...ok, dangerous: true })).toMatch(/moderator or admin/);
    expect(colourRoleError({ ...ok, belowBot: false })).toMatch(/above the bot/);
  });
});
