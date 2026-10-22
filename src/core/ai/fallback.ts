// Pre-written replies (SPEC §9a "Fallback"): used when AI chat is off or every
// provider is down or out for the day. The bot never just goes silent.
import { describeStats, type AskerStats } from './prompt.js';

const VIP_SUMMARY =
  "⭐ VIP goes to the 10 most active people of the last 7 days, updated every night at midnight! Chat and hang out in voice to climb, stay active to keep your slot, and the #1 VIP each week gets the 👑 Crown and their own role!";

export function fallbackReply(question: string, stats: AskerStats): string {
  const q = question.toLowerCase();
  if (/\b(rank|score|stats|points|me|my|standing|position)\b/.test(q)) {
    return `Here's where you stand! 🐶\n${describeStats(stats).split('\n').slice(1).join('\n')}`;
  }
  if (/\b(vip|crown|poll|colou?r|badge|how)\b/.test(q)) return VIP_SUMMARY;
  return "Heyyy! 🐶 My brain's taking a nap right now, but ask me about VIP or your stats and I'll help!";
}

export const BLOCKED_OUTPUT_FALLBACK = "Oops, let's keep it friendly! 🐶 Ask me about VIP or your stats!";

export function fallbackWelcome(): string {
  return '🎉 Welcome to the VIP Lounge! Enjoy image perms, external emojis and stickers, your own VIP colour, VIP polls and your own temp voice channel. Stay active to keep your slot!';
}
