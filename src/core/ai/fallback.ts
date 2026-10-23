// Pre-written replies (SPEC §9a "Fallback"): used when AI chat is off or every
// provider is down or out for the day. The bot never just goes silent.
import { describeStats, type AskerStats } from './prompt.js';

const VIP_SUMMARY =
  'omg hiii :3 ⭐ vip goes to the 10 most active people of the last 7 days and it updates every night at midnight ✨ chat and hang out in voice to climb and stay active to keep your slot and the #1 vip each week gets the 👑 crown and their own role >w<';

export function fallbackReply(question: string, stats: AskerStats): string {
  const q = question.toLowerCase();
  if (/\b(rank|score|stats|points|me|my|standing|position)\b/.test(q)) {
    return `heres where u stand :3 🐶\n${describeStats(stats).split('\n').slice(1).join('\n')}`;
  }
  if (/\b(vip|crown|poll|colou?r|badge|how)\b/.test(q)) return VIP_SUMMARY;
  return 'heyyy :3 my brain is taking a lil nap rn 🐶 but ask me about vip or your stats and ill help ^^';
}

export const BLOCKED_OUTPUT_FALLBACK = 'oopsie lets keep it friendly >w< ask me about vip or your stats 🐶';

export function fallbackWelcome(): string {
  return '🎉 welcome to the vip lounge :3 u get image perms and external emojis and stickers plus ur own vip colour and vip polls and ur own temp voice channel ✨ stay active to keep ur slot >w<';
}
