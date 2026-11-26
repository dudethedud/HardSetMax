// The one way the bot sends check-in DMs (docs/SPEC.md §9). It checks the member's
// opt-out first, and tells closed DMs apart from real errors so callers can skip
// quietly or stop.
import { DiscordAPIError, RESTJSONErrorCodes, type Client, type MessageCreateOptions } from 'discord.js';
import type { Db } from '../db/prisma.js';

/** "Stop these DMs": a fixed custom ID, so the button works after restarts. */
export const CHECKIN_STOP_ID = 'checkins:stop';

export type DmResult =
  | { status: 'sent' }
  | { status: 'opted-out' }
  /** Their DMs are closed (or they block the bot): skip, never retry. */
  | { status: 'closed' }
  /** Anything else (rate limits, Discord errors): the caller should stop for now. */
  | { status: 'failed'; error: unknown };

export async function sendDm(client: Client, db: Db, userId: string, message: MessageCreateOptions): Promise<DmResult> {
  const activity = await db.memberActivity.findUnique({ where: { userId }, select: { checkinOptOut: true } });
  if (activity?.checkinOptOut) return { status: 'opted-out' };
  try {
    await client.users.send(userId, { ...message, allowedMentions: { parse: [] } });
    return { status: 'sent' };
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) return { status: 'closed' };
    return { status: 'failed', error };
  }
}
