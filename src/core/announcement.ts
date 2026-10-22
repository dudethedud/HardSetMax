// Text of the public "VIP update" post (SPEC §4 "Announcement"). New VIPs are
// mentioned (and pinged); everyone else appears by display name only. The caller
// must send it with allowed_mentions set to exactly `pingUserIds`.
import type { AnnouncementLine } from './reshuffle.js';

export interface Announcement {
  content: string;
  pingUserIds: string[];
}

/** Escapes Discord markdown so a display name shows as plain text. */
export function plainName(name: string): string {
  return name.replace(/[\\*_~`|>[\]()#-]/g, '\\$&').replace(/@/g, '@\u200b');
}

/** Null when nothing changed: no post at all. */
export function formatVipUpdate(lines: readonly AnnouncementLine[], names: ReadonlyMap<string, string>): Announcement | null {
  if (lines.length === 0) return null;
  const name = (id: string) => plainName(names.get(id) ?? 'a former member');
  const ping = (id: string) => `<@${id}>`;
  const text = lines.map((l) => {
    if (l.kind === 'replaced') return `${ping(l.added)} → replaced ${name(l.removed)}`;
    if (l.kind === 'filled') return `${ping(l.added)} → filled an open slot`;
    return `${name(l.removed)} left VIP`;
  });
  const pingUserIds = lines.flatMap((l) => (l.kind === 'left' ? [] : [l.added]));
  return { content: ['⭐ **VIP update**', ...text].join('\n'), pingUserIds };
}
