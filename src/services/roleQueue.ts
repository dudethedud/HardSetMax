// Role changes are applied one at a time (SPEC §13: Discord rate limits). A failure
// never throws: it's returned, with a hint about what to fix.
import { DiscordAPIError, RESTJSONErrorCodes, type Client, type Guild } from 'discord.js';
import { moveNextTo, positionChanges } from '../core/roleOrder.js';
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
      return "Discord said the bot is missing permissions. It needs Manage Roles, and the roles it changes must be below the bot's highest role. Then run /bot setup again";
    }
    if (err.code === RESTJSONErrorCodes.UnknownRole) return 'the role no longer exists: run /bot setup';
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Moves a role directly above (or below) another one. Reads fresh positions first,
 * and only sends the roles whose place changes. Throws a clear error if the
 * result would put the role at or above the bot's own highest role.
 */
export async function placeNextTo(guild: Guild, roleId: string, anchorId: string, side: 'above' | 'below'): Promise<void> {
  await guild.roles.fetch();
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const sorted = [...guild.roles.cache.values()].sort((a, b) => a.position - b.position);
  const before = sorted.map((r) => r.id);
  const after = moveNextTo(before, roleId, anchorId, side);
  const botTop = me.roles.highest;
  if (after.indexOf(roleId) >= after.indexOf(botTop.id)) {
    const anchor = guild.roles.cache.get(anchorId);
    throw new Error(`the bot's highest role (${botTop.name}) must be above ${anchor?.name ?? 'that role'}. Drag the bot's role higher in Server Settings → Roles`);
  }
  const changes = positionChanges(before, after, new Map(sorted.map((r) => [r.id, r.rawPosition])));
  if (changes.length) await guild.roles.setPositions(changes.map((c) => ({ role: c.id, position: c.position })));
}
