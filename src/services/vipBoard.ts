// The public VIP board (#vip-board): who holds the Crown and its titles, every
// VIP with days held and their top badge, the most active members, and when the
// next reshuffle is. A panel, so it's re-posted if deleted and edited in place
// after VIP and Crown changes (and hourly, to keep the numbers fresh).
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { TITLE_SLOTS } from '../core/perks.js';
import { isVeteran } from '../core/vipExtras.js';
import type { ConfigStore } from '../config/configStore.js';
import { formatScore } from '../core/reshuffle.js';
import { serverDayAt, serverDaysBetween } from '../core/serverDay.js';
import { loadStandings } from '../db/activityRepo.js';
import type { Db } from '../db/prisma.js';
import type { Clock } from './clock.js';
import type { CrownService } from './crown.js';
import type { PanelDef } from './panels.js';
import type { VipService } from './vipService.js';

export const VIP_BOARD = 'vip-board';
/** "What titles do" button on the board: anyone can press it; title holders get their buttons. */
export const TITLE_PERKS_ID = 'title:perks';
const MEDALS = ['🥇', '🥈', '🥉'];

export function vipBoardPanel(deps: { db: Db; config: ConfigStore; vip: VipService; crown: CrownService; clock: Clock }): PanelDef {
  const { db, config, vip, crown, clock } = deps;
  return {
    kind: VIP_BOARD,
    channelId: (c) => c.vipBoardChannelId,
    render: async () => {
      const now = clock.now();
      const cfg = config.current;
      const today = serverDayAt(now, cfg.boundary);
      const { ranked } = await loadStandings(db, cfg, now);
      const rankOf = new Map(ranked.map((s, i) => [s.userId, i + 1]));
      const [cur, titles, earned] = await Promise.all([
        crown.current(),
        db.crownTitle.findMany({ where: { holderId: { not: null } } }),
        db.userBadge.findMany({ where: { userId: { in: [...vip.vips.keys()] } }, include: { badge: true } }),
      ]);
      const topBadge = new Map<string, { weeks: number; name: string }>();
      for (const e of earned) if ((topBadge.get(e.userId)?.weeks ?? 0) < e.badge.weeks) topBadge.set(e.userId, e.badge);

      const vips = [...vip.vips].sort(([a], [b]) => (rankOf.get(a) ?? Infinity) - (rankOf.get(b) ?? Infinity));
      const vipLines = vips.map(([id, v]) => {
        const days = serverDaysBetween(v.since, today.key);
        const badge = topBadge.get(id);
        return `${id === cur?.userId ? '👑' : '⭐'} <@${id}> · ${days} day${days === 1 ? '' : 's'}${isVeteran(days) ? ' · 💎 Veteran' : ''}${badge ? ` · 🏅 ${badge.name}` : ''}${v.pinned ? ' · 📌' : ''}`;
      });
      const order = ['champion', 'advisor', 'jester'];
      const titleLines = titles
        .sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot))
        .map((t) => `${t.name}: <@${t.holderId}> · ${TITLE_SLOTS.find((s) => s.slot === t.slot)?.job ?? ''}`);
      const top = ranked.slice(0, 3).map((s, i) => `${MEDALS[i]} <@${s.userId}> · ${formatScore(s.score)} pts`);

      const embed = new EmbedBuilder()
        .setTitle('⭐ VIP Board')
        .setColor(0xf1c40f)
        .setDescription(
          `VIP goes to the ${cfg.reshuffle.slots} most active members of the last ${cfg.guild.windowDays} days. Next reshuffle <t:${Math.floor(today.end.getTime() / 1000)}:R>.`,
        )
        .addFields(
          { name: '👑 Crown of the week', value: cur ? `<@${cur.userId}> (since ${cur.weekStart})` : 'Nobody yet' },
          ...(titleLines.length ? [{ name: '🎖️ Appointed by the Crown', value: titleLines.join('\n') }] : []),
          { name: `VIPs (${vips.length}/${cfg.reshuffle.slots})`, value: vipLines.join('\n').slice(0, 1024) || 'No VIPs right now.' },
          { name: '🔥 Most active', value: top.join('\n') || 'No activity yet.' },
        )
        .setFooter({ text: 'Updated' })
        .setTimestamp(now);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(TITLE_PERKS_ID).setLabel('Titles & perks').setEmoji('🎖️').setStyle(ButtonStyle.Secondary),
      );
      return { embeds: [embed], components: [row] };
    },
  };
}
