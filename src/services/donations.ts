// Donations (docs/SPEC.md §7). Ko-fi posts each donation to the bot (webhookServer.ts);
// it's saved once (by Ko-fi's message ID), thanked publicly in the panel's channel,
// gives the Donor role when the donor's code links it to a member, updates the panel
// and is logged. Staff can add or remove donations by hand. The bot never handles
// payments itself, and never stores donor emails.
import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
  type Client,
  type Guild,
  type MessageCreateOptions,
  type SendableChannels,
} from 'discord.js';
import { donorLabel, formatMoney, makeCode, parseKofi, progressBar, topDonors, type KofiDonation } from '../core/donations.js';
import type { Db } from '../db/prisma.js';
import type { Donation, DonationSettings } from '../generated/prisma/client.js';
import type { Logger } from '../logger.js';

export const DONATE_BUTTON_ID = 'donations:donate';

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
    if (!kofiUrl) return { content: '💖 Donations aren’t set up yet. Ask an admin.' };
    const code = await this.codeFor(userId);
    return {
      content: [
        `💖 Thank you for thinking of donating! Your code is **\`${code}\`**.`,
        'Paste it into the **message** box on Ko-fi so the bot knows it was you, and you get the thank-you and the donor role.',
        '-# Want to stay anonymous? Leave the code out, or tick "make private" on Ko-fi.',
      ].join('\n'),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(kofiUrl).setLabel('Donate on Ko-fi').setEmoji('💖'))],
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

  async setDonorRole(roleId: string | null): Promise<string> {
    await this.settings();
    await this.db.donationSettings.update({ where: { guildId: this.guildId }, data: { donorRoleId: roleId } });
    return roleId ? `✅ Donors linked to their Discord account get <@&${roleId}>.` : '✅ Donors no longer get a role.';
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
    const guild = this.#guild();
    // Thank-you in the panel's channel. Only the donor is pinged.
    if (settings.channelId) {
      const channel = await this.client.channels.fetch(settings.channelId).catch(() => null);
      if (channel?.isSendable()) {
        await channel
          .send({
            content: `💖 ${donorLabel(donation)} donated **${formatMoney(donation.amountCents, donation.currency)}** to the **${settings.fundName}**! Thank you so much!`,
            allowedMentions: { users: donation.isPublic && donation.userId ? [donation.userId] : [] },
          })
          .catch((err: unknown) => this.log.warn({ err }, "couldn't post the donation thank-you"));
      }
    }
    // The Donor role, when the donation is linked to a member.
    let role = 'no role (not linked to a member)';
    if (settings.donorRoleId && donation.userId && guild) {
      const member = await guild.members.fetch(donation.userId).catch(() => null);
      if (!member) role = 'not in the server';
      else if (member.roles.cache.has(settings.donorRoleId)) role = 'already had the role';
      else {
        role = await member.roles
          .add(settings.donorRoleId, `Donated ${formatMoney(donation.amountCents)}`)
          .then(() => `gave <@&${settings.donorRoleId}>`)
          .catch((err: unknown) => {
            this.log.warn({ err }, "couldn't give the donor role");
            return "couldn't give the role (is it above the bot's role?)";
          });
      }
    } else if (!settings.donorRoleId) role = 'no donor role set';
    await this.refreshPanel();
    await this.#log(
      new EmbedBuilder()
        .setColor(0xff5fa2)
        .setTitle('💖 Donation')
        .setDescription(`${donorLabel(donation)} donated **${formatMoney(donation.amountCents, donation.currency)}**.`)
        .addFields(
          { name: 'Source', value: donation.source === 'kofi' ? `Ko-fi${donation.isPublic ? '' : ' (private)'}` : `Added by <@${actorId ?? donation.addedBy}>`, inline: true },
          { name: 'Ko-fi name', value: donation.displayName.slice(0, 100), inline: true },
          { name: 'Donor role', value: role, inline: true },
        )
        .setFooter({ text: `Donation #${donation.id}` })
        .setTimestamp(donation.createdAt),
    );
  }

  // ---- The panel ----

  async render(): Promise<Pick<MessageCreateOptions, 'components' | 'flags'>> {
    const { settings, donations } = await this.#round();
    const total = donations.reduce((s, d) => s + d.amountCents, 0);
    const top = topDonors(donations);
    const recent = donations.slice(0, 5).map((d) => `${donorLabel(d)} · ${formatMoney(d.amountCents, d.currency)} · <t:${Math.floor(d.createdAt.getTime() / 1000)}:R>`);
    const raised = settings.goalCents
      ? `**${formatMoney(total)}** raised of **${formatMoney(settings.goalCents)}**\n${progressBar(total, settings.goalCents)}`
      : `**${formatMoney(total)}** raised so far`;
    const box = new ContainerBuilder()
      .setAccentColor(0xff8fc7)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 💖 __${settings.fundName}__`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('Every donation goes towards server giveaways. Thank you for supporting the server! 🎁'))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(raised))
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            '**🏆 Top donors**',
            ...(top.length ? top.map((t, i) => `${['🥇', '🥈', '🥉'][i] ?? `${i + 1}.`} ${t.label} · ${formatMoney(t.cents)}`) : ['Be the first!']),
            '',
            '**🕒 Recent**',
            ...(recent.length ? recent : ['No donations yet.']),
          ].join('\n'),
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(DONATE_BUTTON_ID).setLabel('Donate').setEmoji('💖').setStyle(ButtonStyle.Primary)),
      );
    return { components: [box], flags: MessageFlags.IsComponentsV2 };
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
    await message.edit({ components: (await this.render()).components, allowedMentions: { parse: [] } });
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
