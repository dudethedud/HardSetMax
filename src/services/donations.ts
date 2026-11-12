// Donations (docs/SPEC.md §7). Ko-fi posts each donation to the bot (webhookServer.ts);
// it's saved once (by Ko-fi's message ID), thanked publicly in the panel's channel,
// gives the Donor role when the donor's code links it to a member, updates the panel
// and is logged. Staff can add or remove donations by hand. The bot never handles
// payments itself, and never stores donor emails.
import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
  type Client,
  type Guild,
  type MessageCreateOptions,
  type Role,
  type SendableChannels,
} from 'discord.js';
import { donorLabel, donorRoleChanges, formatMoney, makeCode, parseKofi, progressBar, topDonors, type KofiDonation, type Tier } from '../core/donations.js';
import { fillEmojis } from '../core/emojiText.js';
import type { Db } from '../db/prisma.js';
import type { Donation, DonationSettings } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';
import { assignableRoleError } from './roleSafety.js';

export const DONATE_BUTTON_ID = 'donations:donate';
/** Both panel images together stay under Discord's upload limit for one message. */
export const PANEL_IMAGES_MAX_BYTES = 10 * 1024 * 1024;
export type BannerSlot = 'top' | 'bottom';

/** Soft blue, matching the server's blue emoji set and rules post. */
const BLUE = 0x8ec5ff;

export class DonationService {
  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly log: Logger,
    private readonly random: (n: number) => Uint8Array = (n) => randomBytes(n),
  ) {}

  #guild(): Guild | undefined {
    return this.client.guilds.cache.get(this.guildId);
  }

  /** Fills `{name|fallback}` with the server's emoji of that name (any case), or the fallback. */
  #emojis(text: string): string {
    const emojis = this.#guild()?.emojis.cache;
    return fillEmojis(text, (name) => emojis?.find((e) => e.name?.toLowerCase() === name.toLowerCase() && e.available !== false)?.toString() ?? null);
  }

  /** A server emoji for a button by name, or the fallback emoji. */
  #buttonEmoji(name: string, fallback: string): string | { id: string; name: string; animated: boolean } {
    const e = this.#guild()?.emojis.cache.find((x) => x.name?.toLowerCase() === name.toLowerCase() && x.available !== false);
    return e?.name ? { id: e.id, name: e.name, animated: e.animated ?? false } : fallback;
  }

  settings(): Promise<DonationSettings> {
    return this.db.donationSettings.upsert({ where: { guildId: this.guildId }, create: { guildId: this.guildId }, update: {} });
  }

  /** Donations in the current round (since the last /donations reset), newest first. */
  async #round(): Promise<{ settings: DonationSettings; donations: Donation[] }> {
    const settings = await this.settings();
    const donations = await this.db.donation.findMany({ where: { createdAt: { gte: settings.periodStart } }, orderBy: { createdAt: 'desc' } });
    return { settings, donations };
  }

  // ---- Ko-fi ----

  /** A Ko-fi webhook request. Returns the HTTP status to answer with. */
  async handleKofi(formBody: string, token: string): Promise<number> {
    const parsed = parseKofi(formBody, token);
    if (parsed.ok === 'ignored') {
      this.log.info({ reason: parsed.reason }, 'Ko-fi notification ignored');
      return 200;
    }
    if (!parsed.ok) {
      this.log.warn({ status: parsed.status, reason: parsed.reason }, 'Ko-fi webhook refused');
      return parsed.status;
    }
    await this.#recordKofi(parsed.donation);
    return 200;
  }

  async #recordKofi(d: KofiDonation): Promise<void> {
    const userId = d.code ? ((await this.db.donationCode.findUnique({ where: { code: d.code } }))?.userId ?? null) : null;
    // Ko-fi can send the same notification again: its message ID makes the second one a no-op.
    const { count } = await this.db.donation.createMany({
      data: [{ kofiId: d.kofiId, userId, displayName: d.displayName, amountCents: d.amountCents, currency: d.currency, isPublic: d.isPublic, source: 'kofi' }],
      skipDuplicates: true,
    });
    if (!count) {
      this.log.info({ kofiId: d.kofiId }, 'Ko-fi donation already recorded');
      return;
    }
    const donation = await this.db.donation.findUniqueOrThrow({ where: { kofiId: d.kofiId } });
    await this.#afterDonation(donation);
  }

  // ---- Members ----

  /** The Donate button: the member's code and the Ko-fi link, privately. */
  async donateReply(userId: string): Promise<Pick<MessageCreateOptions, 'content' | 'components'>> {
    const { kofiUrl } = await this.settings();
    if (!kofiUrl) return { content: this.#emojis('{animBlueHeart|💙} donations aren’t set up yet, ask an admin!') };
    const code = await this.codeFor(userId);
    return {
      content: this.#emojis(
        [
          `{animBlueHeart|💙} thank u for thinking of donating! ✧˚₊`,
          `{topbracket|╭} your code is **\`${code}\`**`,
          '{bluebracket|╰} paste it in the **message** box on ko-fi so we know it was u (u get the thank-you + donor role) {sparkle1|✦}',
          '-# wanna stay anonymous? leave the code out, or tick "make private" on ko-fi',
        ].join('\n'),
      ),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(kofiUrl).setLabel('donate on ko-fi').setEmoji(this.#buttonEmoji('animBlueHeart', '💙')),
        ),
      ],
    };
  }

  /** The member's code, made the first time they ask. */
  async codeFor(userId: string): Promise<string> {
    const existing = await this.db.donationCode.findUnique({ where: { userId } });
    if (existing) return existing.code;
    for (let i = 0; i < 10; i++) {
      const code = makeCode(this.random(4));
      const { count } = await this.db.donationCode.createMany({ data: [{ code, userId }], skipDuplicates: true });
      if (count) return code;
      // Taken by someone else, or this member got one in a parallel click.
      const mine = await this.db.donationCode.findUnique({ where: { userId } });
      if (mine) return mine.code;
    }
    throw new Error('could not make a unique donation code');
  }

  // ---- Admin ----

  async setup(channel: SendableChannels & { id: string }, kofiUrl: string): Promise<string> {
    if (!/^https:\/\/(www\.)?ko-fi\.com\/[A-Za-z0-9_]+\/?$/.test(kofiUrl)) return '❌ That doesn’t look like a Ko-fi page link (e.g. https://ko-fi.com/yourname).';
    const old = await this.settings();
    await this.db.donationSettings.update({ where: { guildId: this.guildId }, data: { kofiUrl, channelId: channel.id } });
    if (old.messageId && old.channelId && old.channelId !== channel.id) await this.#deletePanel(old);
    const posted = old.channelId === channel.id && old.messageId ? await this.refreshPanel() : await this.#postPanel(channel);
    return `✅ Donation panel ${posted} in <#${channel.id}>. Thank-yous are posted there too.`;
  }

  async setGoal(fundName: string | null, goalCents: number | null | undefined): Promise<string> {
    await this.settings();
    await this.db.donationSettings.update({
      where: { guildId: this.guildId },
      data: { ...(fundName ? { fundName } : {}), ...(goalCents !== undefined ? { goalCents: goalCents && goalCents > 0 ? goalCents : null } : {}) },
    });
    await this.refreshPanel();
    const s = await this.settings();
    return `✅ Fund: **${s.fundName}**${s.goalCents ? `, goal ${formatMoney(s.goalCents)}` : ', no goal (the panel shows the total raised)'}.`;
  }

  /** Sets (or with null, removes) the image at the top or bottom of the panel's box. */
  async setBanner(slot: BannerSlot, banner: { name: string; data: Buffer } | null): Promise<string> {
    if (!banner) {
      await this.db.donationBanner.deleteMany({ where: { slot } });
      await this.refreshPanel();
      return `✅ Removed the ${slot} image.`;
    }
    const other = await this.db.donationBanner.findFirst({ where: { slot: { not: slot } }, select: { data: true } });
    if (banner.data.length + (other?.data.length ?? 0) > PANEL_IMAGES_MAX_BYTES) {
      return `❌ Together the two images must be 10 MB or less (this one is ${(banner.data.length / 1e6).toFixed(1)} MB). Use a smaller GIF.`;
    }
    const name = `${slot}-${banner.name}`;
    await this.db.donationBanner.upsert({ where: { slot }, create: { slot, name, data: new Uint8Array(banner.data) }, update: { name, data: new Uint8Array(banner.data) } });
    const note = await this.refreshPanel();
    return `✅ Set the ${slot} image.${note === 'not set up' ? ' It shows once you run `/donations setup`.' : ' The panel is updated.'}`;
  }

  async setDonorRole(role: Role | null): Promise<string> {
    if (role) {
      const error = await assignableRoleError(role);
      if (error) return `❌ ${error}`;
      if (await this.db.donationTier.findUnique({ where: { roleId: role.id } })) return '❌ That role is a donor tier. Pick a different role for the base Donor role.';
    }
    await this.settings();
    await this.db.donationSettings.update({ where: { guildId: this.guildId }, data: { donorRoleId: role?.id ?? null } });
    const synced = await this.syncAll();
    await this.refreshPanel();
    return role ? `✅ Everyone who has donated gets ${role.toString()}.${synced}` : '✅ Donors no longer get a base role.';
  }

  // ---- Donor tiers ----

  tiers(): Promise<Tier[]> {
    return this.db.donationTier.findMany({ orderBy: { minCents: 'asc' } });
  }

  /** Adds or changes a tier: members whose lifetime total reaches `cents` wear it (only their highest tier). */
  async setTier(role: Role, cents: number): Promise<string> {
    const error = await assignableRoleError(role);
    if (error) return `❌ ${error}`;
    if ((await this.settings()).donorRoleId === role.id) return '❌ That’s the base Donor role. Tiers need their own roles.';
    const clash = await this.db.donationTier.findFirst({ where: { minCents: cents, roleId: { not: role.id } } });
    if (clash) return `❌ <@&${clash.roleId}> already starts at ${formatMoney(cents)}. Use a different amount.`;
    await this.db.donationTier.upsert({ where: { roleId: role.id }, create: { roleId: role.id, minCents: cents }, update: { minCents: cents } });
    const synced = await this.syncAll();
    await this.refreshPanel();
    return `✅ ${role.toString()} is the tier for **${formatMoney(cents)}+** donated in total.${synced}`;
  }

  /** Removes a tier and takes its role off everyone wearing it; they move to their next tier, if any. */
  async removeTier(roleId: string): Promise<string> {
    const { count } = await this.db.donationTier.deleteMany({ where: { roleId } });
    if (!count) return '❌ That role isn’t a donor tier.';
    const role = this.#guild()?.roles.cache.get(roleId);
    for (const member of role?.members.values() ?? []) await member.roles.remove(roleId, 'No longer a donor tier').catch(() => undefined);
    const synced = await this.syncAll();
    await this.refreshPanel();
    return `✅ <@&${roleId}> is no longer a donor tier and was taken off its members.${synced}`;
  }

  async listTiers(): Promise<string> {
    const [tiers, settings] = await Promise.all([this.tiers(), this.settings()]);
    const lines = [
      settings.donorRoleId ? `💙 Any donation: <@&${settings.donorRoleId}>` : '💙 No base Donor role (set one with `/donations donor-role`)',
      ...tiers.map((t) => `⭐ ${formatMoney(t.minCents)}+ in total: <@&${t.roleId}>`),
    ];
    return tiers.length ? lines.join('\n') : `${lines[0]}\nNo tiers yet: add one with \`/donations tier action:add role:@… amount:5\`.`;
  }

  /** Lifetime total for a member (every round, not just this one). */
  async #lifetime(userId: string): Promise<number> {
    const sum = await this.db.donation.aggregate({ where: { userId }, _sum: { amountCents: true } });
    return sum._sum.amountCents ?? 0;
  }

  /** Gives and takes the Donor role and tier roles to match the member's lifetime total. Returns what happened, for the log. */
  async syncMember(userId: string): Promise<string> {
    const guild = this.#guild();
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    if (!member) return 'not in the server';
    const [total, tiers, settings] = await Promise.all([this.#lifetime(userId), this.tiers(), this.settings()]);
    const { add, remove } = donorRoleChanges(new Set(member.roles.cache.keys()), total, settings.donorRoleId, tiers);
    if (!add.length && !remove.length) return settings.donorRoleId || tiers.length ? 'roles already up to date' : 'no donor roles set';
    try {
      if (remove.length) await member.roles.remove(remove, `Donor roles: ${formatMoney(total)} donated in total`);
      if (add.length) await member.roles.add(add, `Donor roles: ${formatMoney(total)} donated in total`);
    } catch (err) {
      this.log.warn({ err, userId }, "couldn't change donor roles");
      return "couldn't change roles (are they above the bot's role?)";
    }
    return [add.length ? `gave ${add.map((id) => `<@&${id}>`).join(', ')}` : '', remove.length ? `took ${remove.map((id) => `<@&${id}>`).join(', ')}` : ''].filter(Boolean).join(' · ');
  }

  /** After the donor role or tiers change: re-checks every member who has donated. Returns a note for the reply. */
  async syncAll(): Promise<string> {
    const donors = await this.db.donation.findMany({ where: { userId: { not: null } }, distinct: ['userId'], select: { userId: true } });
    for (const d of donors) await this.syncMember(d.userId!);
    return donors.length ? ` Checked roles for ${donors.length} donor(s).` : '';
  }

  async addManual(userId: string, cents: number, actorId: string): Promise<string> {
    const member = await this.#guild()?.members.fetch(userId).catch(() => null);
    const donation = await this.db.donation.create({
      data: { userId, displayName: member?.displayName ?? 'Member', amountCents: cents, currency: 'USD', isPublic: true, source: 'manual', addedBy: actorId },
    });
    await this.#afterDonation(donation, actorId);
    return `✅ Added ${formatMoney(cents)} from <@${userId}> (donation #${donation.id}).`;
  }

  async remove(id: number, actorId: string): Promise<string> {
    const donation = await this.db.donation.findUnique({ where: { id } });
    if (!donation) return '❌ No donation with that number. See `/donations list`.';
    await this.db.donation.delete({ where: { id } });
    // Their total went down: they may drop a tier, or lose the Donor role.
    if (donation.userId) await this.syncMember(donation.userId);
    await this.refreshPanel();
    await this.#log(
      new EmbedBuilder()
        .setColor(0x99aab5)
        .setTitle('🗑️ Donation removed')
        .setDescription(`Donation #${id} (${formatMoney(donation.amountCents, donation.currency)} from ${donorLabel(donation)}) was removed by <@${actorId}>.`)
        .setTimestamp(new Date()),
    );
    return `✅ Removed donation #${id}.`;
  }

  async list(): Promise<string> {
    const { settings, donations } = await this.#round();
    if (!donations.length) return `No donations in this round of **${settings.fundName}** yet.`;
    const total = donations.reduce((s, d) => s + d.amountCents, 0);
    const lines = donations.slice(0, 25).map((d) => `#${d.id} · ${formatMoney(d.amountCents, d.currency)} · ${donorLabel(d)}${d.isPublic ? '' : ' (private)'} · ${d.source} · <t:${Math.floor(d.createdAt.getTime() / 1000)}:R>`);
    return [`**${settings.fundName}**: ${formatMoney(total)} from ${donations.length} donation(s) this round.`, ...lines].join('\n').slice(0, 1900);
  }

  /** Starts a new round: totals and leaderboards start from 0. Old donations are kept. */
  async reset(actorId: string): Promise<string> {
    await this.settings();
    await this.db.donationSettings.update({ where: { guildId: this.guildId }, data: { periodStart: new Date() } });
    await this.refreshPanel();
    await this.#log(new EmbedBuilder().setColor(0x99aab5).setTitle('🔄 Donation round reset').setDescription(`<@${actorId}> started a new round. Totals start from $0.00.`).setTimestamp(new Date()));
    return '✅ New round started: the panel’s total and top donors start from $0.00. Past donations are still in the history.';
  }

  // ---- After a donation ----

  async #afterDonation(donation: Donation, actorId?: string): Promise<void> {
    const settings = await this.settings();
    // Thank-you in the panel's channel. Only the donor is pinged.
    if (settings.channelId) {
      const channel = await this.client.channels.fetch(settings.channelId).catch(() => null);
      if (channel?.isSendable()) {
        await channel
          .send({
            content: this.#emojis(
              `{animBlueHeart|💙} ${donorLabel(donation)} donated **${formatMoney(donation.amountCents, donation.currency)}** to the **${settings.fundName.toLowerCase()}**! thank u sm ✧˚₊ {animBlueStar|✦}`,
            ),
            allowedMentions: { users: donation.isPublic && donation.userId ? [donation.userId] : [] },
          })
          .catch((err: unknown) => this.log.warn({ err }, "couldn't post the donation thank-you"));
      }
    }
    // The Donor role and tier roles, when the donation is linked to a member.
    const role = donation.userId ? await this.syncMember(donation.userId) : 'no roles (not linked to a member)';
    await this.refreshPanel();
    await this.#log(
      new EmbedBuilder()
        .setColor(BLUE)
        .setTitle('💙 Donation')
        .setDescription(`${donorLabel(donation)} donated **${formatMoney(donation.amountCents, donation.currency)}**.`)
        .addFields(
          { name: 'Source', value: donation.source === 'kofi' ? `Ko-fi${donation.isPublic ? '' : ' (private)'}` : `Added by <@${actorId ?? donation.addedBy}>`, inline: true },
          { name: 'Ko-fi name', value: donation.displayName.slice(0, 100), inline: true },
          { name: 'Roles', value: role.slice(0, 1024), inline: true },
        )
        .setFooter({ text: `Donation #${donation.id}` })
        .setTimestamp(donation.createdAt),
    );
  }

  // ---- The panel ----

  async render(): Promise<Pick<MessageCreateOptions, 'components' | 'files' | 'flags'>> {
    const { settings, donations } = await this.#round();
    const banners = await this.db.donationBanner.findMany();
    const tiers = await this.tiers();
    // What donating unlocks: the Donor role, then each tier (role mentions show in colour; nobody is pinged).
    const perks = [
      ...(settings.donorRoleId ? [`{blue_flower|🌸} any donation · <@&${settings.donorRoleId}>`] : []),
      ...tiers.map((t) => `{animBlueStar|⭐} ${formatMoney(t.minCents)}+ · <@&${t.roleId}>`),
    ];
    const image = (slot: BannerSlot) => banners.find((b) => b.slot === slot);
    const gallery = (slot: BannerSlot) => {
      const b = image(slot);
      return b ? new MediaGalleryBuilder().addItems((i) => i.setURL(`attachment://${b.name}`)) : null;
    };
    const total = donations.reduce((s, d) => s + d.amountCents, 0);
    const top = topDonors(donations);
    const recent = donations.slice(0, 5).map((d) => `{blue_arrow|➤} ${donorLabel(d)} · ${formatMoney(d.amountCents, d.currency)} · <t:${Math.floor(d.createdAt.getTime() / 1000)}:R>`);
    const raised = settings.goalCents
      ? `{topbracket|╭} **${formatMoney(total)}** raised of **${formatMoney(settings.goalCents)}**\n{bluebracket|╰} ${progressBar(total, settings.goalCents)} {sparkle1|✦}`
      : `{topbracket|╭} **${formatMoney(total)}** raised so far\n{bluebracket|╰} thank u for supporting soft hearts {sparkle1|✦}`;
    // Places 1–5 use the server's blue number pills.
    const place = (i: number) => `{blue_${i + 1}|${['🥇', '🥈', '🥉', '4.', '5.'][i]}}`;
    const box = new ContainerBuilder().setAccentColor(BLUE);
    // Like the rules post: an image at the top of the box, and a strip at the bottom.
    const topImage = gallery('top');
    if (topImage) box.addMediaGalleryComponents(topImage);
    box
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(this.#emojis(`## {animBlueHeart|💙} ⁀ ${settings.fundName.toLowerCase()} ⁀ {animBlueHeart|💙}`)))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# every donation goes to server giveaways ✧˚₊'))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(this.#emojis(raised)))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          this.#emojis(
            [
              ...(perks.length ? ['{blue_ice|💎} **perks**', ...perks, ''] : []),
              '{blue_bow|🎀} **top donors**',
              ...(top.length ? top.map((t, i) => `${place(i)} ${t.label} · ${formatMoney(t.cents)}`) : ['-# be the first! ✧']),
              '',
              '{blueAnimButterfly|🦋} **recent**',
              ...(recent.length ? recent : ['-# no donations yet ✧']),
            ].join('\n'),
          ),
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(DONATE_BUTTON_ID).setLabel('donate').setEmoji(this.#buttonEmoji('animBlueHeart', '💙')).setStyle(ButtonStyle.Primary),
        ),
      );
    const bottomImage = gallery('bottom');
    if (bottomImage) box.addMediaGalleryComponents(bottomImage);
    const files = banners.map((b) => new AttachmentBuilder(Buffer.from(b.data), { name: b.name }));
    return { components: [box], files, flags: MessageFlags.IsComponentsV2 };
  }

  async #postPanel(channel: SendableChannels): Promise<string> {
    const message = await channel.send({ ...(await this.render()), allowedMentions: { parse: [] } });
    await this.db.donationSettings.update({ where: { guildId: this.guildId }, data: { messageId: message.id } });
    return 'posted';
  }

  /** Re-renders the panel in place, re-posting it if it was deleted. Returns what happened. */
  async refreshPanel(): Promise<string> {
    const s = await this.settings();
    if (!s.channelId) return 'not set up';
    const channel = await this.client.channels.fetch(s.channelId).catch(() => null);
    if (!channel?.isSendable() || !('messages' in channel)) return 'channel missing';
    const message = s.messageId ? await channel.messages.fetch(s.messageId).catch(() => null) : null;
    if (!message) return this.#postPanel(channel);
    const content = await this.render();
    // The images are sent again each time (attachments: [] drops the old copies), so the panel always shows the current ones.
    await message.edit({ components: content.components, files: content.files, attachments: [], allowedMentions: { parse: [] } });
    return 'updated';
  }

  async #deletePanel(s: DonationSettings): Promise<void> {
    if (!s.channelId || !s.messageId) return;
    const channel = await this.client.channels.fetch(s.channelId).catch(() => null);
    if (channel && 'messages' in channel) await (await channel.messages.fetch(s.messageId).catch(() => null))?.delete().catch(() => undefined);
  }

  async #log(embed: EmbedBuilder): Promise<void> {
    const settings = await this.db.settings.findUnique({ where: { guildId: this.guildId } });
    if (!settings?.logChannelId) return;
    const channel = await this.client.channels.fetch(settings.logChannelId).catch(() => null);
    if (channel?.isSendable()) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err: unknown) => this.log.warn({ err }, "couldn't post to the log channel"));
  }
}
