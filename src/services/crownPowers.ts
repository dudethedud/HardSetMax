// What the Crown can do for its week, besides the custom role (crown.ts):
// - appoint three cosmetic titles (Champion, Advisor, Jester), cleared every week
//   and when the Crown is lost
// - post one decree to the announcements channel, with no pings
// - wear a 👑 nickname prefix, restored when the Crown ends
// Each title has a job (core/perks.ts): the Champion's guest VIP pass works through
// VipService.hasPerk, the Advisor's polls through PollService, the Jester's
// buttons through jester.ts. The database is the source of truth and reconcile
// makes the roles match it.
import { GuildPremiumTier, OverwriteType, PermissionFlagsBits, type Client, type Guild, type GuildMember, type Role } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { cleanPublicText, CROWN_NICK_PREFIX, crownNickname, isTitleSlot, TITLE_SLOTS, titlePerks, titleTargetError, type Perk, type TitleSlot } from '../core/perks.js';
import type { Db } from '../db/prisma.js';
import type { CrownHolder, CrownTitle } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import type { CrownService } from './crown.js';
import type { ModLog } from './modLog.js';
import { explainRoleError, type RoleQueue } from './roleQueue.js';
import { findExistingRole } from './reuse.js';

export const DECREE_MAX = 500;

/** Runs after someone gains or loses a title (to give or take its guest perks). */
export type TitleChangeHook = (userId: string, slot: TitleSlot, gained: boolean) => Promise<void>;
const NO_PERKS: ReadonlySet<Perk> = new Set();

export class CrownPowers {
  /** Called after anything the VIP board shows changes. */
  onChange: () => void = () => undefined;
  readonly onTitleChange: TitleChangeHook[] = [];
  /** Who holds which title, kept in step with the database for fast perk checks. */
  #holders = new Map<string, TitleSlot>();

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly crown: CrownService,
    private readonly roles: RoleQueue,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
    /** What the VIP role allows (setup.ts), given to the Champion too. */
    private readonly vipPermissions: readonly bigint[] = [],
  ) {}

  /** Title roles with the lounge perk (the Champion) can see and use the VIP Lounge like VIPs. */
  async #loungeAccess(guild: Guild, report: string[]): Promise<void> {
    const cfg = this.config.current.guild;
    const roles = (await this.titles()).filter((t) => t.roleId && isTitleSlot(t.slot) && titlePerks(t.slot).has('lounge')).map((t) => t.roleId!);
    const full = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, Connect: true, Speak: true };
    const readOnly = { ViewChannel: true, ReadMessageHistory: true, SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false, AddReactions: false };
    const channels: [string | null, typeof full | typeof readOnly][] = [
      [cfg.loungeCategoryId, full],
      [cfg.loungeTextId, full],
      [cfg.loungeVoiceId, full],
      [cfg.loungePerksId, readOnly],
    ];
    try {
      for (const [id, perms] of channels) {
        const channel = id ? guild.channels.cache.get(id) : undefined;
        if (!channel || !('permissionOverwrites' in channel)) continue;
        for (const roleId of roles) await channel.permissionOverwrites.edit(roleId, perms, { type: OverwriteType.Role, reason: '/bot setup: the Champion can use the VIP Lounge' });
      }
    } catch (err) {
      report.push(`⚠️ Couldn't open the VIP Lounge to the Champion: ${explainRoleError(err)}`);
    }
  }

  #guild(): Guild | undefined {
    return this.client.guilds.cache.get(this.guildId);
  }

  async #member(userId: string): Promise<GuildMember | null> {
    const guild = this.#guild();
    return guild ? (guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null))) : null;
  }

  /** The title slots, created with their default names the first time. */
  async titles(): Promise<CrownTitle[]> {
    const rows = await this.db.crownTitle.findMany();
    const missing = TITLE_SLOTS.filter((t) => !rows.some((r) => r.slot === t.slot));
    if (missing.length) {
      await this.db.crownTitle.createMany({ data: missing.map((t) => ({ slot: t.slot, name: t.name })), skipDuplicates: true });
      return this.titles();
    }
    const sorted = TITLE_SLOTS.map((t) => rows.find((r) => r.slot === t.slot)!);
    this.#holders = new Map(sorted.filter((t) => t.holderId && isTitleSlot(t.slot)).map((t) => [t.holderId!, t.slot as TitleSlot]));
    return sorted;
  }

  /** The title someone holds, if any (from the last database read). */
  titleOf(userId: string): TitleSlot | null {
    return this.#holders.get(userId) ?? null;
  }

  /** The guest perks someone has from their title. */
  perksOf(userId: string): ReadonlySet<Perk> {
    const slot = this.#holders.get(userId);
    return slot ? titlePerks(slot) : NO_PERKS;
  }

  async #runTitleHooks(userId: string, slot: TitleSlot, gained: boolean): Promise<void> {
    for (const hook of this.onTitleChange) await hook(userId, slot, gained).catch((err: unknown) => this.log.error({ err }, 'title hook failed'));
  }

  async #isStaff(member: GuildMember): Promise<boolean> {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const staff = new Set((await this.db.staffRole.findMany()).map((s) => s.roleId));
    return member.roles.cache.some((r) => staff.has(r.id));
  }

  /** The Crown holder gives a title to someone, or clears it (targetId null). Returns the private reply. */
  async appoint(actorId: string, slot: string, targetId: string | null): Promise<string> {
    const cur = await this.crown.current();
    if (cur?.userId !== actorId) return '👑 Only this week’s Crown holder can hand out titles.';
    if (!isTitleSlot(slot)) return 'Unknown title.';
    const titles = await this.titles();
    const title = titles.find((t) => t.slot === slot)!;
    if (!title.roleId) return '❌ Titles aren’t set up yet. Ask an admin to run `/bot setup`.';

    if (targetId === null) {
      if (!title.holderId) return `Nobody holds **${title.name}**.`;
      await this.#setHolders([{ title, holderId: null }], actorId, 'cleared by the Crown');
      return `✅ **${title.name}** is now empty.`;
    }
    if (title.holderId === targetId) return `<@${targetId}> already holds **${title.name}**.`;

    const member = await this.#member(targetId);
    const error = titleTargetError({
      targetId,
      crownId: actorId,
      isBot: member?.user.bot ?? false,
      isStaff: member ? await this.#isStaff(member) : false,
      inServer: !!member,
    });
    if (error) return `❌ ${error}`;

    // One title per person: giving them a new one moves them.
    const moving = titles.filter((t) => t.holderId === targetId);
    await this.#setHolders([...moving.map((t) => ({ title: t, holderId: null })), { title, holderId: targetId }], actorId, 'appointed by the Crown');
    return `✅ <@${targetId}> is now **${title.name}**${moving.length ? ` (moved from ${moving.map((t) => t.name).join(', ')})` : ''}.`;
  }

  async #setHolders(changes: { title: CrownTitle; holderId: string | null }[], actorId: string | null, why: string): Promise<void> {
    const now = this.clock.now();
    await this.db.$transaction([
      ...changes.map((c) => this.db.crownTitle.update({ where: { slot: c.title.slot }, data: { holderId: c.holderId, appointedAt: c.holderId ? now : null } })),
      ...changes.map((c) =>
        this.db.auditLog.create({ data: { action: c.holderId ? 'crown.title.give' : 'crown.title.clear', actorId, targetId: c.holderId ?? c.title.holderId, data: { slot: c.title.slot } } }),
      ),
    ]);
    for (const c of changes) {
      if (c.title.holderId) this.#holders.delete(c.title.holderId);
      if (c.holderId && isTitleSlot(c.title.slot)) this.#holders.set(c.holderId, c.title.slot);
    }
    for (const c of changes) {
      const slot = c.title.slot as TitleSlot;
      // Perks follow the database even if the role change fails.
      if (c.title.holderId) await this.#runTitleHooks(c.title.holderId, slot, false);
      if (c.holderId) await this.#runTitleHooks(c.holderId, slot, true);
      if (!c.title.roleId) continue;
      if (c.title.holderId) {
        await this.roles.run({ userId: c.title.holderId, roleId: c.title.roleId, action: 'remove', reason: `Title ${c.title.name}: ${why}` });
        await this.modLog.post(`🎖️ <@${c.title.holderId}> lost the title ${c.title.name}: ${why}`);
      }
      if (c.holderId) {
        const res = await this.roles.run({ userId: c.holderId, roleId: c.title.roleId, action: 'add', reason: `Title ${c.title.name}: ${why}` });
        await this.modLog.post(res.ok ? `🎖️ <@${c.holderId}> got the title ${c.title.name}: ${why}` : `⚠️ Title ${c.title.name} not given to <@${c.holderId}>: ${res.error}`);
      }
    }
    this.onChange();
  }

  async clearTitles(why: string): Promise<void> {
    const held = (await this.titles()).filter((t) => t.holderId);
    if (held.length) await this.#setHolders(held.map((title) => ({ title, holderId: null })), null, why);
  }

  /** Who may write a decree right now. */
  async decreeAccess(userId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const cur = await this.crown.current();
    if (cur?.userId !== userId) return { ok: false, message: '👑 Only this week’s Crown holder can make a decree.' };
    if (cur.decreeAt) return { ok: false, message: `📜 You already made this week’s decree (<t:${Math.floor(cur.decreeAt.getTime() / 1000)}:R>). One per Crown week.` };
    if (!this.config.current.guild.announceChannelId) return { ok: false, message: '❌ There’s no announcements channel yet. Ask an admin to set one.' };
    return { ok: true };
  }

  /** Posts the week's decree. Returns the private reply. */
  async decree(userId: string, raw: string): Promise<string> {
    const access = await this.decreeAccess(userId);
    if (!access.ok) return access.message;
    const blocked = (await this.db.blockedWord.findMany()).map((w) => w.word);
    const clean = cleanPublicText(raw, blocked, DECREE_MAX);
    if (!clean.ok) return `❌ ${clean.error}`;
    const cur = (await this.crown.current())!;
    // Claim the week's decree first, so two quick submits can't both post.
    const { count } = await this.db.crownHolder.updateMany({ where: { id: cur.id, decreeAt: null }, data: { decreeAt: this.clock.now() } });
    if (!count) return '📜 You already made this week’s decree.';
    let message;
    try {
      const channel = await this.client.channels.fetch(this.config.current.guild.announceChannelId!);
      if (!channel?.isSendable()) throw new Error('the announcements channel is missing');
      const quoted = clean.text
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      message = await channel.send({ content: `📜 **A decree from the Crown, <@${userId}>:**\n${quoted}`, allowedMentions: { parse: [] } });
    } catch (err) {
      await this.db.crownHolder.update({ where: { id: cur.id }, data: { decreeAt: null } });
      this.log.warn({ err }, "couldn't post the decree");
      return "❌ Couldn't post your decree. You can try again.";
    }
    // The text itself is not saved (CLAUDE.md: no message content).
    await this.db.auditLog
      .create({ data: { action: 'crown.decree', actorId: userId, data: { messageId: message.id } } })
      .catch((err: unknown) => this.log.warn({ err }, "couldn't log the decree"));
    await this.modLog.post(`📜 <@${userId}> posted the Crown's decree: ${message.url}`);
    return `✅ Your decree is up: ${message.url}`;
  }

  /** CrownService hook: new week, new titles; and the 👑 nickname. */
  async onAwarded(holder: CrownHolder, previous: CrownHolder | null): Promise<void> {
    await this.clearTitles('new Crown week');
    if (previous?.userId === holder.userId && previous.nickApplied) {
      // Same holder again: the 👑 nickname stays, and so does the name to restore.
      await this.db.$transaction([
        this.db.crownHolder.update({ where: { id: holder.id }, data: { nickApplied: true, nickBefore: previous.nickBefore } }),
        this.db.crownHolder.update({ where: { id: previous.id }, data: { nickApplied: false } }),
      ]);
    } else {
      await this.#applyNick(holder);
    }
    this.onChange();
  }

  /** CrownService hook: titles go with the Crown; the nickname comes back. */
  async onEnded(holder: CrownHolder, why: string, continuing: boolean): Promise<void> {
    if (!continuing) {
      await this.clearTitles(`the Crown ${why}`);
      await this.#restoreNick(holder);
    }
    this.onChange();
  }

  async #applyNick(holder: CrownHolder): Promise<void> {
    const guild = this.#guild();
    const member = await this.#member(holder.userId);
    // Discord never lets bots rename the server owner, or anyone above the bot.
    if (!guild || !member || member.id === guild.ownerId || !member.manageable) return;
    if (member.nickname?.startsWith(CROWN_NICK_PREFIX.trim())) return;
    // Save what to restore first, so a crash in between can still be undone.
    await this.db.crownHolder.update({ where: { id: holder.id }, data: { nickApplied: true, nickBefore: member.nickname } });
    await member.setNickname(crownNickname(member.displayName), 'Crown of the week').catch((err: unknown) => this.log.warn({ err }, "couldn't set the Crown nickname"));
  }

  async #restoreNick(holder: CrownHolder): Promise<void> {
    const fresh = await this.db.crownHolder.findUnique({ where: { id: holder.id } });
    if (!fresh?.nickApplied) return;
    const member = await this.#member(holder.userId);
    // Only undo our own change: if they renamed themselves since, keep their name.
    if (member?.manageable && member.nickname?.startsWith(CROWN_NICK_PREFIX.trim())) {
      await member.setNickname(fresh.nickBefore, 'Crown ended').catch((err: unknown) => this.log.warn({ err }, "couldn't restore the nickname"));
    }
    await this.db.crownHolder.update({ where: { id: holder.id }, data: { nickApplied: false } });
  }

  /** Startup: title roles match the database, ended Crowns get their nickname back. */
  async reconcile(): Promise<void> {
    const guild = this.#guild();
    if (!guild) return;
    const cur = await this.crown.current();
    if (!cur) await this.clearTitles('nobody holds the Crown');
    for (const title of await this.titles()) {
      if (title.holderId && !guild.members.cache.has(title.holderId)) {
        await this.#setHolders([{ title, holderId: null }], null, 'left the server');
        continue;
      }
      const role = title.roleId ? guild.roles.cache.get(title.roleId) : undefined;
      if (!role) continue;
      for (const id of role.members.keys()) {
        if (id !== title.holderId) await this.roles.run({ userId: id, roleId: role.id, action: 'remove', reason: `Doesn't hold the title ${title.name}` });
      }
      if (title.holderId && !role.members.has(title.holderId)) {
        await this.roles.run({ userId: title.holderId, roleId: role.id, action: 'add', reason: `Holds the title ${title.name}` });
      }
    }
    for (const ended of await this.db.crownHolder.findMany({ where: { nickApplied: true, endedAt: { not: null } } })) await this.#restoreNick(ended);
  }

  /** /bot setup: a role per title (placed below the Crown by roleLayout.ts). */
  async setup(guild: Guild, _vipRole: Role, report: string[]): Promise<void> {
    for (const title of await this.titles()) {
      try {
        let role = title.roleId ? guild.roles.cache.get(title.roleId) : undefined;
        if (!role) {
          const plain = title.name.replace(/^\S+\s+/, ''); // "Champion" for "🛡️ Champion"
          role = await findExistingRole(guild, this.db, this.config.current.guild, [title.name, plain], { unusedOnly: true });
          if (role) await this.db.crownTitle.update({ where: { slot: title.slot }, data: { roleId: role.id, name: role.name } });
        }
        // Stand out: own member-list group, a colour and an icon. A role an admin bound
        // keeps its own colour and icon if it already has them.
        const style = TITLE_SLOTS.find((t) => t.slot === title.slot)!;
        const icons = guild.premiumTier >= GuildPremiumTier.Tier2;
        // The Champion's guest pass includes VIP's chat perks (files, links, emojis). No moderation.
        const permissions = (style.perks as readonly Perk[]).includes('lounge') ? this.vipPermissions : [];
        if (role) {
          await role.edit({
            name: role.id === title.roleId ? title.name : role.name,
            permissions,
            mentionable: false,
            hoist: true,
            ...(role.colors.primaryColor === 0 ? { colors: { primaryColor: style.colour } } : {}),
            ...(icons && !role.unicodeEmoji && !role.icon ? { unicodeEmoji: style.icon } : {}),
            reason: '/bot setup',
          });
        } else {
          role = await guild.roles.create({
            name: title.name,
            permissions,
            mentionable: false,
            hoist: true,
            colors: { primaryColor: style.colour },
            ...(icons ? { unicodeEmoji: style.icon } : {}),
            reason: 'Crown title',
          });
          await this.db.crownTitle.update({ where: { slot: title.slot }, data: { roleId: role.id } });
        }
      } catch (err) {
        report.push(`❌ Title ${title.name}: ${explainRoleError(err)}`);
      }
    }
    await this.#loungeAccess(guild, report);
    report.push(`✅ Crown titles ready: ${(await this.titles()).map((t) => (t.roleId ? `<@&${t.roleId}>` : t.name)).join(', ')}`);
    await this.reconcile();
  }
}
