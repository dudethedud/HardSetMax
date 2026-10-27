// VIP colours (SPEC §5): one role per colour option, placed above the VIP role. A
// VIP picks one from the lounge dropdown. The pick is saved, removed with VIP and
// restored when VIP comes back.
import { GuildFeature, type Client, type Guild, type Role } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { DEFAULT_COLOURS, MAX_COLOURS } from '../core/polls.js';
import { parseHexColour } from '../core/vipRules.js';
import type { Db } from '../db/prisma.js';
import type { ColourOption } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';
import type { ModLog } from './modLog.js';
import type { RoleQueue } from './roleQueue.js';
import { explainRoleError } from './roleQueue.js';
import { findExistingRole } from './reuse.js';
import type { VipService } from './vipService.js';

export class ColourService {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly roles: RoleQueue,
    private readonly vip: VipService,
    private readonly modLog: ModLog,
    private readonly log: Logger,
  ) {}

  options(): Promise<ColourOption[]> {
    return this.db.colourOption.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  }

  async #colourRoleIds(): Promise<string[]> {
    return (await this.options()).map((o) => o.roleId).filter((id): id is string => !!id);
  }

  /** /bot setup: adds the default colours once, then creates or repairs every colour role. */
  async setup(guild: Guild, vipRole: Role, report: string[]): Promise<void> {
    const cfg = this.config.current.guild;
    if (!cfg.coloursSeeded) {
      if ((await this.db.colourOption.count()) === 0) {
        await this.db.colourOption.createMany({ data: DEFAULT_COLOURS.map((c, i) => ({ ...c, position: i })) });
      }
      await this.db.guildConfig.update({ where: { guildId: guild.id }, data: { coloursSeeded: true } });
      await this.config.load();
    }

    const created: Role[] = [];
    for (const option of await this.options()) {
      try {
        created.push(await this.#ensureRole(guild, option));
      } catch (err) {
        report.push(`❌ Colour role ${option.name}: ${explainRoleError(err)}`);
      }
    }
    // Their place (above VIP, first option on top) is set by roleLayout.ts.
    report.push(`✅ ${created.length} colour roles ready`);
    const drift = await this.reconcile();
    if (drift) report.push(`🔧 Colour roles fixed for ${drift} member(s)`);
  }

  /** The role colours for an option: a gradient where the server supports gradient roles. */
  #colors(guild: Guild, option: Pick<ColourOption, 'hex' | 'hex2'>): { primaryColor: number; secondaryColor?: number } {
    const primaryColor = parseHexColour(option.hex) ?? 0;
    const second = option.hex2 ? parseHexColour(option.hex2) : null;
    return second !== null && guild.features.includes(GuildFeature.EnhancedRoleColors) ? { primaryColor, secondaryColor: second } : { primaryColor };
  }

  async #ensureRole(guild: Guild, option: ColourOption): Promise<Role> {
    const colors = this.#colors(guild, option);
    const existing = option.roleId ? guild.roles.cache.get(option.roleId) : undefined;
    if (existing) {
      if (existing.name !== option.name || existing.colors.primaryColor !== colors.primaryColor || (existing.colors.secondaryColor ?? undefined) !== colors.secondaryColor) {
        await existing.edit({ name: option.name, colors, reason: 'VIP colour' });
      }
      return existing;
    }
    // Only an unused, permission-free role with the same name is taken over: never one people already wear.
    const reuse = await findExistingRole(guild, this.db, this.config.current.guild, [option.name], { unusedOnly: true });
    if (reuse) {
      await reuse.edit({ colors, reason: 'VIP colour' });
      await this.db.colourOption.update({ where: { id: option.id }, data: { roleId: reuse.id } });
      return reuse;
    }
    const role = await guild.roles.create({
      name: option.name,
      colors,
      hoist: false,
      mentionable: false,
      permissions: [],
      reason: 'VIP colour',
    });
    await this.db.colourOption.update({ where: { id: option.id }, data: { roleId: role.id } });
    return role;
  }

  /** Dropdown pick. `optionId` null = remove colour. Returns the reply text. */
  async pick(userId: string, optionId: number | null): Promise<string> {
    if (!this.vip.hasPerk(userId, 'colour')) return '⭐ Colours are for VIPs only. Stay active to earn a VIP slot!';
    const option = optionId === null ? null : await this.db.colourOption.findUnique({ where: { id: optionId } });
    if (optionId !== null && !option?.roleId) return 'That colour no longer exists. Pick another one.';

    if (option) await this.db.userColourChoice.upsert({ where: { userId }, create: { userId, optionId: option.id }, update: { optionId: option.id } });
    else await this.db.userColourChoice.deleteMany({ where: { userId } });

    const failed = await this.#apply(userId, option?.roleId ?? null, option ? `VIP colour: ${option.name}` : 'VIP colour removed');
    if (failed) return `⚠️ Saved, but the role couldn't be changed: ${failed}`;
    return option ? `🎨 Your colour is now **${option.name}**.` : 'Your colour was removed.';
  }

  /** Gives `keepRoleId` (if any) and removes every other colour role. Returns an error or null. */
  async #apply(userId: string, keepRoleId: string | null, reason: string): Promise<string | null> {
    const guild = this.client.guilds.cache.get(this.guildId);
    const member = guild?.members.cache.get(userId);
    let error: string | null = null;
    for (const roleId of await this.#colourRoleIds()) {
      const want = roleId === keepRoleId;
      if (member && member.roles.cache.has(roleId) === want) continue;
      const res = await this.roles.run({ userId, roleId, action: want ? 'add' : 'remove', reason });
      if (!res.ok) error = res.error;
    }
    return error;
  }

  /** VIP removal hook: the colour role goes, the choice stays saved. */
  async onVipRemoved(userId: string): Promise<void> {
    if (this.vip.hasPerk(userId, 'colour')) return; // still has colours (VIP, or the Champion's guest pass)
    await this.#apply(userId, null, 'VIP lost');
  }

  /** VIP addition hook: restore their last pick. */
  async onVipAdded(userId: string): Promise<void> {
    const choice = await this.db.userColourChoice.findUnique({ where: { userId }, include: { option: true } });
    if (choice?.option.roleId) await this.#apply(userId, choice.option.roleId, `VIP colour restored: ${choice.option.name}`);
  }

  /** Colour roles match VIP status and saved picks. Returns how many members were fixed. */
  async reconcile(): Promise<number> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) return 0;
    const roleIds = new Set(await this.#colourRoleIds());
    const choices = new Map((await this.db.userColourChoice.findMany({ include: { option: true } })).map((c) => [c.userId, c.option.roleId]));
    let fixed = 0;
    for (const member of guild.members.cache.values()) {
      const has = [...member.roles.cache.keys()].filter((r) => roleIds.has(r));
      const want = this.vip.hasPerk(member.id, 'colour') ? (choices.get(member.id) ?? null) : null;
      if (has.length === (want ? 1 : 0) && (!want || has[0] === want)) continue;
      fixed++;
      await this.#apply(member.id, want, 'VIP colour check');
    }
    return fixed;
  }

  async addOption(name: string, hex: string, actorId: string, hex2?: string): Promise<string> {
    if ((await this.db.colourOption.count()) >= MAX_COLOURS) return `❌ There can be at most ${MAX_COLOURS} colours.`;
    if (await this.db.colourOption.findUnique({ where: { name } })) return `❌ A colour called ${name} already exists.`;
    const last = await this.db.colourOption.findFirst({ orderBy: { position: 'desc' } });
    await this.db.colourOption.create({ data: { name, hex, hex2: hex2 ?? null, position: (last?.position ?? -1) + 1 } });
    await this.db.auditLog.create({ data: { action: 'colour.add', actorId, data: { name, hex, hex2: hex2 ?? null } } });
    return `✅ Added **${name}** (${hex2 ? `${hex} → ${hex2}` : hex}).`;
  }

  async editOption(name: string, changes: { name?: string; hex?: string; hex2?: string | null }, actorId: string): Promise<string> {
    const option = await this.db.colourOption.findUnique({ where: { name } });
    if (!option) return `❌ No colour called ${name}.`;
    if (changes.name && changes.name !== name && (await this.db.colourOption.findUnique({ where: { name: changes.name } }))) {
      return `❌ A colour called ${changes.name} already exists.`;
    }
    await this.db.colourOption.update({ where: { id: option.id }, data: changes });
    await this.db.auditLog.create({ data: { action: 'colour.edit', actorId, data: { name, ...changes } } });
    return `✅ Updated **${changes.name ?? name}**.`;
  }

  async removeOption(name: string, actorId: string): Promise<string> {
    const option = await this.db.colourOption.findUnique({ where: { name } });
    if (!option) return `❌ No colour called ${name}.`;
    // Deleting the role takes it off everyone; their saved pick is deleted with the option.
    if (option.roleId) {
      const role = this.client.guilds.cache.get(this.guildId)?.roles.cache.get(option.roleId);
      await role?.delete('VIP colour removed').catch((err: unknown) => this.log.warn({ err }, "couldn't delete colour role"));
    }
    await this.db.colourOption.delete({ where: { id: option.id } });
    await this.db.auditLog.create({ data: { action: 'colour.remove', actorId, data: { name } } });
    await this.modLog.post(`🎨 Colour **${name}** removed by <@${actorId}>`);
    return `✅ Removed **${name}**.`;
  }

  /** After add/edit: create or repair roles without a full /bot setup. */
  /** Replaces every colour with the default VIP gradients. Old colour roles are deleted; VIPs pick again. */
  async resetToDefaults(actorId: string): Promise<string> {
    for (const option of await this.options()) await this.removeOption(option.name, actorId);
    await this.db.colourOption.createMany({ data: DEFAULT_COLOURS.map((c, i) => ({ name: c.name, hex: c.hex, hex2: c.hex2 ?? null, position: i })) });
    await this.db.auditLog.create({ data: { action: 'colour.reset', actorId } });
    await this.modLog.post(`🎨 <@${actorId}> replaced the VIP colours with the default gradients`);
    return `✅ VIP colours are now: ${DEFAULT_COLOURS.map((c) => c.name).join(', ')}. VIPs need to pick a colour again.`;
  }

  async syncRoles(): Promise<string[]> {
    const report: string[] = [];
    const guild = this.client.guilds.cache.get(this.guildId);
    const vipRoleId = this.config.current.guild.vipRoleId;
    const vipRole = vipRoleId ? guild?.roles.cache.get(vipRoleId) : undefined;
    if (!guild || !vipRole) return ['ℹ️ Run /bot setup to create the colour roles.'];
    await this.setup(guild, vipRole, report);
    return report;
  }
}
