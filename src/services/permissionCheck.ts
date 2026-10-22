// Hourly check (SPEC §13: "permission/hierarchy problem → no crash; log to mod-log
// with what to fix"). Posts only when the list of problems changes, so it doesn't
// repeat itself every hour.
import { PermissionsBitField, type Client } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import type { Db } from '../db/prisma.js';
import type { ModLog } from './modLog.js';
import { BOT_PERMISSIONS } from './setup.js';

export class PermissionCheck {
  #last = '';

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly modLog: ModLog,
  ) {}

  /** The current problems, each with what to do about it. */
  async problems(): Promise<string[]> {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) return ['The bot is not in the server.'];
    const me = await guild.members.fetchMe();
    const out: string[] = [];
    const missing = BOT_PERMISSIONS.filter((p) => !me.permissions.has(p));
    if (missing.length) out.push(`Missing permissions: ${new PermissionsBitField(missing).toArray().join(', ')}. Add them to the bot's role.`);

    const cfg = this.config.current.guild;
    const managed = [
      cfg.vipRoleId,
      cfg.crownRoleId,
      cfg.pollsRoleId,
      ...(await this.db.colourOption.findMany()).map((o) => o.roleId),
      ...(await this.db.badge.findMany()).map((b) => b.roleId),
      ...(await this.db.customRole.findMany({ where: { roleId: { not: null } } })).map((c) => c.roleId),
    ].filter((id): id is string => !!id);
    const top = me.roles.highest.position;
    const above = managed.map((id) => guild.roles.cache.get(id)).filter((r) => r && r.position >= top);
    if (above.length) {
      out.push(`The bot's role is below roles it manages (${above.map((r) => r!.name).join(', ')}). Drag the bot's role above them in Server Settings → Roles.`);
    }
    const lost = managed.filter((id) => !guild.roles.cache.has(id));
    if (lost.length) out.push(`${lost.length} role(s) the bot manages were deleted. Run /setup run to recreate them.`);
    return out;
  }

  async run(): Promise<void> {
    const problems = await this.problems();
    const key = problems.join('\n');
    if (key === this.#last) return;
    if (problems.length) await this.modLog.post(`⚠️ **Bot setup problems**\n${problems.map((p) => `• ${p}`).join('\n')}`);
    else if (this.#last) await this.modLog.post('✅ Bot setup problems fixed.');
    this.#last = key;
  }
}
