import { ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { CROWN_ICON_FIELD, crownRoleModal } from './buttons.js';

describe('Crown role form', () => {
  it('has name, two colours, an emoji and an optional image upload, and passes Discord’s checks', () => {
    const json = crownRoleModal({ name: 'Sunset Club', hex: '#FF8800', hex2: '#9B8CFF', emoji: '🔥', hasImage: true }).toJSON();
    expect(json.components).toHaveLength(5);
    const inner = json.components.map((c) => ('component' in c ? c.component : null));
    expect(inner.map((c) => c && 'custom_id' in c && c.custom_id)).toEqual(['name', 'hex', 'hex2', 'emoji', CROWN_ICON_FIELD]);
    expect(inner[4]).toMatchObject({ type: ComponentType.FileUpload, required: false, max_values: 1 });
    expect(inner[2]).toMatchObject({ value: '#9B8CFF', required: false });
    expect(JSON.stringify(json)).toMatch(/keep your current image/);
  });

  it('builds with nothing filled in', () => {
    expect(() => crownRoleModal(null).toJSON()).not.toThrow();
  });
});
