// The one global interaction handler. Later phases route buttons, dropdowns and
// modals here by their fixed custom IDs.
import { MessageFlags, PermissionFlagsBits, type ButtonInteraction, type Interaction, type StringSelectMenuInteraction } from 'discord.js';
import { checkAdmin } from '../core/adminCheck.js';
import { BUTTONS, SELECTS } from './buttons.js';
import { COMMANDS_BY_NAME } from './commands/index.js';
import type { AppContext } from './commands/types.js';

const DENIED = {
  'not-in-guild': 'This bot only works inside the server.',
  'wrong-guild': 'This bot is not set up for this server.',
  'not-admin': 'Admins only.',
} as const;

export async function handleInteraction(interaction: Interaction, ctx: AppContext): Promise<void> {
  if (interaction.isButton()) return handleButton(interaction, ctx);
  if (interaction.isStringSelectMenu()) return handleSelect(interaction, ctx);
  if (!interaction.isChatInputCommand()) return;

  const check = checkAdmin({
    guildId: interaction.guildId,
    expectedGuildId: ctx.env.GUILD_ID,
    isAdministrator: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
  });
  const command = COMMANDS_BY_NAME.get(interaction.commandName);
  if (!check.ok || !command || !interaction.inCachedGuild()) {
    if (!check.ok) ctx.log.warn({ userId: interaction.user.id, command: interaction.commandName, reason: check.reason }, 'command denied');
    await interaction.reply({
      content: check.ok ? 'Unknown command.' : DENIED[check.reason],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer first so slow work never hits Discord's 3-second limit (SPEC §13).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await command.execute(interaction, ctx);
  } catch (err) {
    ctx.log.error({ err, command: interaction.commandName }, 'command failed');
    await interaction.editReply('❌ Something went wrong. Details are in the bot logs.').catch(() => undefined);
  }
}

async function handleButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  const handler = BUTTONS.get(interaction.customId);
  if (!handler || !interaction.inCachedGuild() || interaction.guildId !== ctx.env.GUILD_ID) {
    await interaction.reply({ content: 'This button no longer works.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (handler.adminOnly) {
    const check = checkAdmin({
      guildId: interaction.guildId,
      expectedGuildId: ctx.env.GUILD_ID,
      isAdministrator: interaction.memberPermissions.has(PermissionFlagsBits.Administrator),
    });
    if (!check.ok) {
      ctx.log.warn({ userId: interaction.user.id, button: interaction.customId, reason: check.reason }, 'button denied');
      await interaction.reply({ content: DENIED[check.reason], flags: MessageFlags.Ephemeral });
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
