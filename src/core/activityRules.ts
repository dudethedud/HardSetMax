// Channel weights and voice minutes (SPEC §2).

export interface ChannelRef {
  id: string;
  /** For threads and forum posts: the channel they're in. */
  parentId: string | null;
  isThread: boolean;
}

export const DEFAULT_CHANNEL_WEIGHT = 1;

/** A channel's weight. Threads always use their parent's; 0 means ignored. */
export function channelWeight(channel: ChannelRef, weights: ReadonlyMap<string, number>): number {
  const id = channel.isThread && channel.parentId ? channel.parentId : channel.id;
  return weights.get(id) ?? DEFAULT_CHANNEL_WEIGHT;
}

export interface VoiceMemberState {
  isBot: boolean;
  channelId: string | null;
  selfDeaf: boolean;
  serverDeaf: boolean;
}

/**
 * Whether this minute counts for the member: in a voice channel with at least one
 * other non-bot member, not in the AFK channel, not self- or server-deafened.
 * (The daily cap is applied separately.)
 */
export function countsVoiceMinute(
  member: VoiceMemberState,
  others: readonly VoiceMemberState[],
  afkChannelId: string | null,
): boolean {
  if (member.isBot || !member.channelId || member.channelId === afkChannelId) return false;
  if (member.selfDeaf || member.serverDeaf) return false;
  return others.some((o) => !o.isBot && o.channelId === member.channelId);
}

/** Minutes that still fit under the daily cap. */
export function minutesUnderCap(alreadyToday: number, adding: number, cap: number): number {
  return Math.max(0, Math.min(adding, cap - alreadyToday));
}
