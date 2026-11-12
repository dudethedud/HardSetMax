// /donations: admins set up the donation panel and fix donations by hand.
import { ChannelType } from 'discord.js';
import { downloadBanner } from '../../services/banner.js';
import { defineCommand } from './types.js';

export const donationsCommand = defineCommand({
  name: 'donations',
  description: 'The donation panel (Ko-fi)',
  level: 'admin',
  build: (b) =>
    b
      .addSubcommand((s) =>
        s
          .setName('setup')
          .setDescription('Post (or move) the donation panel')
          .addChannelOption((o) => o.setName('channel').setDescription('Where the panel and thank-yous go').addChannelTypes(ChannelType.GuildText).setRequired(true))
          .addStringOption((o) => o.setName('kofi-url').setDescription('Your Ko-fi page, e.g. https://ko-fi.com/yourname').setRequired(true).setMaxLength(100)),
      )
      .addSubcommand((s) =>
        s
          .setName('goal')
          .setDescription('Name the fund and set an optional goal')
          .addStringOption((o) => o.setName('name').setDescription('e.g. Giveaway fund').setMaxLength(40))
          .addNumberOption((o) => o.setName('amount').setDescription('Goal in USD (0 = no goal, just show the total)').setMinValue(0).setMaxValue(100000)),
      )
      .addSubcommand((s) =>
        s
          .setName('banner')
          .setDescription('A GIF or image inside the panel, at the top or bottom (leave the image out to remove it)')
          .addStringOption((o) =>
            o
              .setName('where')
              .setDescription('Top or bottom of the panel')
              .setRequired(true)
              .addChoices({ name: 'top (big banner)', value: 'top' }, { name: 'bottom (thin strip)', value: 'bottom' }),
          )
          .addAttachmentOption((o) => o.setName('image').setDescription('PNG, JPG, GIF or WebP, up to 8 MB')),
      )
      .addSubcommand((s) =>
        s
          .setName('donor-role')
          .setDescription('Role for donors linked to their Discord account (leave empty for none)')
          .addRoleOption((o) => o.setName('role').setDescription('The donor role')),
      )
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Add a donation by hand (e.g. one not made through Ko-fi)')
          .addUserOption((o) => o.setName('user').setDescription('Who donated').setRequired(true))
          .addNumberOption((o) => o.setName('amount').setDescription('Amount in USD').setRequired(true).setMinValue(0.01).setMaxValue(100000)),
      )
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Remove a donation (its number is in /donations list)')
          .addIntegerOption((o) => o.setName('number').setDescription('Donation number').setRequired(true).setMinValue(1)),
      )
      .addSubcommand((s) => s.setName('list').setDescription('Donations this round, with their numbers'))
      .addSubcommand((s) => s.setName('reset').setDescription('Start a new round: totals start from $0 (history is kept)')),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const reply = (text: string) => interaction.editReply({ content: text, allowedMentions: { parse: [] } });
    const actor = interaction.user.id;
    if (sub === 'setup') {
      const channel = interaction.options.getChannel('channel', true, [ChannelType.GuildText]);
      return void (await reply(await ctx.donations.setup(channel, interaction.options.getString('kofi-url', true).trim())));
    }
    if (sub === 'goal') {
      const amount = interaction.options.getNumber('amount');
      return void (await reply(await ctx.donations.setGoal(interaction.options.getString('name')?.trim() || null, amount === null ? undefined : Math.round(amount * 100))));
    }
    if (sub === 'banner') {
      const where = interaction.options.getString('where', true) === 'bottom' ? 'bottom' : 'top';
      const file = interaction.options.getAttachment('image');
      if (!file) return void (await reply(await ctx.donations.setBanner(where, null)));
      const got = await downloadBanner(file.url, file.size);
      return void (await reply(got.ok ? await ctx.donations.setBanner(where, got.banner) : `❌ ${got.error}`));
    }
    if (sub === 'donor-role') return void (await reply(await ctx.donations.setDonorRole(interaction.options.getRole('role')?.id ?? null)));
    if (sub === 'add') {
      return void (await reply(await ctx.donations.addManual(interaction.options.getUser('user', true).id, Math.round(interaction.options.getNumber('amount', true) * 100), actor)));
    }
    if (sub === 'remove') return void (await reply(await ctx.donations.remove(interaction.options.getInteger('number', true), actor)));
    if (sub === 'list') return void (await reply(await ctx.donations.list()));
    if (sub === 'reset') return void (await reply(await ctx.donations.reset(actor)));
  },
});
