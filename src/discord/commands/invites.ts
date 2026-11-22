// Christmas invite event commands (docs/SPEC.md §8). /invites, /leaderboard and
// /invite-link are for everyone; /invite-event is staff (Manage Server).
import { AttachmentBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { InviteEventService } from '../../services/inviteEvent.js';
import { defineCommand, type AppContext } from './types.js';

const OFF = "🎄 There's no invite event running right now.";

/** Runs `fn` with the event service, or says the event isn't set up. */
async function withEvent(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext, fn: (events: InviteEventService) => Promise<void>): Promise<void> {
  if (!ctx.invites) return void (await interaction.editReply({ content: OFF }));
  await fn(ctx.invites);
}

export const invitesCommand = defineCommand({
  name: 'invites',
  description: 'How many valid invites you (or someone) have in the Christmas event',
  level: 'everyone',
  build: (b) => b.addUserOption((o) => o.setName('user').setDescription('Whose invites (default: yours)')),
  // Your own count is just for you; someone else's is shown in the channel.
  ephemeral: (i) => {
    const user = i.options.getUser('user');
    return !user || user.id === i.user.id;
  },
  execute: (interaction, ctx) =>
    withEvent(interaction, ctx, async (events) => {
      const user = interaction.options.getUser('user') ?? interaction.user;
      await interaction.editReply({ embeds: [await events.invitesOf(user.id)], allowedMentions: { parse: [] } });
    }),
});

export const leaderboardCommand = defineCommand({
  name: 'leaderboard',
  description: 'The Christmas invite event top 10',
  level: 'everyone',
  build: (b) => b,
  ephemeral: () => false,
  execute: (interaction, ctx) =>
    withEvent(interaction, ctx, async (events) => {
      await interaction.editReply({ embeds: [await events.leaderboard()], allowedMentions: { parse: [] } });
    }),
});

export const inviteLinkCommand = defineCommand({
  name: 'invite-link',
  description: 'Get your own permanent invite link: everyone who joins with it is credited to you',
  level: 'everyone',
  build: (b) => b,
  execute: (interaction, ctx) =>
    withEvent(interaction, ctx, async (events) => {
      await interaction.editReply({ content: await events.personalLink(interaction.member) });
    }),
});

const STATUS_CHOICES = [
  { name: 'valid (counts)', value: 'valid' },
  { name: 'invalid (never counts)', value: 'invalid' },
  { name: 'pending', value: 'pending' },
  { name: 'left', value: 'left' },
  { name: 'auto (back to the normal rules)', value: 'auto' },
];

export const inviteEventCommand = defineCommand({
  name: 'invite-event',
  description: 'Staff tools for the Christmas invite event',
  level: 'manage-server',
  build: (b) =>
    b
      .addSubcommand((s) =>
        s
          .setName('review')
          .setDescription("An inviter's invites, statuses and flags")
          .addUserOption((o) => o.setName('user').setDescription('The inviter').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('disqualify')
          .setDescription("None of this inviter's invites count")
          .addUserOption((o) => o.setName('user').setDescription('The inviter').setRequired(true))
          .addStringOption((o) => o.setName('reason').setDescription('Why (shown to staff only)').setRequired(true).setMaxLength(200)),
      )
      .addSubcommand((s) =>
        s
          .setName('reinstate')
          .setDescription('Undo a disqualification')
          .addUserOption((o) => o.setName('user').setDescription('The inviter').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('set-status')
          .setDescription("Decide one invite by hand (by the person who joined)")
          .addUserOption((o) => o.setName('invitee').setDescription('Who joined').setRequired(true))
          .addStringOption((o) =>
            o
              .setName('status')
              .setDescription('New status')
              .setRequired(true)
              .addChoices(...STATUS_CHOICES),
          )
          .addStringOption((o) => o.setName('reason').setDescription('Why (shown to staff only)').setMaxLength(200)),
      )
      .addSubcommand((s) => s.setName('raffle-export').setDescription('CSV for wheelofnames.com: one line per valid invite'))
      .addSubcommand((s) => s.setName('freeze').setDescription('Stop counting new joins now (happens by itself at the end)')),

  execute: (interaction, ctx) =>
    withEvent(interaction, ctx, async (events) => {
      const sub = interaction.options.getSubcommand();
      const actor = interaction.user.id;
      const reply = (text: string) => interaction.editReply({ content: text, allowedMentions: { parse: [] } });
      const off = events.disabledReason ? `\n\n⚠️ Invite tracking is off: ${events.disabledReason}.` : '';
      if (sub === 'review') return void (await reply((await events.review(interaction.options.getUser('user', true).id)) + off));
      if (sub === 'disqualify') return void (await reply(await events.disqualify(interaction.options.getUser('user', true).id, interaction.options.getString('reason', true), actor)));
      if (sub === 'reinstate') return void (await reply(await events.reinstate(interaction.options.getUser('user', true).id, actor)));
      if (sub === 'set-status') {
        return void (await reply(await events.setStatus(interaction.options.getUser('invitee', true).id, interaction.options.getString('status', true), interaction.options.getString('reason'), actor)));
      }
      if (sub === 'raffle-export') {
        const { csv, summary } = await events.raffleExport();
        return void (await interaction.editReply({ content: summary + off, files: [new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: 'raffle-entries.csv' })], allowedMentions: { parse: [] } }));
      }
      if (sub === 'freeze') return void (await reply(await events.freeze(actor)));
    }),
});
