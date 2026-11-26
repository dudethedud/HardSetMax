import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ApplicationCommandOptionChoiceData,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { Env } from '../../config/env.js';
import type { AccessLevel } from '../../core/access.js';
import type { Db } from '../../db/prisma.js';
import type { Logger } from '../../logger.js';
import type { ColourMenuService } from '../../services/colourMenus.js';
import type { DonationService } from '../../services/donations.js';
import type { CheckinService } from '../../services/checkins.js';
import type { InviteEventService } from '../../services/inviteEvent.js';

export interface AppContext {
  env: Env;
  log: Logger;
  db: Db;
  client: Client;
  colours: ColourMenuService;
  donations: DonationService;
  /** The Christmas invite event; null when it isn't configured. */
  invites: InviteEventService | null;
  checkins: CheckinService;
}

export type Autocomplete = (interaction: AutocompleteInteraction<'cached'>, ctx: AppContext) => Promise<ApplicationCommandOptionChoiceData[]>;

export interface Command {
  name: string;
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  level: AccessLevel;
  /** Whether the reply is only visible to the user (default: always). Decided before the deferred reply. */
  ephemeral?: (interaction: ChatInputCommandInteraction<'cached'>) => boolean;
  /** Runs after the access check, with the reply already deferred: answer with editReply. */
  execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext): Promise<void>;
  autocomplete?: Autocomplete;
}

/** Who Discord shows each level's commands to; the runtime check (core/access.ts) still applies. */
const DEFAULT_PERMISSIONS: Record<AccessLevel, bigint | null> = {
  everyone: null,
  'manage-server': PermissionFlagsBits.ManageGuild,
  admin: PermissionFlagsBits.Administrator,
  owner: PermissionFlagsBits.Administrator,
};

/** Guild-only, hidden from members below the command's level, re-checked at runtime. */
export function defineCommand(spec: {
  name: string;
  description: string;
  level: AccessLevel;
  build: (b: SlashCommandBuilder) => SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
  execute: Command['execute'];
  ephemeral?: Command['ephemeral'];
  autocomplete?: Autocomplete;
}): Command {
  const base = new SlashCommandBuilder().setName(spec.name).setDescription(spec.description).setContexts(InteractionContextType.Guild);
  const perms = DEFAULT_PERMISSIONS[spec.level];
  if (perms !== null) base.setDefaultMemberPermissions(perms);
  return {
    name: spec.name,
    data: spec.build(base).toJSON(),
    level: spec.level,
    execute: spec.execute,
    ...(spec.ephemeral ? { ephemeral: spec.ephemeral } : {}),
    ...(spec.autocomplete ? { autocomplete: spec.autocomplete } : {}),
  };
}
