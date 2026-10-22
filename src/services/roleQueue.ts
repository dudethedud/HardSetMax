// Role changes are applied one at a time (SPEC §13: Discord rate limits). A failure
// never throws: it's returned, with a hint about what to fix.
import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js';
import type { Logger } from '../logger.js';

export interface RoleOp {
  userId: string;
  roleId: string;
  action: 'add' | 'remove';
  /** Shown in Discord's audit log. */
  reason: string;
}

export type RoleOpResult = { ok: true } | { ok: false; error: string };

export class RoleQueue {
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly log: Logger,
  ) {}

  run(op: RoleOp): Promise<RoleOpResult> {
    const result = this.#tail.then(() => this.#apply(op));
    this.#tail = result;
    return result;
  }

  /** Waits for everything queued so far. */
  async idle(): Promise<void> {
    await this.#tail;
  }

  async #apply({ userId, roleId, action, reason }: RoleOp): Promise<RoleOpResult> {
    try {
      const guild = this.client.guilds.cache.get(this.guildId);
      if (!guild) return { ok: false, error: 'the bot is not in the server' };
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return action === 'remove' ? { ok: true } : { ok: false, error: 'member is not in the server' };
      if (action === 'add' && !member.roles.cache.has(roleId)) await member.roles.add(roleId, reason);
      if (action === 'remove' && member.roles.cache.has(roleId)) await member.roles.remove(roleId, reason);
      return { ok: true };
    } catch (err) {
      this.log.warn({ err, userId, roleId, action }, 'role change failed');
      return { ok: false, error: explainRoleError(err) };
    }
  }
}

export function explainRoleError(err: unknown): string {
  if (err instanceof DiscordAPIError) {
    if (err.code === RESTJSONErrorCodes.MissingPermissions) {
      return "missing permission: give the bot Manage Roles and move the bot's role above the roles it manages, then run /setup run";
    }
    if (err.code === RESTJSONErrorCodes.UnknownRole) return 'the role no longer exists: run /setup run';
  }
  return err instanceof Error ? err.message : String(err);
}
