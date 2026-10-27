import { describe, expect, it } from 'vitest';
import { LOG_COLOURS, logStyle } from './logStyle.js';

describe('logStyle', () => {
  it('colours entries by the emoji they start with', () => {
    expect(logStyle('⚠️ The database is unreachable.')).toEqual({ colour: LOG_COLOURS.warn, title: 'Needs attention' });
    expect(logStyle('🔻 VIP removed from <@1>')).toEqual({ colour: LOG_COLOURS.bad, title: 'Removed' });
    expect(logStyle('✅ The database is back.').colour).toBe(LOG_COLOURS.good);
    expect(logStyle('👑 Crown of the week: <@1>').colour).toBe(LOG_COLOURS.crown);
    expect(logStyle('📣 <@1> posted a VIP shoutout').colour).toBe(LOG_COLOURS.vip);
    expect(logStyle('something else')).toEqual({ colour: LOG_COLOURS.info, title: 'Log' });
  });
});
