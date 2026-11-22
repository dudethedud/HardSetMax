// Christmas invite event (docs/SPEC.md §8). Works out which invite each new member
// used, re-checks every invite's validity each hour, flags likely alts to staff,
// posts the weekly leaderboard, freezes at the end and exports the raffle.
// Members are never DMed. Rules live in core/inviteEvent.ts.
import { EmbedBuilder, GuildFeature, PermissionFlagsBits, type Client, type Guild, type GuildMember, type Invite } from 'discord.js';
import {
  diffInvites,
  daysLeft,
  evaluateJoin,
  flagsForJoin,
  isStatus,
  joinCutoff,
  leaderboardLines,
  leaveRateFlag,
  raffleCsv,
  rankInviters,
  lastSundayPost,
  STAY_DAYS,
  type Flag,
  type InviteStatus,
} from '../core/inviteEvent.js';
import type { Db } from '../db/prisma.js';
import type { InviteEventState, InviteJoin } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** A Sunday post missed while the bot was offline is still made if it's under this late. */
const WEEKLY_GRACE_MS = 12 * HOUR;

export interface InviteEventConfig {
  end: Date;
  leaderboardChannelId: string;
  level3RoleId: string;
  /** Alt flags and staff changes; null = the /colours log channel. */
  staffLogChannelId: string | null;
  /** Where /invite-link makes personal invites; null = the leaderboard channel. */
  inviteLinkChannelId: string | null;
  color: number;
}

interface CachedInvite {
  uses: number;
  inviterId: string | null;
}
type UsesSnapshot = { invites: Map<string, CachedInvite>; vanity: number | null } | null;

export class InviteEventService {
  /** code → uses when we last looked. */
  #invites = new Map<string, CachedInvite>();
  #vanityUses: number | null = null;
  /** Off when the bot can't read invites (no Manage Server). */
  #enabled = false;
  #disabledReason: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #lastPermCheck = 0;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly log: Logger,
    readonly config: InviteEventConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get enabled(): boolean {
    return this.#enabled;
  }

  #guild(): Guild | undefined {
    return this.client.guilds.cache.get(this.guildId);
  }

  /** Runs one job at a time, in order (joins, leaves, invite changes, the hourly check). */
  #serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(job);
    this.#queue = run.catch((err: unknown) => this.log.error({ err }, 'invite event job failed'));
    return run;
  }

  async state(): Promise<InviteEventState> {
    // The event starts the first time the bot runs with it configured.
    return this.db.inviteEventState.upsert({ where: { guildId: this.guildId }, create: { guildId: this.guildId, startAt: this.now() }, update: {} });
  }

  // ---- Start-up and permissions ----

  /** On ready: save who's already here (rule 4), check permissions and cache invite uses. */
  start(guild: Guild): Promise<void> {
    return this.#serial(async () => {
      const state = await this.state();
      if (!state.snapshotDone) {
        const members = await guild.members.fetch();
        const at = this.now();
        await this.db.knownMember.createMany({ data: [...members.keys()].map((userId) => ({ userId, firstSeenAt: at, source: 'snapshot' })), skipDuplicates: true });
        await this.db.inviteEventState.update({ where: { guildId: this.guildId }, data: { snapshotDone: true } });
        this.log.info({ members: members.size }, 'invite event: saved the current members');
      }
      await this.#checkPermissions(guild, true);
    });
  }

  /** Invite tracking needs Manage Server (to read invite uses). Without it, the event is off, loudly. */
  async #checkPermissions(guild: Guild, force = false): Promise<void> {
    if (!force && this.now().getTime() - this.#lastPermCheck < HOUR) return;
    this.#lastPermCheck = this.now().getTime();
    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const ok = !!me?.permissions.has(PermissionFlagsBits.ManageGuild);
    if (ok) {
      try {
        await this.#refreshCache(guild);
      } catch (err) {
        return this.#disable(`couldn't read the server's invites (${err instanceof Error ? err.message : String(err)})`);
      }
      if (!this.#enabled) {
        this.#enabled = true;
        if (this.#disabledReason) await this.#staffLog(new EmbedBuilder().setColor(0x57f287).setTitle('🎄 Invite tracking is back on').setDescription('The bot can read invites again. Joins while it was off were counted as unknown.'));
        this.#disabledReason = null;
        this.log.info({ invites: this.#invites.size }, 'invite event: tracking invites');
      }
      return;
    }
    await this.#disable('the bot is missing the **Manage Server** permission, which Discord needs to show invite uses');
  }

  async #disable(reason: string): Promise<void> {
    if (this.#disabledReason === reason) return;
    this.#enabled = false;
    this.#disabledReason = reason;
    this.log.error({ reason }, 'invite event: invite tracking is OFF');
    await this.#staffLog(
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('⚠️ Invite tracking is OFF')
        .setDescription(`New joins can't be credited to anyone: ${reason}.\nGive the bot's role Manage Server; it checks again every hour. Colours and donations keep working.`),
    );
  }

  async #refreshCache(guild: Guild): Promise<void> {
    const invites = await guild.invites.fetch({ cache: false });
    this.#invites = new Map(invites.map((i) => [i.code, { uses: i.uses ?? 0, inviterId: i.inviterId ?? null }]));
    this.#vanityUses = guild.vanityURLCode ? await guild.fetchVanityData().then((v) => v.uses, () => null) : null;
  }

  // ---- Invite events ----

  onInviteCreate(invite: Invite): void {
    if (invite.guild?.id !== this.guildId) return;
    void this.#serial(() => {
      this.#invites.set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviterId ?? null });
      return Promise.resolve();
    });
  }

  onInviteDelete(invite: Invite): void {
    if (invite.guild?.id !== this.guildId) return;
    void this.#serial(async () => {
      this.#invites.delete(invite.code);
      // A personal link someone deleted: /invite-link makes a new one.
      await this.db.personalInvite.deleteMany({ where: { code: invite.code } });
    });
  }

  /** A member joined: which invite was it, and save it for the event. */
  onMemberAdd(member: GuildMember): Promise<void> {
    if (member.guild.id !== this.guildId) return Promise.resolve();
    // Read the counts right away, before later joins change them.
    const after = this.#enabled ? this.#readUses(member.guild) : Promise.resolve(null);
    return this.#serial(() => this.#recordJoin(member, after));
  }

  async #readUses(guild: Guild): Promise<UsesSnapshot> {
    try {
      const invites = await guild.invites.fetch({ cache: false });
      const vanity = guild.vanityURLCode ? await guild.fetchVanityData().then((v) => v.uses, () => null) : null;
      return { invites: new Map(invites.map((i) => [i.code, { uses: i.uses ?? 0, inviterId: i.inviterId ?? null }])), vanity };
    } catch (err) {
      this.log.warn({ err }, "invite event: couldn't read invites for a join");
      return null;
    }
  }

  async #recordJoin(member: GuildMember, read: Promise<UsesSnapshot>): Promise<void> {
    const now = this.now();
    const after = await read;
    let source = 'unknown';
    let inviterId: string | null = null;
    let inviteCode: string | null = null;
    if (after) {
      const use = diffInvites(
        new Map([...this.#invites].map(([c, i]) => [c, i.uses])),
        new Map([...after.invites].map(([c, i]) => [c, i.uses])),
        { before: this.#vanityUses, after: after.vanity },
      );
      this.#invites = after.invites;
      this.#vanityUses = after.vanity;
      if (use.kind === 'code') {
        inviteCode = use.code;
        const personal = await this.db.personalInvite.findUnique({ where: { code: use.code } });
        source = personal ? 'personal' : 'invite';
        inviterId = personal?.userId ?? after.invites.get(use.code)?.inviterId ?? null;
      } else if (use.kind === 'vanity') {
        source = 'vanity';
      } else if (use.kind === 'none' && member.guild.features.includes(GuildFeature.Discoverable)) {
        source = 'discovery';
      }
    }

    const known = await this.db.knownMember.findUnique({ where: { userId: member.id } });
    if (!known) await this.db.knownMember.create({ data: { userId: member.id, firstSeenAt: now, source: 'join' } });
    const state = await this.state();
    // After the end (or a freeze) new joins aren't part of the event.
    if (now > joinCutoff(this.config.end, state.frozenAt)) return;
    // One row per person: someone who comes back keeps their first row.
    if (await this.db.inviteJoin.findUnique({ where: { inviteeId: member.id } })) return;

    const join = await this.db.inviteJoin.create({
      data: {
        inviteeId: member.id,
        inviteeName: member.user.username,
        inviterId,
        inviteCode,
        source,
        joinedAt: now,
        accountCreatedAt: member.user.createdAt,
        defaultAvatar: member.user.avatar === null,
        isBot: member.user.bot,
        rejoin: !!known,
      },
    });
    const disqualified = inviterId ? !!(await this.db.disqualifiedInviter.findUnique({ where: { userId: inviterId } })) : false;
    await this.#apply(join, state, member.roles.cache.has(this.config.level3RoleId), disqualified, now);
    this.log.info({ invitee: member.id, inviter: inviterId, source }, 'invite event: join');

    if (inviterId && source !== 'vanity') {
      const inviter = await this.client.users.fetch(inviterId).catch(() => null);
      const joins = await this.db.inviteJoin.findMany({ where: { inviterId } });
      await this.#postFlags(inviterId, flagsForJoin({ id: inviterId, name: inviter?.username ?? '' }, joins, join, now));
    }
  }

  /** A member left: their invite stops counting (if before the 7 days or the end). */
  onMemberRemove(userId: string, guildId: string): Promise<void> {
    if (guildId !== this.guildId) return Promise.resolve();
    return this.#serial(async () => {
      const join = await this.db.inviteJoin.findUnique({ where: { inviteeId: userId } });
      if (!join || join.leftAt) return;
      const updated = await this.db.inviteJoin.update({ where: { id: join.id }, data: { leftAt: this.now() } });
      const state = await this.state();
      if (!state.finalPostedAt) await this.#apply(updated, state, null, await this.#isDisqualified(join.inviterId), this.now());
      if (join.inviterId) await this.#postFlags(join.inviterId, leaveRateFlag(join.inviterId, await this.db.inviteJoin.findMany({ where: { inviterId: join.inviterId } })));
    });
  }

  async #isDisqualified(inviterId: string | null): Promise<boolean> {
    return inviterId ? !!(await this.db.disqualifiedInviter.findUnique({ where: { userId: inviterId } })) : false;
  }

  /** Works out a join's status now and saves it if it changed. */
  async #apply(join: InviteJoin, state: InviteEventState, hasLevel3: boolean | null, disqualified: boolean, now: Date): Promise<InviteJoin> {
    const result = evaluateJoin(join, { now, eventStart: state.startAt, eventEnd: this.config.end, frozenAt: state.frozenAt, hasLevel3, inviterDisqualified: disqualified });
    if (result.status === join.status && result.reason === join.invalidReason && result.validatedAt?.getTime() === join.validatedAt?.getTime()) return join;
    return this.db.inviteJoin.update({ where: { id: join.id }, data: { status: result.status, invalidReason: result.reason, validatedAt: result.validatedAt } });
  }

  /** New flags (by key) go to staff once. */
  async #postFlags(inviterId: string, flags: Flag[]): Promise<void> {
    for (const flag of flags) {
      const created = await this.db.inviteFlag.createMany({ data: [{ key: flag.key, inviterId, reason: flag.reason, inviteeIds: flag.inviteeIds }], skipDuplicates: true });
      if (created.count === 0) continue;
      const who = flag.inviteeIds.slice(0, 15).map((id) => `<@${id}>`).join(' ');
      await this.#staffLog(
        new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('🚩 Possible alt invites')
          .setDescription(`**Inviter:** <@${inviterId}>\n**Why:** ${flag.reason}\n**Invitees:** ${who}${flag.inviteeIds.length > 15 ? ` and ${flag.inviteeIds.length - 15} more` : ''}\n\nCheck with \`/invite-event review\`. Nothing was changed automatically.`)
          .setTimestamp(this.now()),
      );
    }
  }

  // ---- The hourly check and scheduled posts ----

  /** Re-checks every invite (rules 2 and 3, leaving). Stops once the final results are posted. */
  evaluateAll(guild: Guild): Promise<number> {
    return this.#serial(() => this.#evaluateAll(guild));
  }

  async #evaluateAll(guild: Guild): Promise<number> {
    const state = await this.state();
    if (state.finalPostedAt) return 0;
    const now = this.now();
    const joins = await this.db.inviteJoin.findMany();
    const members = await guild.members.fetch();
    const disqualified = new Set((await this.db.disqualifiedInviter.findMany()).map((d) => d.userId));
    let changed = 0;
    for (let join of joins) {
      const member = members.get(join.inviteeId);
      // Left while the bot was offline.
      if (!member && !join.leftAt) join = await this.db.inviteJoin.update({ where: { id: join.id }, data: { leftAt: now } });
      const after = await this.#apply(join, state, member ? member.roles.cache.has(this.config.level3RoleId) : null, !!join.inviterId && disqualified.has(join.inviterId), now);
      if (after !== join) changed++;
    }
    await this.db.inviteEventState.update({ where: { guildId: this.guildId }, data: { lastEvaluatedAt: now } });
    return changed;
  }

  /** Called every few minutes: each step is due-or-not and safe to repeat. */
  tick(guild: Guild): Promise<void> {
    return this.#serial(async () => {
      await this.#checkPermissions(guild);
      let state = await this.state();
      const now = this.now();
      if (state.finalPostedAt) return;
      if (!state.lastEvaluatedAt || now.getTime() - state.lastEvaluatedAt.getTime() >= HOUR) {
        await this.#evaluateAll(guild);
        state = await this.state();
      }
      // Auto-freeze at the end.
      if (!state.frozenAt && now >= this.config.end) {
        state = await this.db.inviteEventState.update({ where: { guildId: this.guildId }, data: { frozenAt: this.config.end } });
      }
      const cutoff = joinCutoff(this.config.end, state.frozenAt);
      if (state.frozenAt && !state.frozenPostedAt) {
        await this.#post(await this.#leaderboard('🎄 invite leaderboard · event over', 10, `the event is over · final results after ${this.#settleDay(cutoff)}, once the last invites finish their ${STAY_DAYS} days ♡`));
        state = await this.db.inviteEventState.update({ where: { guildId: this.guildId }, data: { frozenPostedAt: now } });
      }
      // Everything is settled once the last joins have had their 7 days (and been checked since).
      if (state.frozenAt && now.getTime() >= cutoff.getTime() + STAY_DAYS * DAY + HOUR) {
        await this.#evaluateAll(guild);
        await this.#post(await this.#leaderboard('🎄 invite leaderboard · final', 10, 'final results · every valid invite = a raffle entry ♡ thank you all!'));
        await this.db.inviteEventState.update({ where: { guildId: this.guildId }, data: { finalPostedAt: now } });
        return;
      }
      // Sunday 6 PM Edmonton, while the event runs.
      const sunday = lastSundayPost(now);
      if (!state.frozenAt && sunday.at >= state.startAt && state.lastWeeklyDay !== sunday.day && now.getTime() - sunday.at.getTime() < WEEKLY_GRACE_MS) {
        const week = state.weeklyPosts + 1;
        const left = daysLeft(now, this.config.end);
        await this.#post(await this.#leaderboard(`🎄 invite leaderboard · week ${week}`, 5, `${left} day${left === 1 ? '' : 's'} left · every valid invite = a raffle entry ♡ check yours with /invites`));
        await this.db.inviteEventState.update({ where: { guildId: this.guildId }, data: { weeklyPosts: week, lastWeeklyDay: sunday.day } });
      }
    });
  }

  #settleDay(cutoff: Date): string {
    return new Date(cutoff.getTime() + STAY_DAYS * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  async #post(embed: EmbedBuilder): Promise<void> {
    const channel = await this.client.channels.fetch(this.config.leaderboardChannelId).catch(() => null);
    if (!channel?.isSendable()) {
      this.log.error({ channelId: this.config.leaderboardChannelId }, "invite event: can't post in LEADERBOARD_CHANNEL_ID");
      return;
    }
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  async #staffLog(embed: EmbedBuilder): Promise<void> {
    const id = this.config.staffLogChannelId ?? (await this.db.settings.findUnique({ where: { guildId: this.guildId } }))?.logChannelId;
    if (!id) return;
    const channel = await this.client.channels.fetch(id).catch(() => null);
    if (channel?.isSendable()) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err: unknown) => this.log.warn({ err }, "couldn't post to the staff log"));
  }

  // ---- Leaderboard and /invites ----

  async #ranked() {
    const rows = await this.db.inviteJoin.findMany({ where: { status: 'valid', validatedAt: { not: null }, inviterId: { not: null } }, select: { inviterId: true, validatedAt: true } });
    return rankInviters(rows.map((r) => ({ inviterId: r.inviterId!, validatedAt: r.validatedAt! })));
  }

  async #leaderboard(title: string, limit: number, footer: string): Promise<EmbedBuilder> {
    const lines = leaderboardLines(await this.#ranked(), limit);
    return new EmbedBuilder()
      .setColor(this.config.color)
      .setTitle(title)
      .setDescription(lines.length ? lines.join('\n') : 'no valid invites yet · invite friends and they count after 7 days ♡')
      .setFooter({ text: footer });
  }

  /** /leaderboard: the top 10 now. */
  async leaderboard(): Promise<EmbedBuilder> {
    const state = await this.state();
    const now = this.now();
    const over = !!state.frozenAt || now >= this.config.end;
    const left = daysLeft(now, this.config.end);
    return this.#leaderboard('🎄 invite leaderboard', 10, over ? `the event is over · ${state.finalPostedAt ? 'these are the final results' : `final after ${this.#settleDay(joinCutoff(this.config.end, state.frozenAt))}`} ♡` : `${left} day${left === 1 ? '' : 's'} left · every valid invite = a raffle entry ♡`);
  }

  /** /invites: one member's counts and rank. */
  async invitesOf(userId: string): Promise<EmbedBuilder> {
    const state = await this.state();
    const joins = await this.db.inviteJoin.findMany({ where: { inviterId: userId } });
    const count = (s: InviteStatus) => joins.filter((j) => j.status === s).length;
    const ranked = await this.#ranked();
    const rank = ranked.findIndex((r) => r.inviterId === userId);
    const lines = [
      `**${count('valid')}** valid invite${count('valid') === 1 ? '' : 's'} = **${count('valid')}** raffle entr${count('valid') === 1 ? 'y' : 'ies'}${rank >= 0 ? ` · #${rank + 1} on the leaderboard` : ''}`,
      `⏳ ${count('pending')} pending · 🚪 ${count('left')} left · ✖️ ${count('invalid') + count('disqualified')} not counted`,
    ];
    const pending = joins.filter((j) => j.status === 'pending');
    if (pending.length) lines.push('', '**Pending**', ...pending.slice(0, 10).map((j) => `<@${j.inviteeId}> · ${j.invalidReason ?? 'checking'}`));
    if (await this.#isDisqualified(userId)) lines.push('', '⚠️ Your invites are not counting in this event. Ask staff if you think this is a mistake.');
    lines.push('', `-# Only joins since <t:${Math.floor(state.startAt.getTime() / 1000)}:D> are tracked: invites from before can't be counted. An invite counts once they've been here ${STAY_DAYS} days and have the level 3 role.`);
    return new EmbedBuilder().setColor(this.config.color).setTitle('🎄 your invites').setDescription(`<@${userId}>\n\n${lines.join('\n')}`);
  }

  // ---- /invite-link ----

  /** A permanent invite only this member uses: joins through it are credited to them. */
  async personalLink(member: GuildMember): Promise<string> {
    if (!this.#enabled) return "❌ Invite tracking is off right now, so links can't be credited. Staff have been told.";
    const existing = await this.db.personalInvite.findUnique({ where: { userId: member.id } });
    if (existing && this.#invites.has(existing.code)) return `🎄 Your invite link: https://discord.gg/${existing.code}\nEveryone who joins with it is credited to you.`;
    if (existing) await this.db.personalInvite.delete({ where: { code: existing.code } });
    const channelId = this.config.inviteLinkChannelId ?? this.config.leaderboardChannelId;
    const channel = await member.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !('createInvite' in channel)) return "❌ The invite link channel isn't set up right. Staff: check INVITE_LINK_CHANNEL_ID.";
    try {
      const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `Personal invite link for ${member.user.username} (invite event)` });
      await this.#serial(async () => {
        this.#invites.set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviterId ?? null });
        await this.db.personalInvite.create({ data: { code: invite.code, userId: member.id, channelId } });
      });
      return `🎄 Your invite link: https://discord.gg/${invite.code}\nIt never expires, and everyone who joins with it is credited to you.`;
    } catch (err) {
      this.log.warn({ err }, "invite event: couldn't make a personal invite");
      return "❌ I couldn't make an invite link. Staff: the bot needs **Create Invite** in the invite link channel.";
    }
  }

  // ---- Staff ----

  async review(userId: string): Promise<string> {
    const joins = await this.db.inviteJoin.findMany({ where: { inviterId: userId }, orderBy: { joinedAt: 'asc' } });
    const flags = await this.db.inviteFlag.findMany({ where: { inviterId: userId }, orderBy: { createdAt: 'asc' } });
    const dq = await this.db.disqualifiedInviter.findUnique({ where: { userId } });
    const icon: Record<string, string> = { valid: '✅', pending: '⏳', left: '🚪', invalid: '✖️', disqualified: '⛔' };
    const lines = [`**Invites by <@${userId}>** (${joins.length})`];
    if (dq) lines.push(`⛔ Disqualified by <@${dq.byId}>: ${dq.reason}`);
    for (const j of joins.slice(0, 40)) {
      const age = Math.floor((j.joinedAt.getTime() - j.accountCreatedAt.getTime()) / DAY);
      lines.push(`${icon[j.status] ?? '•'} <@${j.inviteeId}> \`${j.inviteeId}\` · ${j.source} · joined <t:${Math.floor(j.joinedAt.getTime() / 1000)}:d> · account ${age}d${j.defaultAvatar ? ' · default avatar' : ''}${j.invalidReason ? ` · ${j.invalidReason}` : ''}${j.overrideStatus ? ` · set by <@${j.overrideBy}>` : ''}`);
    }
    if (joins.length > 40) lines.push(`…and ${joins.length - 40} more (see /invite-event raffle-export).`);
    if (flags.length) lines.push('', '**Flags**', ...flags.map((f) => `🚩 ${f.reason}`));
    return lines.join('\n').slice(0, 3900);
  }

  async disqualify(userId: string, reason: string, byId: string): Promise<string> {
    await this.db.disqualifiedInviter.upsert({ where: { userId }, create: { userId, reason, byId }, update: { reason, byId, at: this.now() } });
    await this.db.inviteJoin.updateMany({ where: { inviterId: userId, overrideStatus: null }, data: { status: 'disqualified', invalidReason: 'inviter disqualified' } });
    await this.#staffLog(new EmbedBuilder().setColor(0xed4245).setTitle('⛔ Inviter disqualified').setDescription(`<@${userId}> by <@${byId}>\n**Why:** ${reason}`).setTimestamp(this.now()));
    return `⛔ <@${userId}> is disqualified: none of their invites count.`;
  }

  async reinstate(userId: string, byId: string): Promise<string> {
    const { count } = await this.db.disqualifiedInviter.deleteMany({ where: { userId } });
    if (!count) return `<@${userId}> isn't disqualified.`;
    await this.#reevaluate({ inviterId: userId });
    await this.#staffLog(new EmbedBuilder().setColor(0x57f287).setTitle('✅ Inviter reinstated').setDescription(`<@${userId}> by <@${byId}>`).setTimestamp(this.now()));
    return `✅ <@${userId}> is back in the event: their invites are checked by the normal rules again.`;
  }

  /** Staff decide one invite (or "auto" to go back to the rules). */
  async setStatus(inviteeId: string, status: string, reason: string | null, byId: string): Promise<string> {
    const join = await this.db.inviteJoin.findUnique({ where: { inviteeId } });
    if (!join) return `❌ <@${inviteeId}> has no invite in this event.`;
    if (status !== 'auto' && !isStatus(status)) return '❌ Unknown status.';
    await this.db.inviteJoin.update({
      where: { id: join.id },
      data: status === 'auto' ? { overrideStatus: null, overrideReason: null, overrideBy: null } : { overrideStatus: status, overrideReason: reason ?? `set by staff`, overrideBy: byId },
    });
    await this.#reevaluate({ id: join.id });
    const now = await this.db.inviteJoin.findUniqueOrThrow({ where: { id: join.id } });
    await this.#staffLog(new EmbedBuilder().setColor(this.config.color).setTitle('✏️ Invite status set').setDescription(`<@${inviteeId}> (invited by ${join.inviterId ? `<@${join.inviterId}>` : 'nobody'}) → **${now.status}** by <@${byId}>${reason ? `\n**Why:** ${reason}` : ''}`).setTimestamp(this.now()));
    return `✏️ <@${inviteeId}>'s invite is now **${now.status}**${now.invalidReason ? ` (${now.invalidReason})` : ''}.`;
  }

  async #reevaluate(where: { inviterId?: string; id?: number }): Promise<void> {
    const state = await this.state();
    const guild = this.#guild();
    for (const join of await this.db.inviteJoin.findMany({ where })) {
      const member = join.leftAt ? null : await guild?.members.fetch(join.inviteeId).catch(() => null);
      await this.#apply(join, state, member ? member.roles.cache.has(this.config.level3RoleId) : null, await this.#isDisqualified(join.inviterId), this.now());
    }
  }

  /** The raffle list for wheelofnames.com: one line per valid invite, plus a summary. */
  async raffleExport(): Promise<{ csv: string; summary: string }> {
    const ranked = await this.#ranked();
    const entries = await Promise.all(
      ranked.map(async (r) => ({ name: (await this.client.users.fetch(r.inviterId).catch(() => null))?.username ?? r.inviterId, count: r.count, id: r.inviterId })),
    );
    const state = await this.state();
    const total = entries.reduce((n, e) => n + e.count, 0);
    const pending = await this.db.inviteJoin.count({ where: { status: 'pending' } });
    const summary = [
      `🎟️ **${total}** raffle entr${total === 1 ? 'y' : 'ies'} from **${entries.length}** inviter${entries.length === 1 ? '' : 's'}${state.finalPostedAt ? ' (final)' : ' (not final yet)'}.`,
      pending ? `⏳ ${pending} invite${pending === 1 ? ' is' : 's are'} still pending and not included.` : '',
      ...entries.slice(0, 20).map((e, i) => `${i + 1}. <@${e.id}> (${e.name}) · ${e.count}`),
    ].filter(Boolean);
    return { csv: raffleCsv(entries), summary: summary.join('\n').slice(0, 1900) };
  }

  /** Stops counting new joins now (also happens by itself at the end). */
  async freeze(byId: string): Promise<string> {
    const state = await this.state();
    if (state.frozenAt) return `The event is already frozen (since <t:${Math.floor(state.frozenAt.getTime() / 1000)}:f>).`;
    await this.db.inviteEventState.update({ where: { guildId: this.guildId }, data: { frozenAt: this.now() } });
    await this.#staffLog(new EmbedBuilder().setColor(this.config.color).setTitle('🧊 Invite event frozen').setDescription(`by <@${byId}>. New joins no longer count; earlier ones keep being checked for their ${STAY_DAYS} days.`).setTimestamp(this.now()));
    return `🧊 Frozen. New joins no longer count; the leaderboard posts "event over" within a few minutes, and the final results ${STAY_DAYS} days later.`;
  }

  /** Why tracking is off, for staff commands. */
  get disabledReason(): string | null {
    return this.#disabledReason;
  }
}
