// Keys accepted by `/config set`. Later phases add their keys here.
import { isValidBoundaryTime, isValidTimezone } from './serverDay.js';

export interface ConfigValues {
  timezone: string;
  dayBoundary: string;
}

interface KeyDef {
  field: keyof ConfigValues;
  description: string;
  /** Returns an error message, or null if the value is valid. */
  validate: (value: string) => string | null;
}

export const CONFIG_KEYS = {
  timezone: {
    field: 'timezone',
    description: 'IANA timezone for the server-day, e.g. America/Edmonton',
    validate: (v) => (isValidTimezone(v) ? null : `"${v}" is not a known IANA timezone (e.g. America/Edmonton).`),
  },
  'day-boundary': {
    field: 'dayBoundary',
    description: 'Local time a server-day starts, HH:mm (24 h)',
    validate: (v) => (isValidBoundaryTime(v) ? null : `"${v}" is not a valid time. Use HH:mm, e.g. 00:00 or 04:30.`),
  },
} as const satisfies Record<string, KeyDef>;

export type ConfigKey = keyof typeof CONFIG_KEYS;

export type ParsedConfigValue =
  | { ok: true; key: ConfigKey; field: keyof ConfigValues; value: string }
  | { ok: false; error: string };

export function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(CONFIG_KEYS, key);
}

export function parseConfigValue(key: string, raw: string): ParsedConfigValue {
  if (!isConfigKey(key)) return { ok: false, error: `Unknown config key "${key}".` };
  const value = raw.trim();
  const def: KeyDef = CONFIG_KEYS[key];
  const error = def.validate(value);
  return error ? { ok: false, error } : { ok: true, key, field: def.field, value };
}
