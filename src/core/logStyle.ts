// How a mod-log entry looks, from the emoji it starts with. Pure.

export const LOG_COLOURS = {
  good: 0x2ecc71,
  bad: 0xe74c3c,
  warn: 0xf39c12,
  crown: 0xff00c8,
  vip: 0xf1c40f,
  info: 0x5865f2,
} as const;

const RULES: [RegExp, keyof typeof LOG_COLOURS, string][] = [
  [/^(⚠️|❌)/u, 'warn', 'Needs attention'],
  [/^(🔻|⛔|🗑️|🙊)/u, 'bad', 'Removed'],
  [/^(✅|🔧)/u, 'good', 'Done'],
  [/^(👑|📜|🎖️)/u, 'crown', 'Crown'],
  [/^(⭐|📌|📍|🏅|🎨|📣)/u, 'vip', 'VIP'],
];

/** The embed colour and a short title for a mod-log line. */
export function logStyle(text: string): { colour: number; title: string } {
  const t = text.trimStart();
  for (const [re, kind, title] of RULES) if (re.test(t)) return { colour: LOG_COLOURS[kind], title };
  return { colour: LOG_COLOURS.info, title: 'Log' };
}
