// Keys accepted by `/config set`. Later phases add their keys here.
import type { MessageRulesConfig } from './messageRules.js';
import type { ReshuffleConfig } from './reshuffle.js';
import { isValidBoundaryTime, isValidTimezone } from './serverDay.js';
import { formatHexColour, parseHexColour } from './vipRules.js';

export interface ConfigValues {
  timezone: string;
  dayBoundary: string;
  windowDays: number;
  messageCooldownSec: number;
  minMessageLength: number;
  voiceWeight: number;
  voiceDailyCapMinutes: number;
  spamRepeatHistory: number;
  spamRepeatMinutes: number;
  spamRepeatSimilarity: number;
  spamMinDistinctChars: number;
  spamBurstCount: number;
  spamBurstSeconds: number;
  spamBurstMuteMinutes: number;
  vipSlots: number;
  vipBuffer: number;
  vipMinHoldDays: number;
  vipInactivityDays: number;
  vipMinScore: number;
  timeoutBlockDays: number;
  vipColour: string;
  pollsDailyCap: number;
}

type Parsed = { ok: true; value: string | number } | { ok: false; error: string };

interface KeyDef {
  field: keyof ConfigValues;
  description: string;
  parse: (raw: string) => Parsed;
}

const text =
  (check: (v: string) => boolean, error: (v: string) => string) =>
  (v: string): Parsed =>
    check(v) ? { ok: true, value: v } : { ok: false, error: error(v) };

function number(min: number, max: number, { integer = true } = {}) {
  return (raw: string): Parsed => {
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
      return { ok: false, error: `"${raw}" is not ${integer ? 'a whole number' : 'a number'}.` };
    }
    if (value < min || value > max) return { ok: false, error: `Must be between ${min} and ${max}.` };
    return { ok: true, value };
  };
}

export const CONFIG_KEYS = {
  timezone: {
    field: 'timezone',
    description: 'IANA timezone for the server-day, e.g. America/Edmonton',
    parse: text(isValidTimezone, (v) => `"${v}" is not a known IANA timezone (e.g. America/Edmonton).`),
  },
  'day-boundary': {
    field: 'dayBoundary',
    description: 'Local time a server-day starts, HH:mm (24 h)',
    parse: text(isValidBoundaryTime, (v) => `"${v}" is not a valid time. Use HH:mm, e.g. 00:00 or 04:30.`),
  },
  window: { field: 'windowDays', description: 'Score window in days', parse: number(1, 30) },
  'message-cooldown': { field: 'messageCooldownSec', description: 'Seconds between counted messages per person', parse: number(0, 3600) },
  'min-message-length': { field: 'minMessageLength', description: 'Shortest message that counts (characters)', parse: number(1, 100) },
  'voice-weight': { field: 'voiceWeight', description: 'Points per voice minute', parse: number(0, 10, { integer: false }) },
  'voice-daily-cap': { field: 'voiceDailyCapMinutes', description: 'Max counted voice minutes per person per day', parse: number(0, 1440) },
  'spam-repeat-history': { field: 'spamRepeatHistory', description: 'How many recent messages the repeat check compares to', parse: number(1, 20) },
  'spam-repeat-minutes': { field: 'spamRepeatMinutes', description: 'How long recent messages are remembered (minutes)', parse: number(1, 60) },
  'spam-repeat-similarity': {
    field: 'spamRepeatSimilarity',
    description: 'How similar (0.5–1) a message must be to count as a repeat',
    parse: number(0.5, 1, { integer: false }),
  },
  'spam-min-distinct': { field: 'spamMinDistinctChars', description: 'Fewest different letters/digits a message needs', parse: number(1, 10) },
  'spam-burst-count': { field: 'spamBurstCount', description: 'Messages in the burst window that trigger a mute', parse: number(2, 100) },
  'spam-burst-seconds': { field: 'spamBurstSeconds', description: 'Burst window (seconds)', parse: number(5, 600) },
  'spam-burst-mute': { field: 'spamBurstMuteMinutes', description: 'Minutes nothing counts after a burst', parse: number(1, 120) },
  slots: { field: 'vipSlots', description: 'Number of VIP slots', parse: number(1, 50) },
  buffer: { field: 'vipBuffer', description: 'VIPs keep their slot down to rank slots + buffer', parse: number(0, 50) },
  'min-hold': { field: 'vipMinHoldDays', description: 'Days a VIP keeps VIP before rank can remove them', parse: number(0, 60) },
  'inactivity-days': { field: 'vipInactivityDays', description: 'Days with no activity before a VIP is removed', parse: number(1, 30) },
  'min-score': { field: 'vipMinScore', description: 'Lowest score that can get VIP', parse: number(0, 100000, { integer: false }) },
  'timeout-days': { field: 'timeoutBlockDays', description: 'A timeout in the last N days blocks VIP', parse: number(0, 60) },
  'polls-daily-cap': { field: 'pollsDailyCap', description: 'VIP polls allowed per day across the server', parse: number(0, 25) },
  'vip-colour': {
    field: 'vipColour',
    description: 'VIP role colour, e.g. #F1C40F (applied by /setup run)',
    parse: (v) => {
      const n = parseHexColour(v);
      return n === null ? { ok: false, error: `"${v}" is not a hex colour like #F1C40F.` } : { ok: true, value: formatHexColour(n) };
    },
  },
} as const satisfies Record<string, KeyDef>;

export type ConfigKey = keyof typeof CONFIG_KEYS;

export type ParsedConfigValue =
  | { ok: true; key: ConfigKey; field: keyof ConfigValues; value: string | number }
  | { ok: false; error: string };

export function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(CONFIG_KEYS, key);
}

export function parseConfigValue(key: string, raw: string): ParsedConfigValue {
  if (!isConfigKey(key)) return { ok: false, error: `Unknown config key "${key}".` };
  const def: KeyDef = CONFIG_KEYS[key];
  const parsed = def.parse(raw.trim());
  return parsed.ok ? { ok: true, key, field: def.field, value: parsed.value } : parsed;
}

export function messageRulesConfig(c: ConfigValues): MessageRulesConfig {
  return {
    cooldownSec: c.messageCooldownSec,
    minLength: c.minMessageLength,
    repeatHistory: c.spamRepeatHistory,
    repeatMinutes: c.spamRepeatMinutes,
    repeatSimilarity: c.spamRepeatSimilarity,
    minDistinctChars: c.spamMinDistinctChars,
    burstCount: c.spamBurstCount,
    burstSeconds: c.spamBurstSeconds,
    burstMuteMinutes: c.spamBurstMuteMinutes,
  };
}

export function reshuffleConfig(c: ConfigValues): ReshuffleConfig {
  return { slots: c.vipSlots, buffer: c.vipBuffer, minHoldDays: c.vipMinHoldDays, inactivityDays: c.vipInactivityDays, minScore: c.vipMinScore };
}
