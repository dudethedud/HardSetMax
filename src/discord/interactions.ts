// The one global interaction handler. Buttons, dropdowns and forms are routed
// by their fixed custom IDs, commands by name.
import {
  MessageFlags,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type RoleSelectMenuInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import { ACCESS_DENIED, checkAccess, type AccessLevel, type AccessResult } from '../core/access.js';
import { BUTTONS, MODALS, SELECTS, USER_SELECTS } from './buttons.js';
import { COMMANDS_BY_NAME } from './commands/index.js';
import { CHANNEL_PICK_HANDLERS, ROLE_PICK_HANDLERS } from './setupPicks.js';
import type { AppContext } from './commands/types.js';

/** Owner, Administrator, or a staff role, checked against the live member. */
export async function accessOf(interaction: Interaction<'cached'>, level: AccessLevel, ctx: AppContext): Promise<AccessResult> {
  const member = interaction.member;
  const isOwner = interaction.guild.ownerId === interaction.user.id;
  const isAdministrator = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
  let isStaff = false;
  // Only look up staff roles when they could matter.
  if (level === 'staff' && !isOwner && !isAdministrator) {
    const staff = new Set((await ctx.db.staffRole.findMany()).map((s) => s.roleId));
    isStaff = member.roles.cache.some((r) => staff.has(r.id));
  }
  return checkAccess(level, { guildId: interaction.guildId, expectedGuildId: ctx.env.GUILD_ID, isOwner, isAdministrator, isStaff });
}

export async function handleInteraction(interaction: Interaction, ctx: AppContext): Promise<void> {
  if (interaction.isButton()) return handleButton(interaction, ctx);
  if (interaction.isStringSelectMenu()) return handleSelect(interaction, ctx);
  if (interaction.isUserSelectMenu()) return handleUserSelect(interaction, ctx);
  if (interaction.isChannelSelectMenu()) return handleAdminSelect(interaction, CHANNEL_PICK_HANDLERS.get(interaction.customId), ctx);
  if (interaction.isRoleSelectMenu()) return handleAdminSelect(interaction, ROLE_PICK_HANDLERS.get(interaction.customId), ctx);
  if (interaction.isModalSubmit()) return handleModal(interaction, ctx);
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction, ctx);
  if (!interaction.isChatInputCommand()) return;

  const command = COMMANDS_BY_NAME.get(interaction.commandName);
  if (!interaction.inCachedGuild() || interaction.guildId !== ctx.env.GUILD_ID) {
    await interaction.reply({ content: ACCESS_DENIED[interaction.guildId ? 'wrong-guild' : 'not-in-guild'], flags: MessageFlags.Ephemeral });
    return;
  }
  if (!command) {
    await interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = interaction.options.getSubcommand(false);
  const group = interaction.options.getSubcommandGroup(false);
  const check = await accessOf(interaction, command.levelFor(sub, group), ctx);
  if (!check.ok) {
    ctx.log.warn({ userId: interaction.user.id, command: interaction.commandName, sub, reason: check.reason }, 'command denied');
    await interaction.reply({ content: ACCESS_DENIED[check.reason], flags: MessageFlags.Ephemeral });
    return;
  }

  // Defer first so slow work never hits Discord's 3-second limit (SPEC §13).
  if (command.defer) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await command.execute(interaction, ctx);
  } catch (err) {
    ctx.log.error({ err, command: interaction.commandName }, 'command failed');
    const msg = '❌ Something went wrong. Details are in the bot logs.';
    await (interaction.replied || interaction.deferred ? interaction.editReply(msg) : interaction.reply({ content: msg, flags: MessageFlags.Ephemeral })).catch(
      () => undefined,
    );
  }
}

/** Suggestions while typing an option. Nothing is shown to people who can't run the subcommand. */
async function handleAutocomplete(interaction: AutocompleteInteraction, ctx: AppContext): Promise<void> {
  const command = COMMANDS_BY_NAME.get(interaction.commandName);
  if (!command?.autocomplete || !interaction.inCachedGuild() || interaction.guildId !== ctx.env.GUILD_ID) {
    await interaction.respond([]).catch(() => undefined);
    return;
  }
  try {
    const check = await accessOf(interaction, command.levelFor(interaction.options.getSubcommand(false), interaction.options.getSubcommandGroup(false)), ctx);
    const choices = check.ok ? await command.autocomplete(interaction, ctx) : [];
    await interaction.respond(choices.slice(0, 25).map((c) => ({ ...c, name: c.name.slice(0, 100) })));
  } catch (err) {
    ctx.log.warn({ err, command: interaction.commandName }, 'autocomplete failed');
    await interaction.respond([]).catch(() => undefined);
  }
}

async function handleButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  const handler = BUTTONS.get(interaction.customId);
  if (!handler || !interaction.inCachedGuild() || interaction.guildId !== ctx.env.GUILD_ID) {
    await interaction.reply({ content: 'This button no longer works.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (handler.level) {
    const check = await accessOf(interaction, handler.level, ctx);
    if (!check.ok) {
      ctx.log.warn({ userId: interaction.user.id, button: interaction.customId, reason: check.reason }, 'button denied');
      await interaction.reply({ content: ACCESS_DENIED[check.reason], flags: MessageFlags.Ephemeral });
      return;
    }
  }
  try {
    await handler.run(interaction, ctx);
  } catch (err) {
    ctx.log.error({ err, button: interaction.customId }, 'button failed');
    const reply = { content: '❌ Something went wrong. Details are in the bot logs.', flags: MessageFlags.Ephemeral } as const;
    await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => undefined);
  }
}

/** Member-facing dropdowns. Each handler checks what the member may do (e.g. VIP only). */
async function handleSelect(interaction: StringSelectMenuInteraction, ctx: AppContext): Promise<void> {
  const handler = SELECTS.get(interaction.customId);
  if (!handler || !interaction.inCachedGuild() || interaction.guildId !== ctx.env.GUILD_ID) {
    await interaction.reply({ content: 'This menu no longer works.', flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    await handler.run(interaction, ctx);
  } catch (err) {
    ctx.log.error({ err, select: interaction.customId }, 'menu failed');
    const reply = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral } as const;
    await (interaction.replied || interaction.deferred ? interaction.editReply(reply.content) : interaction.reply(reply)).catch(() => undefined);
  }
}

/** Member pickers (the Crown's titles). Each handler checks who may use it. */
async function handleUserSelect(interaction: UserSelectMenuInteraction, ctx: AppContext): Promise<void> {
  const handler = USER_SELECTS.get(interaction.customId);
  if (!handler || !interaction.inCachedGuild() || interaction.guildId !== ctx.env.GUILD_ID) {
    await interaction.reply({ content: 'This menu no longer works.', flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    await handler.run(interaction, ctx);
  } catch (err) {
    ctx.log.error({ err, select: interaction.customId }, 'menu failed');
    const reply = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral } as const;
    await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => undefined);
  }
}

/** The /bot setup menus: admin only, checked like commands. */
async function handleAdminSelect<I extends ChannelSelectMenuInteraction | RoleSelectMenuInteraction>(
  interaction: I,
  handler: { run(i: never, ctx: AppContext): Promise<void> } | undefined,
  ctx: AppContext,
): Promise<void> {
  if (!handler || !interaction.inCachedGuild() || interaction.guildId !== ctx.env.GUILD_ID) {
    await interaction.reply({ content: 'This menu no longer works.', flags: MessageFlags.Ephemeral });
    return;
  }
  const check = await accessOf(interaction, 'admin', ctx);
  if (!check.ok) {
    await interaction.reply({ content: ACCESS_DENIED[check.reason], flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    await handler.run(interaction as never, ctx);
  } catch (err) {
    ctx.log.error({ err, select: interaction.customId }, 'setup menu failed');
    const msg = '❌ Something went wrong. Details are in the bot logs.';
    await (interaction.replied || interaction.deferred ? interaction.editReply(msg) : interaction.reply({ content: msg, flags: MessageFlags.Ephemeral })).catch(() => undefined);
  }
}

async function handleModal(interaction: ModalSubmitInteraction, ctx: AppContext): Promise<void> {
  const handler = MODALS.get(interaction.customId);
  if (!handler || !interaction.inCachedGuild() || interaction.guildId !== ctx.env.GUILD_ID) {
    await interaction.reply({ content: 'This form no longer works.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (handler.level) {
    const check = await accessOf(interaction, handler.level, ctx);
    if (!check.ok) {
      await interaction.reply({ content: ACCESS_DENIED[check.reason], flags: MessageFlags.Ephemeral });
      return;
    }
  }
  try {
    await handler.run(interaction, ctx);
  } catch (err) {
    ctx.log.error({ err, modal: interaction.customId }, 'form failed');
    const msg = '❌ Something went wrong. Please try again.';
    await (interaction.replied || interaction.deferred ? interaction.editReply(msg) : interaction.reply({ content: msg, flags: MessageFlags.Ephemeral })).catch(() => undefined);
  }
}
