import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ApplicationCommandOptionChoiceData,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { Env } from '../../config/env.js';
import type { AccessLevel } from '../../core/access.js';
import type { Db } from '../../db/prisma.js';
import type { Logger } from '../../logger.js';
import type { ColourMenuService } from '../../services/colourMenus.js';
import type { DonationService } from '../../services/donations.js';

export interface AppContext {
  env: Env;
  log: Logger;
  db: Db;
  client: Client;
  colours: ColourMenuService;
  donations: DonationService;
}

export type Autocomplete = (interaction: AutocompleteInteraction<'cached'>, ctx: AppContext) => Promise<ApplicationCommandOptionChoiceData[]>;

export interface Command {
  name: string;
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  level: AccessLevel;
  /** Runs after the access check, with the reply already deferred (ephemeral): answer with editReply. */
  execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext): Promise<void>;
  autocomplete?: Autocomplete;
}

/** Guild-only, hidden from everyone without Administrator, re-checked at runtime. */
export function defineCommand(spec: {
  name: string;
  description: string;
  level: AccessLevel;
  build: (b: SlashCommandBuilder) => SlashCommandSubcommandsOnlyBuilder;
  execute: Command['execute'];
  autocomplete?: Autocomplete;
}): Command {
  const base = new SlashCommandBuilder()
    .setName(spec.name)
    .setDescription(spec.description)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild);
  return {
    name: spec.name,
    data: spec.build(base).toJSON(),
    level: spec.level,
    execute: spec.execute,
    ...(spec.autocomplete ? { autocomplete: spec.autocomplete } : {}),
  };
}
