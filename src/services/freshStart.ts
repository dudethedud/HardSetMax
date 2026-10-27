// /bot fresh-start (owner-approved): wipes activity and VIP history so the bot
// starts over (e.g. after moving it to another server), and keeps the setup:
// settings, channels, roles, colours, badge definitions, staff roles, blocked
// words, AI setup and moderation (AI blocks, opt-outs) and the audit log.
// Discord is tidied first (Crown and custom roles, titles, temp voice channels);
// then the database rows go in one transaction; reconcile then removes VIP and
// colour roles from anyone who no longer should have them.
import type { Guild } from 'discord.js';
import type { Db } from '../db/prisma.js';

/** What gets deleted, for the confirmation message. */
export const FRESH_START_WIPES = [
  'all activity and points (messages, voice, adjustments)',
  'VIPs, VIP history, pins and blocks',
  'the Crown, custom roles, titles and Crown history',
  'earned badges, colour picks, polls, shoutouts, treats, colour requests',
  'temp voice channels, the Jester status and rainbow speech',
] as const;

export const FRESH_START_KEEPS = 'settings, channels, roles, colours, badge definitions, staff roles, blocked words, AI setup, AI blocks and the audit log';

export interface FreshStartDeps {
  db: Db;
  /** Ends the current Crown the normal way (roles, custom role, titles, nickname). */
  endCrown: () => Promise<void>;
  /** Deletes a custom role from Discord and its saved settings. */
  resetCustomRole: (userId: string) => Promise<unknown>;
  clearTitles: () => Promise<void>;
  /** Forgets activity counted in memory but not saved yet. */
  discardPending: () => void;
  /** Reloads everything kept in memory and makes Discord match the (now empty) database. */
  reload: () => Promise<void>;
}

/** Runs the fresh start. Returns what was deleted, by table. */
export async function freshStart(guild: Guild, deps: FreshStartDeps, actorId: string): Promise<Record<string, number>> {
  const { db } = deps;
  await deps.endCrown();
  for (const c of await db.customRole.findMany({ where: { roleId: { not: null } } })) await deps.resetCustomRole(c.userId);
  await deps.clearTitles();
  for (const t of await db.tempVoiceChannel.findMany()) {
    await guild.channels.cache.get(t.channelId)?.delete('/bot fresh-start').catch(() => undefined);
  }
  deps.discardPending();

  const wipes = {
    activityDays: db.activityDay.deleteMany(),
    adjustments: db.activityAdjustment.deleteMany(),
    voiceSessions: db.voiceSession.deleteMany(),
    timeouts: db.timeoutEvent.deleteMany(),
    names: db.memberName.deleteMany(),
    vips: db.vipMember.deleteMany(),
    vipStints: db.vipStint.deleteMany(),
    vipBlocks: db.vipBlock.deleteMany(),
    colourChoices: db.userColourChoice.deleteMany(),
    pollPosts: db.pollPost.deleteMany(),
    pollLocks: db.pollLock.deleteMany(),
    crowns: db.crownHolder.deleteMany(),
    shoutouts: db.shoutout.deleteMany(),
    customRoles: db.customRole.deleteMany(),
    drafts: db.modalDraft.deleteMany(),
    badgesEarned: db.userBadge.deleteMany(),
    tempVoice: db.tempVoiceChannel.deleteMany(),
    perkUses: db.perkUse.deleteMany(),
    botStatus: db.botStatus.deleteMany(),
    treats: db.treat.deleteMany(),
    treatPosts: db.treatPost.deleteMany(),
    colourRequests: db.colourRequest.deleteMany(),
    speechFilters: db.speechFilter.deleteMany(),
    weeklyBaselines: db.weeklyBaseline.deleteMany(),
  };
  const keys = Object.keys(wipes);
  const results = await db.$transaction([
    ...Object.values(wipes),
    db.crownTitle.updateMany({ data: { holderId: null, appointedAt: null } }),
    db.guildConfig.update({ where: { guildId: guild.id }, data: { weeklyFrom: null } }),
  ]);
  const counts = Object.fromEntries(keys.map((k, i) => [k, (results[i] as { count: number }).count]));
  await db.auditLog.create({ data: { action: 'bot.fresh-start', actorId, data: counts } });
  await deps.reload();
  return counts;
}
