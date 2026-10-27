// The lounge's "My profile" card: a member's own standing, privately.
import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { standingLine } from '../core/perks.js';
import { isVeteran, VETERAN_DAYS } from '../core/vipExtras.js';
import { formatScore } from '../core/reshuffle.js';
import { serverDayAt, serverDaysBetween } from '../core/serverDay.js';
import { loadStandings } from '../db/activityRepo.js';
import type { AppContext } from './commands/types.js';

export async function profileEmbed(ctx: AppContext, userId: string, displayName: string): Promise<EmbedBuilder> {
  await ctx.activity.flush(ctx.db).catch(() => undefined); // show the latest counts if the DB is up
  const now = ctx.clock.now();
  const cfg = ctx.config.current;
  const today = serverDayAt(now, cfg.boundary);
  const { window, ranked } = await loadStandings(ctx.db, cfg, now);
  const index = ranked.findIndex((s) => s.userId === userId);
  const me = ranked[index];
  const vip = ctx.vip.vips.get(userId);

  const [badges, weeks, polls, cur, title, shoutout] = await Promise.all([
    ctx.db.userBadge.findMany({ where: { userId }, include: { badge: true }, orderBy: { awardedAt: 'asc' } }),
    ctx.badges.weeksHeld(userId, now),
    ctx.db.pollPost.count({ where: { userId, serverDay: today.key, accepted: true, kind: { in: ['vip', 'extra'] } } }),
    ctx.crown.current(),
    ctx.db.crownTitle.findFirst({ where: { holderId: userId } }),
    ctx.db.shoutout.findUnique({ where: { userId_serverDay: { userId, serverDay: today.key } } }),
  ]);
  const treats = await ctx.treats.received(userId, new Date(now.getTime() - 7 * 24 * 3600_000));
  const held = vip ? serverDaysBetween(vip.since, today.key) : 0;
  const scores = ranked.map((s) => s.score);

  const embed = new EmbedBuilder()
    .setTitle(`${cur?.userId === userId ? '👑' : vip ? '⭐' : '🪪'} ${escapeMarkdown(displayName)}`)
    .setColor(cur?.userId === userId ? 0xff00c8 : 0xf1c40f)
    .addFields(
      { name: 'Rank', value: me ? `#${index + 1} of ${ranked.length}` : 'unranked', inline: true },
      { name: 'Score', value: formatScore(me?.score ?? 0), inline: true },
      { name: 'Active days', value: `${me?.activeDays ?? 0}/${window.length}`, inline: true },
      { name: 'Standing', value: standingLine(scores, index, !!vip, cfg.reshuffle.slots, cfg.reshuffle.buffer) },
      {
        name: 'VIP',
        value: vip
          ? `Since ${vip.since} (${held} day${held === 1 ? '' : 's'})${vip.pinned ? ' 📌' : ''}${isVeteran(held) ? ' · 💎 Veteran' : ` · 💎 Veteran in ${VETERAN_DAYS - held} day${VETERAN_DAYS - held === 1 ? '' : 's'}`}`
          : 'Not VIP right now',
        inline: true,
      },
      { name: 'Weeks as VIP', value: String(weeks), inline: true },
      { name: 'Badges', value: badges.length ? badges.map((b) => `🏅 ${b.badge.name}`).join('\n') : 'None yet' },
      { name: '🦴 Treats received', value: `${treats.recent} this week · ${treats.total} all time`, inline: true },
    );
  if (vip) {
    embed.addFields(
      { name: 'Polls today', value: `${polls} posted`, inline: true },
      { name: 'Shoutout', value: shoutout ? (isVeteran(held) ? 'First used today (veterans get 2)' : 'Used today') : 'Ready', inline: true },
    );
  }
  if (cur?.userId === userId) embed.addFields({ name: '👑 Crown', value: `Yours for the week of ${cur.weekStart}${cur.decreeAt ? ' · decree used' : ' · decree ready'}` });
  if (title) embed.addFields({ name: '🎖️ Title', value: `${title.name}, appointed by the Crown` });
  embed.setFooter({ text: `Scores cover ${window[0]} to ${window.at(-1)}. Only you can see this.` });
  return embed;
}
