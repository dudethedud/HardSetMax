import { describe, expect, it } from 'vitest';
import {
  addServerDays,
  completedServerDays,
  isValidBoundaryTime,
  isValidTimezone,
  serverDayAt,
  serverDayByKey,
  type DayBoundary,
} from './serverDay.js';

const edmonton: DayBoundary = { timezone: 'America/Edmonton', time: '00:00' };
const iso = (d: Date) => d.toISOString();
const utc = (s: string) => new Date(s);

describe('serverDayAt with a midnight boundary', () => {
  it('names the day by its local date', () => {
    // 2026-07-15 23:59 MDT (UTC-6) is still the 15th locally.
    const day = serverDayAt(utc('2026-07-16T05:59:00Z'), edmonton);
    expect(day.key).toBe('2026-07-15');
    expect(iso(day.start)).toBe('2026-07-15T06:00:00.000Z');
    expect(iso(day.end)).toBe('2026-07-16T06:00:00.000Z');
  });

  it('starts the next day exactly at the boundary', () => {
    expect(serverDayAt(utc('2026-07-16T06:00:00Z'), edmonton).key).toBe('2026-07-16');
  });

  it('uses the local date, not the UTC date', () => {
    // 2026-01-10 20:00 MST is 03:00 UTC on the 11th.
    expect(serverDayAt(utc('2026-01-11T03:00:00Z'), edmonton).key).toBe('2026-01-10');
  });
});

describe('daylight saving time (America/Edmonton)', () => {
  it('spring-forward day is 23 hours long', () => {
    const day = serverDayByKey('2026-03-08', edmonton);
    expect(iso(day.start)).toBe('2026-03-08T07:00:00.000Z'); // 00:00 MST
    expect(iso(day.end)).toBe('2026-03-09T06:00:00.000Z'); // 00:00 MDT
    expect(day.end.getTime() - day.start.getTime()).toBe(23 * 3600_000);
  });

  it('fall-back day is 25 hours long', () => {
    const day = serverDayByKey('2026-11-01', edmonton);
    expect(iso(day.start)).toBe('2026-11-01T06:00:00.000Z'); // 00:00 MDT
    expect(iso(day.end)).toBe('2026-11-02T07:00:00.000Z'); // 00:00 MST
    expect(day.end.getTime() - day.start.getTime()).toBe(25 * 3600_000);
  });

  it('keeps the boundary at the same local time all year', () => {
    const winter = serverDayByKey('2026-01-15', edmonton);
    const summer = serverDayByKey('2026-07-15', edmonton);
    expect(iso(winter.start)).toBe('2026-01-15T07:00:00.000Z');
    expect(iso(summer.start)).toBe('2026-07-15T06:00:00.000Z');
  });

  it('a boundary inside the spring-forward gap runs at the next valid time', () => {
    const b: DayBoundary = { timezone: 'America/Edmonton', time: '02:30' };
    // 02:00–03:00 doesn't exist on 2026-03-08; the boundary is 03:00 MDT.
    const day = serverDayByKey('2026-03-08', b);
    expect(iso(day.start)).toBe('2026-03-08T09:00:00.000Z');
    // Neighbouring days are normal.
    expect(iso(serverDayByKey('2026-03-07', b).start)).toBe('2026-03-07T09:30:00.000Z');
    expect(iso(day.end)).toBe('2026-03-09T08:30:00.000Z');
    // 02:59 MST (just before the jump) still belongs to the previous day.
    expect(serverDayAt(utc('2026-03-08T08:59:00Z'), b).key).toBe('2026-03-07');
    expect(serverDayAt(utc('2026-03-08T09:00:00Z'), b).key).toBe('2026-03-08');
  });

  it('a boundary inside the repeated fall-back hour uses the first occurrence', () => {
    const b: DayBoundary = { timezone: 'America/Edmonton', time: '01:30' };
    const day = serverDayByKey('2026-11-01', b);
    expect(iso(day.start)).toBe('2026-11-01T07:30:00.000Z'); // 01:30 MDT
    // The second 01:30 (MST) is already inside the new day.
    expect(serverDayAt(utc('2026-11-01T08:30:00Z'), b).key).toBe('2026-11-01');
  });
});

describe('a non-midnight boundary', () => {
  const b: DayBoundary = { timezone: 'America/Edmonton', time: '04:00' };

  it('counts early hours as the previous server-day', () => {
    // 03:59 MDT on the 16th.
    expect(serverDayAt(utc('2026-07-16T09:59:00Z'), b).key).toBe('2026-07-15');
    expect(serverDayAt(utc('2026-07-16T10:00:00Z'), b).key).toBe('2026-07-16');
  });

  it('every instant is in exactly one day, and days are contiguous', () => {
    let day = serverDayByKey('2026-02-25', b);
    for (let i = 0; i < 400; i++) {
      const next = serverDayByKey(addServerDays(day.key, 1), b);
      expect(next.start.getTime()).toBe(day.end.getTime());
      expect(serverDayAt(day.start, b).key).toBe(day.key);
      expect(serverDayAt(new Date(day.end.getTime() - 1), b).key).toBe(day.key);
      day = next;
    }
  });
});

describe('helpers', () => {
  it('addServerDays crosses months and years', () => {
    expect(addServerDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addServerDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('completedServerDays excludes the current day', () => {
    // 2026-10-23 00:05 MDT: the new day has just started.
    const days = completedServerDays(utc('2026-10-23T06:05:00Z'), 7, edmonton);
    expect(days).toEqual([
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
    ]);
  });

  it('validates input', () => {
    expect(isValidTimezone('America/Edmonton')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
    expect(isValidBoundaryTime('00:00')).toBe(true);
    expect(isValidBoundaryTime('23:59')).toBe(true);
    expect(isValidBoundaryTime('24:00')).toBe(false);
    expect(isValidBoundaryTime('9:00')).toBe(false);
    expect(() => serverDayAt(new Date(), { timezone: 'nope', time: '00:00' })).toThrow();
    expect(() => serverDayByKey('2026-13-01', edmonton)).toThrow();
  });
});
