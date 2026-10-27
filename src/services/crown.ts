// Crown of the week (SPEC §6). Awarded right after the week's first reshuffle to
// the top member of the new VIP list, once per week (a JobRun keyed by the week's
// Monday). Losing VIP takes the Crown and the custom role with it; the Crown isn't
// given to anyone else until next week. Custom role settings are kept, so the
// role is recreated if they win again.
import { GuildFeature, GuildPremiumTier, type Client, type Guild, type Role } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { checkCustomRole, MAX_CUSTOM_ROLE_EDITS, pickCrown, type CustomRoleCheck, type CustomRoleInput } from '../core/crown.js';
import type { ReshuffleResult } from '../core/reshuffle.js';
import { serverDayAt, weekStartOf } from '../core/serverDay.js';
import { parseHexColour } from '../core/vipRules.js';
import type { Db } from '../db/prisma.js';
import type { CrownHolder, CustomRole } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import { downloadIcon } from './iconImage.js';
import { claimJob, completeJob, failJob } from './jobs.js';
import type { ModLog } from './modLog.js';
import { explainRoleError, placeNextTo, type RoleQueue } from './roleQueue.js';
import { findExistingRole } from './reuse.js';

export const CROWN_JOB = 'crown';
const DRAFT_MINUTES = 15;

export interface FormPrefill {
  name: string;
  hex: string;
  hex2?: string;
  emoji: string;
  /** They already have an uploaded image icon (forms can't prefill uploads). */
  hasImage?: boolean;
}

/** An image uploaded in the form (an attachment on Discord's CDN). */
export interface IconUpload {
  url: string;
  contentType: string | null;
  size: number;
}

type AppliedRole = Pick<CustomRole, 'name' | 'hex' | 'hex2' | 'emoji' | 'iconImage' | 'roleId'>;

export type FormAccess = { ok: true; prefill: FormPrefill | null } | { ok: false; message: string };

/** Runs after a new Crown is saved; `previous` is last week's holder, if any. */
export type CrownAwardedHook = (holder: CrownHolder, previous: CrownHolder | null) => Promise<void>;
/** Runs after a Crown ends. `continuing`: the same member holds the new week's Crown. */
export type CrownEndedHook = (holder: CrownHolder, why: string, continuing: boolean) => Promise<void>;

export class CrownService {
  /** Crown powers: titles, nickname (crownPowers.ts). */
  readonly onAwarded: CrownAwardedHook[] = [];
  readonly onEnded: CrownEndedHook[] = [];

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly roles: RoleQueue,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  #guild(): Guild | undefined {
    return this.client.guilds.cache.get(this.guildId);
  }

  #week(now = this.clock.now()): string {
    return weekStartOf(serverDayAt(now, this.config.current.boundary).key);
  }

  /** The current Crown holder, if anyone holds it. */
  current(): Promise<CrownHolder | null> {
    return this.db.crownHolder.findFirst({ where: { endedAt: null }, orderBy: { awardedAt: 'desc' } });
  }

  /** Reshuffle hook: the week's first reshuffle awards the Crown. Returns the winner. */
  async afterReshuffle(today: string, result: ReshuffleResult): Promise<string | null> {
    const week = weekStartOf(today);
    const now = this.clock.now();
    if (!(await claimJob(this.db, CROWN_JOB, week, now))) return null;
    const winner = pickCrown(result);
    let prev: CrownHolder | null = null;
    try {
      const previous = (prev = await this.current());
      await this.db.$transaction(async (tx) => {
        if (previous) await tx.crownHolder.update({ where: { id: previous.id }, data: { endedAt: now, endReason: 'week ended' } });
        if (winner) {
          await tx.crownHolder.create({ data: { userId: winner, weekStart: week, awardedAt: now } });
          await tx.auditLog.create({ data: { action: 'crown.award', targetId: winner, data: { week } } });
        }
        await completeJob(tx, CROWN_JOB, week, { winner, previous: previous?.userId ?? null }, now);
      });
    } catch (err) {
      await failJob(this.db, CROWN_JOB, week, err instanceof Error ? err.message : String(err), this.clock.now()).catch(() => undefined);
      throw err;
    }
    // Saved: from here on, failures are logged and fixed by reconcile, never retried.
    try {
      if (prev && prev.userId !== winner) await this.#takeAway(prev.userId, 'the week ended');
      const ended = prev;
      if (ended) await this.#runHooks(this.onEnded.map((h) => () => h(ended, 'the week ended', ended.userId === winner)));
      if (winner) {
        await this.#give(winner);
        const holder = await this.current();
        if (holder) await this.#runHooks(this.onAwarded.map((h) => () => h(holder, prev)));
        await this.modLog.post(`👑 Crown of the week (from ${week}): <@${winner}>`);
      } else {
        await this.modLog.post(`👑 No Crown this week (from ${week}): no VIPs.`);
      }
    } catch (err) {
      this.log.error({ err }, 'applying the new Crown failed; reconcile fixes roles on the next startup');
    }
    return winner;
  }

  async #runHooks(hooks: (() => Promise<void>)[]): Promise<void> {
    for (const hook of hooks) await hook().catch((err: unknown) => this.log.error({ err }, 'Crown hook failed'));
  }

  /** VIP removal hook: the Crown goes with VIP, and isn't reassigned until next week. */
  async onVipRemoved(userId: string, reason: string): Promise<void> {
    const cur = await this.current();
    if (cur?.userId !== userId) return;
    await this.db.$transaction([
      this.db.crownHolder.update({ where: { id: cur.id }, data: { endedAt: this.clock.now(), endReason: `lost VIP: ${reason}` } }),
      this.db.auditLog.create({ data: { action: 'crown.lost', targetId: userId, reason } }),
    ]);
    await this.#takeAway(userId, `lost VIP (${reason})`);
    await this.#runHooks(this.onEnded.map((h) => () => h(cur, `lost VIP (${reason})`, false)));
  }

  /**
   * /vip crown-give: an admin gives this week's Crown to a VIP (for testing, or to
   * fix a mistake). The current holder loses it the usual way; the new holder gets
   * everything a weekly winner gets. It lasts until the next week's award.
   */
  async giveManually(userId: string, actorId: string): Promise<string> {
    const cur = await this.current();
    if (cur?.userId === userId) return `<@${userId}> already holds the Crown.`;
    const now = this.clock.now();
    const week = this.#week(now);
    if (cur) {
      await this.db.$transaction([
        this.db.crownHolder.update({ where: { id: cur.id }, data: { endedAt: now, endReason: `replaced by <@${actorId}>` } }),
        this.db.auditLog.create({ data: { action: 'crown.lost', actorId, targetId: cur.userId, reason: 'replaced by an admin' } }),
      ]);
      await this.#takeAway(cur.userId, 'an admin gave the Crown to someone else');
      await this.#runHooks(this.onEnded.map((h) => () => h(cur, 'was given to someone else', false)));
    }
    // One row per week: reuse this week's row if the Crown was already awarded.
    const holder = await this.db.$transaction(async (tx) => {
      const row = await tx.crownHolder.upsert({
        where: { weekStart: week },
        create: { userId, weekStart: week, awardedAt: now },
        update: { userId, awardedAt: now, endedAt: null, endReason: null, decreeAt: null, nickApplied: false, nickBefore: null },
      });
      await tx.auditLog.create({ data: { action: 'crown.give', actorId, targetId: userId, data: { week } } });
      return row;
    });
    // If this week's award hasn't run yet, mark it done so a reshuffle doesn't replace this.
    if (await claimJob(this.db, CROWN_JOB, week, now)) {
      await this.db.$transaction((tx) => completeJob(tx, CROWN_JOB, week, { winner: userId, previous: cur?.userId ?? null, manual: true }, now));
    }
    await this.#give(userId);
    await this.#runHooks(this.onAwarded.map((h) => () => h(holder, null)));
    await this.modLog.post(`👑 <@${actorId}> gave the Crown (week of ${week}) to <@${userId}>`);
    return `👑 <@${userId}> now holds the Crown until next week's award.`;
  }

  async #give(userId: string): Promise<void> {
    const crownRoleId = this.config.current.guild.crownRoleId;
    if (crownRoleId) {
      const res = await this.roles.run({ userId, roleId: crownRoleId, action: 'add', reason: 'Crown of the week' });
      if (!res.ok) await this.modLog.post(`⚠️ Crown role not given to <@${userId}>: ${res.error}`);
    }
    const custom = await this.db.customRole.findUnique({ where: { userId } });
    if (custom?.name && !custom.locked && !custom.roleId) {
      const err = await this.#applyCustomRole(userId, custom);
      await this.modLog.post(err ? `⚠️ Couldn't recreate <@${userId}>'s custom role: ${err}` : `👑 Recreated <@${userId}>'s custom role "${custom.name}"`);
    }
  }

  async #takeAway(userId: string, why: string): Promise<void> {
    const crownRoleId = this.config.current.guild.crownRoleId;
    if (crownRoleId) await this.roles.run({ userId, roleId: crownRoleId, action: 'remove', reason: `Crown ended: ${why}` });
    const deleted = await this.#deleteCustomRole(userId, `Crown ended: ${why}`);
    await this.modLog.post(`👑 Crown removed from <@${userId}>: ${why}${deleted ? ' (custom role deleted, settings saved)' : ''}`);
  }

  /** Deletes the Discord role, keeps the settings. Returns whether there was a role. */
  async #deleteCustomRole(userId: string, reason: string): Promise<boolean> {
    const custom = await this.db.customRole.findUnique({ where: { userId } });
    if (!custom?.roleId) return false;
    const role = this.#guild()?.roles.cache.get(custom.roleId);
    await role?.delete(reason).catch((err: unknown) => this.log.warn({ err }, "couldn't delete custom role"));
    await this.db.customRole.update({ where: { userId }, data: { roleId: null } });
    return true;
  }

  /** Creates or updates the member's custom role from saved settings, directly above the Crown role. */
  async #applyCustomRole(userId: string, custom: AppliedRole): Promise<string | null> {
    const guild = this.#guild();
    if (!guild) return 'the bot is not in the server';
    const crownRole = this.config.current.guild.crownRoleId ? guild.roles.cache.get(this.config.current.guild.crownRoleId) : undefined;
    const primaryColor = parseHexColour(custom.hex) ?? 0xffffff;
    // Like the VIP colours: a gradient only where the server has gradient roles, otherwise the first colour.
    const second = custom.hex2 && guild.features.includes(GuildFeature.EnhancedRoleColors) ? parseHexColour(custom.hex2) : null;
    const iconsAllowed = guild.premiumTier >= GuildPremiumTier.Tier2;
    const icon = !iconsAllowed
      ? {}
      : custom.iconImage
        ? { icon: Buffer.from(custom.iconImage), unicodeEmoji: null }
        : custom.emoji
          ? { icon: null, unicodeEmoji: custom.emoji }
          : { icon: null, unicodeEmoji: null };
    try {
      let role: Role | undefined = custom.roleId ? guild.roles.cache.get(custom.roleId) : undefined;
      if (role) await role.edit({ name: custom.name, colors: { primaryColor, secondaryColor: second }, ...icon, reason: 'Crown custom role edited' });
      else {
        const colors = second === null ? { primaryColor } : { primaryColor, secondaryColor: second };
        role = await guild.roles.create({ name: custom.name, colors, hoist: false, mentionable: false, permissions: [], ...icon, reason: 'Crown custom role' });
        await this.db.customRole.update({ where: { userId }, data: { roleId: role.id } });
      }
      // On top of the bot's roles (above the colours), so its colour shows.
      const colourRoleIds = (await this.db.colourOption.findMany()).map((o) => o.roleId);
      const top = [crownRole?.id, ...colourRoleIds]
        .map((id) => (id ? guild.roles.cache.get(id) : undefined))
        .filter((r): r is Role => !!r)
        .reduce<Role | undefined>((a, b) => (!a || b.position > a.position ? b : a), undefined);
      if (top) await placeNextTo(guild, role.id, top.id, 'above').catch((err: unknown) => this.log.warn({ err }, "couldn't move the custom role"));
      const res = await this.roles.run({ userId, roleId: role.id, action: 'add', reason: 'Crown custom role' });
      return res.ok ? null : res.error;
    } catch (err) {
      return explainRoleError(err);
    }
  }

  /** Who may open the custom role form, with what filled in. */
  async formAccess(userId: string): Promise<FormAccess> {
    const cur = await this.current();
    if (cur?.userId !== userId) return { ok: false, message: '👑 Only this week’s Crown holder can create a custom role.' };
    const custom = await this.db.customRole.findUnique({ where: { userId } });
    if (custom?.locked) return { ok: false, message: 'Custom roles are locked for you by the admins.' };
    const now = this.clock.now();
    await this.db.modalDraft.deleteMany({ where: { expiresAt: { lte: now } } });
    const draft = await this.db.modalDraft.findUnique({ where: { userId } });
    const saved = custom ? { name: custom.name, hex: custom.hex, hex2: custom.hex2 ?? '', emoji: custom.emoji ?? '', hasImage: !!custom.iconImage } : null;
    const prefill = (draft?.data as FormPrefill | undefined) ?? saved;
    return { ok: true, prefill };
  }

  /** Form submitted. Errors are saved as a draft for "Try again". */
  async submit(userId: string, input: CustomRoleInput, upload: IconUpload | null = null): Promise<{ ok: true; message: string } | { ok: false; errors: string[] }> {
    const access = await this.formAccess(userId);
    if (!access.ok) return { ok: false, errors: [access.message] };
    const guild = this.#guild();
    if (!guild) return { ok: false, errors: ['The bot is not in the server.'] };

    const week = this.#week();
    const custom = await this.db.customRole.findUnique({ where: { userId } });
    const staffIds = new Set((await this.db.staffRole.findMany()).map((s) => s.roleId));
    const blocked = (await this.db.blockedWord.findMany()).map((w) => w.word);
    const isEdit = !!custom?.roleId;
    const editsUsed = custom?.editsWeek === week ? custom.editsCount : 0;

    const check: CustomRoleCheck = checkCustomRole({ ...input, image: upload && { contentType: upload.contentType, size: upload.size } }, {
      otherRoleNames: guild.roles.cache.filter((r) => r.id !== custom?.roleId && r.id !== guild.id).map((r) => r.name),
      staffRoleNames: guild.roles.cache.filter((r) => staffIds.has(r.id)).map((r) => r.name),
      blockedWords: blocked,
      roleIconsAllowed: guild.premiumTier >= GuildPremiumTier.Tier2,
      isEdit,
      editsUsedThisWeek: editsUsed,
      maxEditsPerWeek: MAX_CUSTOM_ROLE_EDITS,
    });
    const fail = async (errors: string[]) => {
      const expiresAt = new Date(this.clock.now().getTime() + DRAFT_MINUTES * 60_000);
      const data = { name: input.name, hex: input.hex, hex2: input.hex2 ?? '', emoji: input.emoji, hasImage: !!custom?.iconImage } satisfies FormPrefill;
      await this.db.modalDraft.upsert({ where: { userId }, create: { userId, data, expiresAt }, update: { data, expiresAt } });
      return { ok: false as const, errors };
    };
    if (!check.ok) return fail(check.errors);

    const v = check.value;
    // The icon: a new upload wins; a new emoji replaces an old image; otherwise the old image stays.
    let icon: { iconImage: Uint8Array<ArrayBuffer> | null; iconType: string | null } = { iconImage: custom?.iconImage ?? null, iconType: custom?.iconType ?? null };
    if (v.useImage && upload) {
      const got = await downloadIcon(upload.url);
      if (!got.ok) return fail([got.error]);
      icon = { iconImage: new Uint8Array(got.data), iconType: got.type };
    } else if (v.emoji) icon = { iconImage: null, iconType: null };

    const editsCount = isEdit ? editsUsed + 1 : editsUsed;
    const fields = { name: v.name, hex: v.hex, hex2: v.hex2, emoji: v.emoji, ...icon, editsWeek: week, editsCount };
    await this.db.$transaction([
      this.db.customRole.upsert({ where: { userId }, create: { userId, ...fields }, update: fields }),
      this.db.modalDraft.deleteMany({ where: { userId } }),
      this.db.auditLog.create({
        data: { action: isEdit ? 'crown.role.edit' : 'crown.role.create', actorId: userId, targetId: userId, data: { name: v.name, hex: v.hex, hex2: v.hex2, emoji: v.emoji, image: !!icon.iconImage } },
      }),
    ]);
    const err = await this.#applyCustomRole(userId, { ...fields, roleId: custom?.roleId ?? null });
    const gradient = v.hex2 ? (guild.features.includes(GuildFeature.EnhancedRoleColors) ? ` → ${v.hex2}` : ` (${v.hex2} unused: no gradient roles here)`) : '';
    const shownIcon = icon.iconImage ? ' with an image icon (below)' : v.emoji ? ` ${v.emoji}` : '';
    // Every uploaded image is shown to staff, so an unsuitable one can be removed with /vip crown-reset.
    const newImage = v.useImage && icon.iconImage ? { name: `icon.${icon.iconType === 'image/png' ? 'png' : 'jpg'}`, data: Buffer.from(icon.iconImage) } : undefined;
    await this.modLog.post(
      `👑 <@${userId}> ${isEdit ? 'edited' : 'created'} their custom role: "${v.name}" ${v.hex}${gradient}${shownIcon}${newImage ? '\nRemove an unsuitable icon with `/vip crown-reset`.' : ''}${err ? `\n⚠️ ${err}` : ''}`,
      newImage,
    );
    if (err) return { ok: false, errors: [`Saved, but the role couldn't be made: ${err}`] };
    const left = MAX_CUSTOM_ROLE_EDITS - editsCount;
    return {
      ok: true,
      message: [
        `✅ Your role **${v.name}** is ${isEdit ? 'updated' : 'ready'}!`,
        v.emojiIgnored ? 'ℹ️ Role icons need Server Boost Level 2, so the icon was left off.' : '',
        v.hex2 && !guild.features.includes(GuildFeature.EnhancedRoleColors) ? 'ℹ️ This server doesn’t have gradient roles, so only your first colour is used.' : '',
        `Edits left this week: ${left}.`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  /** /vip crown-reset: delete the role and its saved settings. */
  async resetRole(userId: string, actorId: string): Promise<boolean> {
    const deleted = await this.#deleteCustomRole(userId, `Reset by ${actorId}`);
    const { count } = await this.db.customRole.deleteMany({ where: { userId } });
    await this.db.auditLog.create({ data: { action: 'crown.role.reset', actorId, targetId: userId } });
    if (deleted || count) await this.modLog.post(`👑 <@${actorId}> reset <@${userId}>'s custom role`);
    return deleted || count > 0;
  }

  /** /vip crown-lock: block or allow custom role creation and edits. */
  async setLocked(userId: string, locked: boolean, actorId: string): Promise<void> {
    await this.db.$transaction([
      this.db.customRole.upsert({
        where: { userId },
        create: { userId, name: '', hex: '#FFFFFF', locked },
        update: { locked },
      }),
      this.db.auditLog.create({ data: { action: locked ? 'crown.lock' : 'crown.unlock', actorId, targetId: userId } }),
    ]);
    await this.modLog.post(`👑 <@${actorId}> ${locked ? 'locked' : 'unlocked'} custom roles for <@${userId}>`);
  }

  /** Startup: only the current holder has the Crown role and a custom role. */
  async reconcile(): Promise<void> {
    const guild = this.#guild();
    const crownRoleId = this.config.current.guild.crownRoleId;
    if (!guild) return;
    const cur = await this.current();
    if (cur && !guild.members.cache.has(cur.userId)) {
      await this.onVipRemoved(cur.userId, 'left the server');
      return this.reconcile();
    }
    if (crownRoleId) {
      const role = guild.roles.cache.get(crownRoleId);
      for (const id of role?.members.keys() ?? []) {
        if (id !== cur?.userId) await this.roles.run({ userId: id, roleId: crownRoleId, action: 'remove', reason: 'Not the Crown holder' });
      }
      if (cur && role && !role.members.has(cur.userId)) await this.roles.run({ userId: cur.userId, roleId: crownRoleId, action: 'add', reason: 'Crown holder' });
    }
    for (const custom of await this.db.customRole.findMany({ where: { roleId: { not: null } } })) {
      if (custom.userId !== cur?.userId) await this.#deleteCustomRole(custom.userId, 'Not the Crown holder');
    }
    await this.db.modalDraft.deleteMany({ where: { expiresAt: { lte: this.clock.now() } } });
  }

  /** /bot setup: the Crown role, above the colour roles (SPEC §12). */
  async setup(guild: Guild, vipRole: Role, report: string[]): Promise<void> {
    const cfg = this.config.current.guild;
    const colour = parseHexColour(cfg.crownColour) ?? 0xff00c8;
    let role = cfg.crownRoleId ? guild.roles.cache.get(cfg.crownRoleId) : undefined;
    try {
      if (!role) {
        // Take over an existing Crown role rather than making a second one.
        role = await findExistingRole(guild, this.db, cfg, ['👑 Crown', 'Crown']);
        if (role) {
          await this.db.guildConfig.update({ where: { guildId: guild.id }, data: { crownRoleId: role.id } });
          await this.config.load();
          report.push(`♻️ Using the existing ${role.toString()} role for the Crown`);
        }
      }
      const icon = guild.premiumTier >= GuildPremiumTier.Tier2 ? { unicodeEmoji: '👑' } : {};
      if (role) await role.edit({ colors: { primaryColor: colour }, hoist: true, mentionable: false, ...icon, reason: '/bot setup' });
      else {
        role = await guild.roles.create({ name: '👑 Crown', colors: { primaryColor: colour }, hoist: true, mentionable: false, permissions: [], ...icon, reason: '/bot setup' });
        await this.db.guildConfig.update({ where: { guildId: guild.id }, data: { crownRoleId: role.id } });
        await this.config.load();
      }
      // Its place (just below the colours, above the titles and VIP) is set by roleLayout.ts.
      report.push(`✅ Crown role ${role.toString()} ready`);
    } catch (err) {
      report.push(`❌ Crown role: ${explainRoleError(err)}`);
    }
    await this.reconcile();
  }
}
