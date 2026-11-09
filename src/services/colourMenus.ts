// Colour menus (docs/SPEC.md). Admins build menus of existing colour roles; each
// menu is one message (a banner, a heading, the roles and a dropdown). Reppers,
// members with any unlock role, pick one colour across all menus. When someone
// loses their last unlock role, the bot takes their menu colour off: right away
// on the role change, and again in a sweep at startup and every hour in case
// Discord missed an event. The database is the source of truth for menus.
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ContainerBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  type Client,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type Role,
  type SendableChannels,
} from 'discord.js';
import { colourRoleError, coloursToStrip, isRepper, MAX_COLOURS_PER_MENU, NO_COLOUR, rolesAfterPick } from '../core/colours.js';
import type { Db } from '../db/prisma.js';
import type { ColourMenu, MenuColour } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';

export const MENU_SELECT_PREFIX = 'colours:menu:';
export const REP_MESSAGE = '🎨 Colours are for server reppers! Wear the server tag or put **.gg/femboii** in your status, then pick again.';

/** Permissions a colour role must never carry: a menu would hand them to anyone. */
const DANGEROUS = new PermissionsBitField([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ViewAuditLog,
]).bitfield;

export type MenuWithColours = ColourMenu & { colours: MenuColour[] };
export interface Banner {
  name: string;
  data: Buffer;
}

export class ColourMenuService {
  #unlock = new Set<string>();
  #colourRoles = new Set<string>();

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  #guild(): Guild | undefined {
    return this.client.guilds.cache.get(this.guildId);
  }

  /** Reloads the role lists used on every member update. */
  async load(): Promise<void> {
    const [unlock, colours] = await Promise.all([this.db.unlockRole.findMany(), this.db.menuColour.findMany()]);
    this.#unlock = new Set(unlock.map((u) => u.roleId));
    this.#colourRoles = new Set(colours.map((c) => c.roleId));
  }

  get unlockRoleIds(): ReadonlySet<string> {
    return this.#unlock;
  }

  menus(): Promise<MenuWithColours[]> {
    return this.db.colourMenu.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }], include: { colours: { orderBy: { position: 'asc' } } } });
  }

  // ---- Admin: menus ----

  async createMenu(title: string, emoji: string | null, banner: Banner | null): Promise<string> {
    const last = await this.db.colourMenu.findFirst({ orderBy: { position: 'desc' } });
    const menu = await this.db.colourMenu.create({
      data: { title, emoji, banner: banner ? new Uint8Array(banner.data) : null, bannerName: banner?.name ?? null, position: (last?.position ?? -1) + 1 },
    });
    return `✅ Made the menu **${menu.title}**. Add colours with \`/colours menu add-role\`, then \`/colours post\`.`;
  }

  async editMenu(id: number, change: { title?: string; emoji?: string | null; banner?: Banner | null; position?: number }): Promise<string> {
    const menu = await this.db.colourMenu.findUnique({ where: { id } });
    if (!menu) return '❌ That menu no longer exists.';
    await this.db.colourMenu.update({
      where: { id },
      data: {
        ...(change.title !== undefined ? { title: change.title } : {}),
        ...(change.emoji !== undefined ? { emoji: change.emoji } : {}),
        ...(change.position !== undefined ? { position: change.position } : {}),
        ...(change.banner !== undefined ? { banner: change.banner ? new Uint8Array(change.banner.data) : null, bannerName: change.banner?.name ?? null } : {}),
      },
    });
    const note = await this.refresh(id);
    return `✅ Updated **${change.title ?? menu.title}**.${note}${change.position !== undefined ? ' Run `/colours post fresh:true` to post the menus in the new order.' : ''}`;
  }

  async deleteMenu(id: number): Promise<string> {
    const menu = await this.db.colourMenu.findUnique({ where: { id } });
    if (!menu) return '❌ That menu no longer exists.';
    await this.#deleteMessage(menu);
    await this.db.colourMenu.delete({ where: { id } });
    await this.load();
    return `🗑️ Deleted **${menu.title}** and its message. Members keep the colours they're wearing until they pick another.`;
  }

  async addColour(menuId: number, role: Role): Promise<string> {
    const guild = role.guild;
    const menu = await this.db.colourMenu.findUnique({ where: { id: menuId }, include: { colours: true } });
    if (!menu) return '❌ That menu no longer exists.';
    const botTop = (guild.members.me ?? (await guild.members.fetchMe())).roles.highest;
    const error = colourRoleError({
      id: role.id,
      everyoneId: guild.id,
      managed: role.managed,
      belowBot: role.position < botTop.position,
      dangerous: (role.permissions.bitfield & DANGEROUS) !== 0n,
    });
    if (error) return `❌ ${error}`;
    if (this.#unlock.has(role.id)) return "❌ That's an unlock role, not a colour.";
    const existing = await this.db.menuColour.findUnique({ where: { roleId: role.id }, include: { menu: true } });
    if (existing) return `❌ ${role.toString()} is already in **${existing.menu.title}**.`;
    if (menu.colours.length >= MAX_COLOURS_PER_MENU) return `❌ A menu holds at most ${MAX_COLOURS_PER_MENU} colours. Make another menu.`;
    const position = Math.max(-1, ...menu.colours.map((c) => c.position)) + 1;
    await this.db.menuColour.create({ data: { roleId: role.id, menuId, position } });
    await this.load();
    return `✅ Added ${role.toString()} to **${menu.title}**.${await this.refresh(menuId)}`;
  }

  async removeColour(roleId: string): Promise<string> {
    const colour = await this.db.menuColour.findUnique({ where: { roleId }, include: { menu: true } });
    if (!colour) return '❌ That role isn’t in any menu.';
    await this.db.menuColour.delete({ where: { roleId } });
    await this.load();
    return `✅ Removed <@&${roleId}> from **${colour.menu.title}**. People wearing it keep it until they pick another.${await this.refresh(colour.menuId)}`;
  }

  // ---- Admin: unlock roles and the log channel ----

  async addUnlockRole(role: Role): Promise<string> {
    if (role.id === role.guild.id) return '❌ @everyone would unlock colours for everyone.';
    if (this.#colourRoles.has(role.id)) return "❌ That's a colour role in a menu.";
    await this.db.unlockRole.upsert({ where: { roleId: role.id }, create: { roleId: role.id }, update: {} });
    await this.load();
    return `✅ ${role.toString()} now unlocks the colour menus.`;
  }

  async removeUnlockRole(roleId: string): Promise<string> {
    const { count } = await this.db.unlockRole.deleteMany({ where: { roleId } });
    if (!count) return '❌ That role doesn’t unlock colours.';
    await this.load();
    const guild = this.#guild();
    const stripped = guild ? await this.sweep(guild) : 0;
    return `✅ <@&${roleId}> no longer unlocks colours.${stripped ? ` Took colours off ${stripped} member(s) who don't have another unlock role.` : ''}`;
  }

  async setLogChannel(channelId: string | null): Promise<string> {
    await this.db.settings.upsert({ where: { guildId: this.guildId }, create: { guildId: this.guildId, logChannelId: channelId }, update: { logChannelId: channelId } });
    return channelId ? `✅ Colour removals are logged in <#${channelId}>.` : '✅ Colour removals are no longer logged.';
  }

  // ---- Posting ----

  /** The menu message: the banner, then a box with the heading, the roles and the dropdown. */
  render(menu: MenuWithColours, guild: Guild): Pick<MessageCreateOptions, 'components' | 'files' | 'flags'> {
    const roles = menu.colours.map((c) => guild.roles.cache.get(c.roleId)).filter((r): r is Role => !!r);
    const select = new StringSelectMenuBuilder()
      .setCustomId(MENU_SELECT_PREFIX + menu.id)
      .setPlaceholder('Make a selection')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        ...roles.map((r) => new StringSelectMenuOptionBuilder().setLabel(r.name.slice(0, 100)).setValue(r.id)),
        new StringSelectMenuOptionBuilder().setLabel('Remove colour').setValue(NO_COLOUR).setEmoji('✖️'),
      );
    const box = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${menu.emoji ? `${menu.emoji} ` : ''}__${menu.title}__`))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([...roles.map((r) => r.toString()), '╰ Max Selection: **1**'].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    const banner = menu.banner && menu.bannerName ? new AttachmentBuilder(Buffer.from(menu.banner), { name: menu.bannerName }) : null;
    const gallery = banner ? [new MediaGalleryBuilder().addItems((i) => i.setURL(`attachment://${menu.bannerName}`))] : [];
    return { components: [...gallery, box], files: banner ? [banner] : [], flags: MessageFlags.IsComponentsV2 };
  }

  /** Posts every menu in `channel` in order, editing ones already there. `fresh` reposts them all. */
  async post(channel: SendableChannels & { id: string }, fresh: boolean): Promise<string> {
    const guild = this.#guild();
    if (!guild) return '❌ The bot is not in the server.';
    const menus = await this.menus();
    if (!menus.length) return '❌ No menus yet. Make one with `/colours menu create`.';
    if (fresh) for (const m of menus) await this.#deleteMessage(m);
    let posted = 0;
    let edited = 0;
    for (const menu of menus) {
      const message = !fresh && menu.channelId === channel.id ? await this.#fetchMessage(menu) : null;
      const content = this.render(menu, guild);
      if (message) {
        await message.edit({ components: content.components, files: content.files, attachments: [], allowedMentions: { parse: [] } });
        edited++;
        continue;
      }
      if (!fresh) await this.#deleteMessage(menu); // it moved channels
      const sent = await channel.send({ ...content, allowedMentions: { parse: [] } });
      await this.db.colourMenu.update({ where: { id: menu.id }, data: { channelId: channel.id, messageId: sent.id } });
      posted++;
    }
    return `✅ Menus in <#${channel.id}>: ${posted} posted, ${edited} updated.`;
  }

  /** Re-renders a menu's message in place, if it's posted. Returns a note for the reply. */
  async refresh(menuId: number): Promise<string> {
    const guild = this.#guild();
    const menu = await this.db.colourMenu.findUnique({ where: { id: menuId }, include: { colours: { orderBy: { position: 'asc' } } } });
    if (!guild || !menu?.messageId) return '';
    const message = await this.#fetchMessage(menu);
    if (!message) return ' Its message is gone: run `/colours post` to post it again.';
    const content = this.render(menu, guild);
    await message.edit({ components: content.components, files: content.files, attachments: [], allowedMentions: { parse: [] } });
    return ' The posted menu is updated.';
  }

  async #fetchMessage(menu: ColourMenu) {
    if (!menu.channelId || !menu.messageId) return null;
    const channel = await this.client.channels.fetch(menu.channelId).catch(() => null);
    if (!channel?.isTextBased() || !('messages' in channel)) return null;
    return channel.messages.fetch(menu.messageId).catch(() => null);
  }

  async #deleteMessage(menu: ColourMenu): Promise<void> {
    const message = await this.#fetchMessage(menu);
    await message?.delete().catch(() => undefined);
    if (menu.messageId) await this.db.colourMenu.update({ where: { id: menu.id }, data: { channelId: null, messageId: null } }).catch(() => undefined);
  }

  // ---- Members ----

  /** A member picked from a menu's dropdown. Returns the private reply. */
  async pick(member: GuildMember, menuId: number, value: string): Promise<string> {
    if (this.#unlock.size === 0) return '🎨 Colours aren’t set up yet. Ask an admin.';
    const roleIds = [...member.roles.cache.keys()];
    if (!isRepper(new Set(roleIds), this.#unlock)) return REP_MESSAGE;
    let picked: Role | null = null;
    if (value !== NO_COLOUR) {
      const colour = await this.db.menuColour.findUnique({ where: { roleId: value } });
      picked = member.guild.roles.cache.get(value) ?? null;
      if (colour?.menuId !== menuId || !picked) return '❌ That colour isn’t available any more. Pick another.';
    }
    const next = rolesAfterPick(roleIds, this.#colourRoles, picked?.id ?? null);
    if (picked && member.roles.cache.has(picked.id) && next.length === roleIds.length) return `🎨 You're already wearing ${picked.toString()}.`;
    try {
      await member.roles.set(next, picked ? `Colour menu: ${picked.name}` : 'Colour menu: removed colour');
    } catch (err) {
      this.log.warn({ err, userId: member.id }, "couldn't change colour roles");
      return "❌ Couldn't change your colour. The bot's role may be below the colour roles: tell an admin.";
    }
    return picked ? `🎨 You're now ${picked.toString()}!` : '🎨 Your colour was removed.';
  }

  /** Member update: takes menu colours off anyone who no longer reps the server. */
  async check(member: GuildMember): Promise<number> {
    if (member.guild.id !== this.guildId || member.user.bot) return 0;
    const strip = coloursToStrip(new Set(member.roles.cache.keys()), this.#unlock, this.#colourRoles);
    if (!strip.length) return 0;
    try {
      await member.roles.remove(strip, 'Colour menu: no longer reps the server');
    } catch (err) {
      this.log.warn({ err, userId: member.id }, "couldn't remove colour roles");
      return 0;
    }
    await this.#log(`🎨 Took ${strip.map((id) => `<@&${id}>`).join(', ')} off <@${member.id}>: they no longer rep the server.`);
    return 1;
  }

  /** Startup and hourly: checks every member, in case Discord missed a role change. Returns how many were fixed. */
  async sweep(guild: Guild): Promise<number> {
    if (this.#unlock.size === 0 || this.#colourRoles.size === 0) return 0;
    const members = await guild.members.fetch();
    let fixed = 0;
    for (const member of members.values()) fixed += await this.check(member);
    if (fixed) this.log.info({ fixed }, 'colour sweep removed colours');
    return fixed;
  }

  async #log(text: string): Promise<void> {
    const settings = await this.db.settings.findUnique({ where: { guildId: this.guildId } });
    if (!settings?.logChannelId) return;
    const channel = await this.client.channels.fetch(settings.logChannelId).catch(() => null);
    if (channel?.isSendable()) await channel.send({ content: text, allowedMentions: { parse: [] } }).catch((err: unknown) => this.log.warn({ err }, "couldn't post to the log channel"));
  }
}
