// The one global interaction handler. Later phases route buttons, dropdowns and
// modals here by their fixed custom IDs.
import { MessageFlags, PermissionFlagsBits, type Interaction } from 'discord.js';
import { checkAdmin } from '../core/adminCheck.js';
import { COMMANDS_BY_NAME } from './commands/index.js';
import type { AppContext } from './commands/types.js';

const DENIED = {
  'not-in-guild': 'This bot only works inside the server.',
  'wrong-guild': 'This bot is not set up for this server.',
  'not-admin': 'Admins only.',
} as const;

export async function handleInteraction(interaction: Interaction, ctx: AppContext): Promise<void> {
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
