import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { ConfigStore } from '../../config/configStore.js';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/prisma.js';
import type { Logger } from '../../logger.js';
import type { ActivityBuffer } from '../../services/activityBuffer.js';
import type { BadgeService } from '../../services/badges.js';
import type { Clock } from '../../services/clock.js';
import type { ColourService } from '../../services/colours.js';
import type { CrownService } from '../../services/crown.js';
import type { Panels } from '../../services/panels.js';
import type { PollService } from '../../services/polls.js';
import type { ModLog } from '../../services/modLog.js';
import type { VipService } from '../../services/vipService.js';
import type { GatewayLeader } from '../../services/gatewayLeader.js';

export interface AppContext {
  env: Env;
  log: Logger;
  db: Db;
  leader: GatewayLeader;
  client: Client;
  startedAt: Date;
  config: ConfigStore;
  activity: ActivityBuffer;
  clock: Clock;
  modLog: ModLog;
  vip: VipService;
  colours: ColourService;
  crown: CrownService;
  badges: BadgeService;
  polls: PollService;
  panels: Panels;
  runSetup: (guild: Guild) => Promise<string[]>;
}

export interface AdminCommand {
  name: string;
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  /**
   * Runs after the admin check, with the reply already deferred as ephemeral.
   * Respond with `interaction.editReply`.
   */
  execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext): Promise<void>;
}

/**
 * The only way to define a slash command, so every command is admin-only and
 * guild-only (SPEC §1). `contexts: [Guild]` is Discord's replacement for the
 * deprecated `dm_permission = false`.
 */
export function defineAdminCommand(
  name: string,
  description: string,
  build: (b: SlashCommandBuilder) => { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody },
  execute: AdminCommand['execute'],
): AdminCommand {
  const base = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild);
  return { name, data: build(base).toJSON(), execute };
}
