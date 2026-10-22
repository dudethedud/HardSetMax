import { userMention } from 'discord.js';
import { normalizeRoleName } from '../../core/crown.js';
import { defineAdminCommand } from './types.js';

export const crownCommand = defineAdminCommand(
  'crown',
  'Crown of the week and custom roles',
  (b) =>
    b
      .addSubcommand((s) => s.setName('view').setDescription('Current Crown holder and their custom role'))
      .addSubcommand((s) =>
        s
          .setName('reset-role')
          .setDescription('Delete a custom role and clear its saved settings')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('lock')
          .setDescription('Block someone from creating or editing a custom role')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('unlock')
          .setDescription('Allow custom roles again')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommandGroup((g) =>
        g
          .setName('blocked-words')
          .setDescription('Words custom role names can’t contain')
          .addSubcommand((s) =>
            s
              .setName('add')
              .setDescription('Block a word')
              .addStringOption((o) => o.setName('word').setDescription('Word').setRequired(true).setMaxLength(50)),
          )
          .addSubcommand((s) =>
            s
              .setName('remove')
              .setDescription('Unblock a word')
              .addStringOption((o) => o.setName('word').setDescription('Word').setRequired(true).setMaxLength(50)),
          )
          .addSubcommand((s) => s.setName('list').setDescription('List blocked words')),
      ),
  async (interaction, ctx) => {
    const sub = interaction.options.getSubcommand();
    const actor = interaction.user.id;

    if (interaction.options.getSubcommandGroup(false) === 'blocked-words') {
      if (sub === 'list') {
        const words = await ctx.db.blockedWord.findMany({ orderBy: { word: 'asc' } });
        await interaction.editReply(words.length ? `**Blocked words:** ${words.map((w) => `\`${w.word}\``).join(', ')}` : 'No blocked words.');
        return;
      }
      const word = interaction.options.getString('word', true).trim().toLowerCase();
      if (!normalizeRoleName(word)) {
        await interaction.editReply('❌ The word needs at least one letter or number.');
        return;
      }
      await ctx.db.$transaction([
        sub === 'add'
          ? ctx.db.blockedWord.upsert({ where: { word }, create: { word }, update: {} })
          : ctx.db.blockedWord.deleteMany({ where: { word } }),
        ctx.db.auditLog.create({ data: { action: `crown.blocked-word.${sub}`, actorId: actor, data: { word } } }),
      ]);
      await interaction.editReply(sub === 'add' ? `✅ Blocked \`${word}\` (also catches lookalikes like 0 for o).` : `✅ Unblocked \`${word}\`.`);
      return;
    }

    if (sub === 'view') {
      const cur = await ctx.crown.current();
      if (!cur) {
        await interaction.editReply('Nobody holds the Crown right now.');
        return;
      }
      const custom = await ctx.db.customRole.findUnique({ where: { userId: cur.userId } });
      await interaction.editReply(
        [
          `👑 ${userMention(cur.userId)} holds the Crown for the week starting ${cur.weekStart}.`,
          custom?.roleId ? `Custom role: <@&${custom.roleId}> (${custom.hex}${custom.emoji ? ` ${custom.emoji}` : ''}), edits used this week: ${custom.editsWeek === cur.weekStart ? custom.editsCount : 0}/3` : 'No custom role yet.',
          custom?.locked ? '🔒 Custom roles are locked for them.' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return;
    }

    const user = interaction.options.getUser('user', true);
    if (sub === 'reset-role') {
      const done = await ctx.crown.resetRole(user.id, actor);
      await interaction.editReply(done ? `✅ ${userMention(user.id)}'s custom role and saved settings were deleted.` : `${userMention(user.id)} had no custom role.`);
      return;
    }
    await ctx.crown.setLocked(user.id, sub === 'lock', actor);
    await interaction.editReply(sub === 'lock' ? `🔒 ${userMention(user.id)} can't create or edit a custom role.` : `🔓 ${userMention(user.id)} can create a custom role again.`);
  },
);
