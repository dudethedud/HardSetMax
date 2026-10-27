import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ApplicationCommandOptionChoiceData,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import type { AccessLevel } from '../../core/access.js';
import type { ConfigStore } from '../../config/configStore.js';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/prisma.js';
import type { Logger } from '../../logger.js';
import type { ActivityBuffer } from '../../services/activityBuffer.js';
import type { AiService } from '../../services/ai/aiService.js';
import type { ChatService } from '../../services/ai/chat.js';
import type { BadgeService } from '../../services/badges.js';
import type { Clock } from '../../services/clock.js';
import type { ColourService } from '../../services/colours.js';
import type { CrownService } from '../../services/crown.js';
import type { CrownPowers } from '../../services/crownPowers.js';
import type { JesterService } from '../../services/jester.js';
import type { TreatService } from '../../services/treats.js';
import type { ColourRequestService } from '../../services/colourRequests.js';
import type { ShoutoutService } from '../../services/shoutouts.js';
import type { Panels } from '../../services/panels.js';
import type { PollService } from '../../services/polls.js';
import type { TempVoiceService } from '../../services/tempVoice.js';
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
  powers: CrownPowers;
  jester: JesterService;
  treats: TreatService;
  colourRequests: ColourRequestService;
  shoutouts: ShoutoutService;
  badges: BadgeService;
  polls: PollService;
  tempVoice: TempVoiceService;
  ai: AiService;
  chat: ChatService;
  panels: Panels;
  runSetup: (guild: Guild) => Promise<string[]>;
}

export interface Command {
  name: string;
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  /** Who may run this subcommand ("group sub", or "sub"). Checked at runtime. */
  levelFor(subcommand: string | null, group: string | null): AccessLevel;
  /**
   * Runs after the access check. Unless `defer` is false, the reply is already
   * deferred as ephemeral: respond with `interaction.editReply`.
   */
  defer: boolean;
  execute(interaction: ChatInputCommandInteraction<'cached'>, ctx: AppContext): Promise<void>;
  /** Suggestions for an option marked setAutocomplete (up to 25). Runs after the same access check. */
  autocomplete?: Autocomplete;
}

export type Autocomplete = (interaction: AutocompleteInteraction<'cached'>, ctx: AppContext) => Promise<ApplicationCommandOptionChoiceData[]>;

export interface CommandSpec {
  name: string;
  description: string;
  /** Access per subcommand ("group sub" or "sub"); `default` covers the rest. */
  levels: { default: AccessLevel } & Record<string, AccessLevel>;
  /** false: execute replies itself, e.g. to open a form (which must be the first reply). */
  defer?: boolean;
  build: (b: SlashCommandBuilder) => { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute: Command['execute'];
  autocomplete?: Autocomplete;
}

const RANK: Record<AccessLevel, number> = { staff: 0, admin: 1, owner: 2 };

/**
 * The only way to define a slash command, so every command is guild-only and
 * hidden from regular members (SPEC §1). Commands with staff subcommands are shown
 * to members with Timeout Members (the staff marker); the rest to Administrators
 * only. `contexts: [Guild]` is Discord's replacement for the deprecated
 * `dm_permission = false`. Visibility is only a hint: every run is checked by level.
 */
export function defineCommand(spec: CommandSpec): Command {
  const lowest = Object.values(spec.levels).reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
  const base = new SlashCommandBuilder()
    .setName(spec.name)
    .setDescription(spec.description)
    .setDefaultMemberPermissions(lowest === 'staff' ? PermissionFlagsBits.ModerateMembers : PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild);
  return {
    name: spec.name,
    data: spec.build(base).toJSON(),
    defer: spec.defer ?? true,
    levelFor: (sub, group) => (group && sub ? spec.levels[`${group} ${sub}`] : undefined) ?? (sub ? spec.levels[sub] : undefined) ?? spec.levels.default,
    execute: spec.execute,
    ...(spec.autocomplete ? { autocomplete: spec.autocomplete } : {}),
  };
}
