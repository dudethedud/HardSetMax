// What the AI is told (SPEC §9a "What it knows"). Only the asker's own stats.
export interface AskerStats {
  name: string;
  rank: number | null;
  ranked: number;
  score: number;
  activeDays: number;
  windowDays: number;
  pointsToTop10: number | null;
  isVip: boolean;
  vipDays: number | null;
  pinned: boolean;
  pollUsedToday: boolean;
}

export interface PublicInfo {
  vipNames: string[];
  crownName: string | null;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function describeStats(s: AskerStats): string {
  return [
    `Name: ${s.name}`,
    s.rank ? `Rank: #${s.rank} of ${s.ranked} (score ${fmt(s.score)} over the last ${s.windowDays} days)` : `Not ranked yet (score ${fmt(s.score)})`,
    `Active days: ${s.activeDays}/${s.windowDays}`,
    s.pointsToTop10 === null ? 'Already in the top 10' : `Points to reach #10: ${fmt(s.pointsToTop10)}`,
    s.isVip ? `VIP: yes, for ${s.vipDays ?? 0} days${s.pinned ? ' (pinned)' : ''}` : 'VIP: no',
    s.isVip ? `VIP poll used today: ${s.pollUsedToday ? 'yes' : 'no'}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildChatMessages(opts: {
  personality: string;
  guide: string;
  stats: AskerStats;
  info: PublicInfo;
  history: readonly ChatTurn[];
}): ChatMessage[] {
  const system = [
    opts.personality.trim(),
    '',
    '## How the server works',
    opts.guide.trim(),
    '',
    '## Public info',
    `Current VIPs: ${opts.info.vipNames.length ? opts.info.vipNames.join(', ') : 'none'}`,
    `Crown of the week: ${opts.info.crownName ?? 'nobody'}`,
    '',
    `## The person talking to you (their own stats; never share or guess anyone else's)`,
    describeStats(opts.stats),
    '',
    'You cannot change anything: you can’t give VIP, roles, points or polls, or change settings. If asked to, say only admins and the daily reshuffle decide that. Never claim you did something.',
    `Reply in 1–3 short bits, under 400 characters, in the casual style above. Never use @everyone or @here.`,
  ].join('\n');
  return [{ role: 'system', content: system }, ...opts.history];
}

/** One hype line for a post. The post's facts are given, but numbers stay out of the line. */
export function buildHypeMessages(personality: string, kind: 'vip-update' | 'recap', summary: string): ChatMessage[] {
  return [
    { role: 'system', content: `${personality.trim()}\n\nWrite ONE short hype line (max 120 characters) to go at the top of a Discord post. No numbers, no @mentions, no hashtags.` },
    { role: 'user', content: `Post type: ${kind === 'recap' ? 'weekly VIP recap' : 'daily VIP update'}.\n${summary}` },
  ];
}

export function buildWelcomeMessages(personality: string, guide: string, names: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `${personality.trim()}\n\n## How the server works\n${guide.trim()}\n\nWrite a short welcome (max 300 characters) for new VIPs in the VIP lounge, listing a few perks. Don't write their names; they're added separately. No numbers, no @mentions.`,
    },
    { role: 'user', content: `New VIPs: ${names.join(', ')}` },
  ];
}
