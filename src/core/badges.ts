// VIP history badges and the weekly recap (SPEC §7, §9). Pure.
import { formatScore } from './reshuffle.js';

export interface StintTime {
  startedAt: Date;
  endedAt: Date | null;
  pinned: boolean;
}

const WEEK_MS = 7 * 86_400_000;

/** Whole weeks of unpinned VIP time across all stints; an open stint counts up to `now`. */
export function unpinnedWeeks(stints: readonly StintTime[], now: Date): number {
  let ms = 0;
  for (const s of stints) {
    if (s.pinned) continue;
    const end = s.endedAt ?? now;
    ms += Math.max(0, end.getTime() - s.startedAt.getTime());
  }
  return Math.floor(ms / WEEK_MS);
}

export interface Milestone {
  id: number;
  weeks: number;
  name: string;
}

/** Milestones reached and not owned yet, smallest first. */
export function newBadges(weeks: number, milestones: readonly Milestone[], owned: ReadonlySet<number>): Milestone[] {
  return milestones.filter((m) => m.weeks <= weeks && !owned.has(m.id)).sort((a, b) => a.weeks - b.weeks);
}

/** Defaults from SPEC §7, added once by /bot setup. */
export const DEFAULT_BADGES = [
  { weeks: 4, name: 'VIP Regular' },
  { weeks: 12, name: 'VIP Veteran' },
  { weeks: 26, name: 'VIP Legend' },
] as const;

export interface EarnedBadge {
  userId: string;
  name: string;
}

export function badgeLines(badges: readonly EarnedBadge[]): string[] {
  return badges.map((b) => `🏅 <@${b.userId}> earned **${b.name}**`);
}

export interface RecapInput {
  /** Server-day keys of the week covered, Monday and Sunday. */
  from: string;
  to: string;
  crown: string | null;
  top: { userId: string; score: number }[];
  longest: { userId: string; days: number } | null;
  swaps: number;
  badges: EarnedBadge[];
  /** Who got the most treats from VIPs this week. */
  treats?: { userId: string; count: number } | null;
}

/** The Monday recap post (SPEC §9). Mentions show names; the caller sends it with no pings. */
export function formatRecap(r: RecapInput): string {
  const medals = ['🥇', '🥈', '🥉'];
  return [
    `📅 **Weekly VIP recap** (${r.from} to ${r.to})`,
    r.crown ? `👑 Crown of the week: <@${r.crown}>` : '👑 No Crown this week',
    r.top.length ? `🏆 Top ${r.top.length}: ${r.top.map((t, i) => `${medals[i]} <@${t.userId}> (${formatScore(t.score)})`).join(' · ')}` : '🏆 No activity this week',
    r.longest ? `⏳ Longest-standing VIP: <@${r.longest.userId}> (${r.longest.days} day${r.longest.days === 1 ? '' : 's'} in a row)` : '',
    `🔄 VIP swaps this week: ${r.swaps}`,
    r.badges.length ? `🏅 Badges earned: ${r.badges.map((b) => `<@${b.userId}> ${b.name}`).join(', ')}` : '',
    r.treats ? `🦴 Most treats: <@${r.treats.userId}> (${r.treats.count})` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
