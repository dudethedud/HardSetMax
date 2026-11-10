// /colours: admins build the colour menus (docs/SPEC.md).
import { ChannelType, type SlashCommandIntegerOption } from 'discord.js';
import { downloadBanner } from '../../services/banner.js';
import type { Banner } from '../../services/colourMenus.js';
import { defineCommand } from './types.js';

const menuOption = (o: SlashCommandIntegerOption) => o.setName('menu').setDescription('Which menu').setRequired(true).setAutocomplete(true);

export const coloursCommand = defineCommand({
  name: 'colours',
  description: 'Colour menus for server reppers',
  level: 'admin',
  build: (b) =>
    b
      .addSubcommandGroup((g) =>
        g
          .setName('menu')
          .setDescription('Colour menus')
          .addSubcommand((s) =>
            s
              .setName('create')
              .setDescription('Make a menu (e.g. Pinks/Magentas)')
              .addStringOption((o) => o.setName('title').setDescription('Heading, e.g. Pinks/Magentas').setRequired(true).setMaxLength(60))
              .addStringOption((o) => o.setName('emoji').setDescription('Shown before the heading').setMaxLength(60))
              .addAttachmentOption((o) => o.setName('banner').setDescription('Image above the menu (PNG, JPG, GIF or WebP, up to 8 MB)')),
          )
          .addSubcommand((s) =>
            s
              .setName('edit')
              .setDescription('Change a menu')
              .addIntegerOption(menuOption)
              .addStringOption((o) => o.setName('title').setDescription('New heading').setMaxLength(60))
              .addStringOption((o) => o.setName('emoji').setDescription('New emoji ("none" to remove)').setMaxLength(60))
              .addAttachmentOption((o) => o.setName('banner').setDescription('New banner image'))
              .addBooleanOption((o) => o.setName('remove-banner').setDescription('Take the banner off'))
              .addIntegerOption((o) => o.setName('position').setDescription('Order in the channel (0 = first)').setMinValue(0).setMaxValue(100)),
          )
          .addSubcommand((s) => s.setName('delete').setDescription('Delete a menu and its message').addIntegerOption(menuOption))
          .addSubcommand((s) =>
            s
              .setName('add-role')
              .setDescription('Add an existing colour role to a menu')
              .addIntegerOption(menuOption)
              .addRoleOption((o) => o.setName('role').setDescription('The colour role').setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName('remove-role')
              .setDescription('Take a colour role out of its menu')
              .addRoleOption((o) => o.setName('role').setDescription('The colour role').setRequired(true)),
          )
          .addSubcommand((s) => s.setName('list').setDescription('Every menu and its colours')),
      )
      .addSubcommandGroup((g) =>
        g
          .setName('unlock-role')
          .setDescription('Roles that make someone a repper (any one unlocks colours)')
          .addSubcommand((s) =>
            s
              .setName('add')
              .setDescription('This role unlocks the colour menus')
              .addRoleOption((o) => o.setName('role').setDescription('e.g. the role your other bot gives for the server tag').setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName('remove')
              .setDescription("This role no longer unlocks colours (people who don't have another lose theirs)")
              .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)),
          )
          .addSubcommand((s) => s.setName('list').setDescription('Roles that unlock colours')),
      )
      .addSubcommand((s) =>
        s
          .setName('post')
          .setDescription('Post or update all menus in a channel, in order')
          .addChannelOption((o) => o.setName('channel').setDescription('e.g. #colour-yourself').addChannelTypes(ChannelType.GuildText).setRequired(true))
          .addBooleanOption((o) => o.setName('fresh').setDescription('Delete and repost them all (to change their order)')),
      )
      .addSubcommand((s) =>
        s
          .setName('log-channel')
          .setDescription('Where colour removals are logged (leave empty to stop)')
          .addChannelOption((o) => o.setName('channel').setDescription('A staff channel').addChannelTypes(ChannelType.GuildText)),
      ),

  async autocomplete(interaction, ctx) {
    const typed = interaction.options.getFocused().toString().toLowerCase();
    // Custom emojis show as raw <:name:id> text in suggestions, so only plain emojis are shown.
    const label = (emoji: string | null) => (emoji && !emoji.includes('<') ? `${emoji} ` : '');
    return (await ctx.colours.summaries())
      .filter((m) => m.title.toLowerCase().includes(typed))
      .map((m) => ({ name: `${label(m.emoji)}${m.title} (${m.colours.length} colours)`, value: m.id }));
  },

  async execute(interaction, ctx) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const reply = (text: string) => interaction.editReply({ content: text, allowedMentions: { parse: [] } });
    const banner = async (): Promise<Banner | null | string> => {
      const file = interaction.options.getAttachment('banner');
      if (!file) return null;
      const got = await downloadBanner(file.url, file.size);
      return got.ok ? got.banner : `❌ ${got.error}`;
    };

    if (group === 'menu') {
      if (sub === 'create') {
        const b = await banner();
        if (typeof b === 'string') return void (await reply(b));
        return void (await reply(await ctx.colours.createMenu(interaction.options.getString('title', true).trim(), interaction.options.getString('emoji')?.trim() || null, b)));
      }
      if (sub === 'edit') {
        const b = await banner();
        if (typeof b === 'string') return void (await reply(b));
        const emoji = interaction.options.getString('emoji')?.trim();
        const title = interaction.options.getString('title')?.trim();
        const position = interaction.options.getInteger('position');
        return void (await reply(
          await ctx.colours.editMenu(interaction.options.getInteger('menu', true), {
            ...(title ? { title } : {}),
            ...(emoji ? { emoji: emoji.toLowerCase() === 'none' ? null : emoji } : {}),
            ...(b ? { banner: b } : interaction.options.getBoolean('remove-banner') ? { banner: null } : {}),
            ...(position !== null ? { position } : {}),
          }),
        ));
      }
      if (sub === 'delete') return void (await reply(await ctx.colours.deleteMenu(interaction.options.getInteger('menu', true))));
      if (sub === 'add-role') return void (await reply(await ctx.colours.addColour(interaction.options.getInteger('menu', true), interaction.options.getRole('role', true))));
      if (sub === 'remove-role') return void (await reply(await ctx.colours.removeColour(interaction.options.getRole('role', true).id)));
      const menus = await ctx.colours.summaries();
      return void (await reply(
        menus.length
          ? menus.map((m) => `**${m.emoji ?? ''} ${m.title}** (menu #${m.id}, position ${m.position})${m.messageId ? ` (posted in <#${m.channelId}>)` : ' (not posted)'}\n${m.colours.map((c) => `<@&${c.roleId}>`).join(' ') || 'no colours yet'}`).join('\n\n').slice(0, 1900)
          : 'No menus yet. Make one with `/colours menu create`.',
      ));
    }

    if (group === 'unlock-role') {
      if (sub === 'add') return void (await reply(await ctx.colours.addUnlockRole(interaction.options.getRole('role', true))));
      if (sub === 'remove') return void (await reply(await ctx.colours.removeUnlockRole(interaction.options.getRole('role', true).id)));
      const ids = [...ctx.colours.unlockRoleIds];
      return void (await reply(ids.length ? `Roles that unlock colours: ${ids.map((id) => `<@&${id}>`).join(', ')}` : 'None yet: add the role(s) your other bots give reppers with `/colours unlock-role add`.'));
    }

    if (sub === 'post') {
      const channel = interaction.options.getChannel('channel', true, [ChannelType.GuildText]);
      return void (await reply(await ctx.colours.post(channel, interaction.options.getBoolean('fresh') ?? false)));
    }
    if (sub === 'log-channel') return void (await reply(await ctx.colours.setLogChannel(interaction.options.getChannel('channel')?.id ?? null)));
  },
});
