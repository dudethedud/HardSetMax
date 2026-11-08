// The one global interaction handler. Menu dropdowns use fixed custom IDs
// ("colours:menu:<id>"), so they keep working after restarts.
import { MessageFlags, PermissionFlagsBits, type AutocompleteInteraction, type ChatInputCommandInteraction, type Interaction, type StringSelectMenuInteraction } from 'discord.js';
import { ACCESS_DENIED, checkAccess, type AccessLevel, type AccessResult } from '../core/access.js';
import { MENU_SELECT_PREFIX } from '../services/colourMenus.js';
import { COMMANDS_BY_NAME } from './commands/index.js';
import type { AppContext } from './commands/types.js';

function accessOf(interaction: ChatInputCommandInteraction | AutocompleteInteraction, level: AccessLevel, ctx: AppContext): AccessResult {
  return checkAccess(level, {
    guildId: interaction.guildId,
    expectedGuildId: ctx.env.GUILD_ID,
    isOwner: interaction.guild?.ownerId === interaction.user.id,
    isAdministrator: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
  });
}

export async function handleInteraction(interaction: Interaction, ctx: AppContext): Promise<void> {
  if (interaction.isStringSelectMenu()) return handleMenuPick(interaction, ctx);
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction, ctx);
  if (!interaction.isChatInputCommand()) return;

  const command = COMMANDS_BY_NAME.get(interaction.commandName);
  if (!command || !interaction.inCachedGuild()) {
    await interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
    return;
  }
  const check = accessOf(interaction, command.level, ctx);
  if (!check.ok) {
    ctx.log.warn({ userId: interaction.user.id, command: interaction.commandName, reason: check.reason }, 'command denied');
    await interaction.reply({ content: ACCESS_DENIED[check.reason], flags: MessageFlags.Ephemeral });
    return;
  }
  // Answer Discord first, so slow work (banner downloads, posting) never hits the 3-second limit.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await command.execute(interaction, ctx);
  } catch (err) {
    ctx.log.error({ err, command: interaction.commandName }, 'command failed');
    await interaction.editReply('❌ Something went wrong. Details are in the bot logs.').catch(() => undefined);
  }
}

async function handleAutocomplete(interaction: AutocompleteInteraction, ctx: AppContext): Promise<void> {
  const command = COMMANDS_BY_NAME.get(interaction.commandName);
  // Nothing is suggested to people who can't run the command.
  if (!command?.autocomplete || !interaction.inCachedGuild() || !accessOf(interaction, command.level, ctx).ok) {
    await interaction.respond([]).catch(() => undefined);
    return;
  }
  try {
    const choices = await command.autocomplete(interaction, ctx);
    await interaction.respond(choices.slice(0, 25).map((c) => ({ ...c, name: c.name.slice(0, 100) })));
  } catch (err) {
    ctx.log.warn({ err }, 'autocomplete failed');
    await interaction.respond([]).catch(() => undefined);
  }
}

/** A member picked from a colour menu. */
async function handleMenuPick(interaction: StringSelectMenuInteraction, ctx: AppContext): Promise<void> {
  const menuId = interaction.customId.startsWith(MENU_SELECT_PREFIX) ? Number(interaction.customId.slice(MENU_SELECT_PREFIX.length)) : NaN;
  if (!Number.isInteger(menuId) || !interaction.inCachedGuild() || interaction.guildId !== ctx.env.GUILD_ID) {
    await interaction.reply({ content: 'This menu no longer works.', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const reply = await ctx.colours.pick(interaction.member, menuId, interaction.values[0] ?? '');
    await interaction.editReply({ content: reply, allowedMentions: { parse: [] } });
  } catch (err) {
    ctx.log.error({ err, menuId }, 'colour pick failed');
    await interaction.editReply('❌ Something went wrong. Please try again.').catch(() => undefined);
  }
  // Clear the dropdown's selection so the same colour can be picked again later.
  await interaction.message.edit({ components: interaction.message.components }).catch(() => undefined);
}
