// Weekly recap (SPEC §9): posted once per week, right after the Crown, in the
// announcements channel. Covers the week that just ended (Monday to Sunday).
import type { Client } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { formatRecap } from '../core/badges.js';
import { compareUserIds } from '../core/scoring.js';
import type { ReshuffleResult } from '../core/reshuffle.js';
import { addServerDays, serverDayByKey, serverDaysBetween, weekStartOf } from '../core/serverDay.js';
import type { Db } from '../db/prisma.js';
import type { TreatService } from './treats.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import { claimJob, completeJob, failJob } from './jobs.js';
import type { ModLog } from './modLog.js';
import { MANUAL_RESHUFFLE_JOB, RESHUFFLE_JOB } from './vipService.js';

export const RECAP_JOB = 'recap';

export class RecapService {
  /** Set when AI chat is enabled (Phase 9): one hype line for the top of the recap. */
  hype: ((summary: string) => Promise<string | null>) | null = null;

  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly treats?: TreatService,
  ) {}

  /** The recap text for the week that ends just before `weekStart`. */
  async build(today: string, result: ReshuffleResult): Promise<string> {
    const weekStart = weekStartOf(today);
    const from = addServerDays(weekStart, -7);
    const to = addServerDays(weekStart, -1);
    const b = this.config.current.boundary;
    const fromAt = serverDayByKey(from, b).start;
    const toAt = serverDayByKey(weekStart, b).start;

    const [crown, runs, badges, vips] = await Promise.all([
      this.db.crownHolder.findUnique({ where: { weekStart } }),
      this.db.jobRun.findMany({ where: { job: { in: [RESHUFFLE_JOB, MANUAL_RESHUFFLE_JOB] }, status: 'succeeded', finishedAt: { gte: fromAt, lt: toAt } } }),
      this.db.userBadge.findMany({ where: { awardedAt: { gte: fromAt, lt: toAt } }, include: { badge: true }, orderBy: { awardedAt: 'asc' } }),
      this.db.vipMember.findMany(),
    ]);
    const swaps = runs.reduce((n, r) => n + ((r.detail as { added?: unknown[] } | null)?.added?.length ?? 0), 0);
    const longest = vips
      .map((v) => ({ userId: v.userId, days: serverDaysBetween(v.since, today) }))
      .sort((a, b2) => b2.days - a.days || compareUserIds(a.userId, b2.userId))[0];

    return formatRecap({
      from,
      to,
      crown: crown?.userId ?? null,
      top: result.ranked.slice(0, 3).map((c) => ({ userId: c.userId, score: c.score })),
      longest: longest ?? null,
      swaps,
      badges: badges.map((x) => ({ userId: x.userId, name: x.badge.name })),
      treats: (await this.treats?.top(fromAt, toAt)) ?? null,
    });
  }

  /** After-reshuffle step (after the Crown): the week's first reshuffle posts the recap. */
  async afterReshuffle(today: string, result: ReshuffleResult): Promise<void> {
    const week = weekStartOf(today);
    const now = this.clock.now();
    if (!(await claimJob(this.db, RECAP_JOB, week, now))) return;
    try {
      const content = await this.build(today, result);
      const channelId = this.config.current.guild.announceChannelId;
      if (!channelId) {
        await this.modLog.post('⚠️ Weekly recap not posted: no announcement channel. Set one with /settings channel.');
      } else {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel?.isSendable()) throw new Error('announcement channel missing or not sendable');
        // Mentions show names, but nobody is pinged (owner-approved).
        const line = this.hype ? await this.hype('The weekly VIP recap: Crown, top members, swaps and badges.').catch(() => null) : null;
        await channel.send({ content: (line ? `${line}\n${content}` : content).slice(0, 2000), allowedMentions: { parse: [] } });
      }
      await this.db.$transaction((tx) => completeJob(tx, RECAP_JOB, week, { posted: !!channelId }, now));
    } catch (err) {
      this.log.warn({ err }, 'weekly recap failed; the next reshuffle this week retries');
      await failJob(this.db, RECAP_JOB, week, err instanceof Error ? err.message : String(err), this.clock.now());
    }
  }
}
