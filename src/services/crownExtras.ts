// Crown extras (owner-approved), each for the current Crown holder only:
// - 🛡️ Royal pardon: once per Crown week, one VIP can't be dropped (for rank or
//   inactivity) at the next reshuffle
// - 🎭 Carter's mood: a fixed mood for his AI replies this week
// - 📌 Spotlight: once a day, one member on the VIP board with a short reason
// - 🎵 Theme of the week: shown on the VIP board and in the bot's status
// All of it lives on the CrownHolder row, so it ends with the Crown.
import type { Client, GuildMember } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { moodByKey, pardonTargetError, SPOTLIGHT_MAX, THEME_MAX } from '../core/crownExtras.js';
import { cleanPublicText } from '../core/perks.js';
import { serverDayAt } from '../core/serverDay.js';
import type { Db } from '../db/prisma.js';
import type { CrownHolder } from '../generated/prisma/client.js';
import type { Clock } from './clock.js';
import type { CrownService } from './crown.js';
import type { ModLog } from './modLog.js';
import type { VipService } from './vipService.js';

type Access = { ok: true; crown: CrownHolder } | { ok: false; message: string };

export class CrownExtras {
  /** Called after anything the VIP board or the bot's status shows changes. */
  onChange: () => void = () => undefined;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly crown: CrownService,
    private readonly vip: VipService,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
  ) {}

  async #crownOnly(userId: string): Promise<Access> {
    const cur = await this.crown.current();
    return cur?.userId === userId ? { ok: true, crown: cur } : { ok: false, message: '👑 Only this week’s Crown holder can do that.' };
  }

  async #blocked(): Promise<string[]> {
    return (await this.db.blockedWord.findMany()).map((w) => w.word);
  }

  /** Once per server-day per perk; claimed first so two quick clicks can't both count. */
  async #claimDaily(userId: string, perk: string): Promise<boolean> {
    const period = serverDayAt(this.clock.now(), this.config.current.boundary).key;
    const { count } = await this.db.perkUse.createMany({ data: [{ userId, perk, period }], skipDuplicates: true });
    return count > 0;
  }

  async #releaseDaily(userId: string, perk: string): Promise<void> {
    const period = serverDayAt(this.clock.now(), this.config.current.boundary).key;
    await this.db.perkUse.deleteMany({ where: { userId, perk, period } });
  }

  async access(userId: string, what: 'pardon' | 'mood' | 'spotlight' | 'theme'): Promise<{ ok: true } | { ok: false; message: string }> {
    const a = await this.#crownOnly(userId);
    if (!a.ok) return a;
    if (what === 'pardon' && a.crown.pardonUserId) return { ok: false, message: `🛡️ You already pardoned <@${a.crown.pardonUserId}> this week. One pardon per Crown week.` };
    return { ok: true };
  }

  // 🛡️ Royal pardon

  async pardon(actorId: string, targetId: string): Promise<string> {
    const access = await this.access(actorId, 'pardon');
    if (!access.ok) return access.message;
    const cur = (await this.crown.current())!;
    const error = pardonTargetError({ targetId, crownId: actorId, isVip: this.vip.vips.has(targetId) });
    if (error) return `❌ ${error}`;
    const { count } = await this.db.crownHolder.updateMany({ where: { id: cur.id, pardonUserId: null }, data: { pardonUserId: targetId, pardonAt: this.clock.now(), pardonUsed: false } });
    if (!count) return '🛡️ You already used this week’s pardon.';
    await this.db.auditLog.create({ data: { action: 'crown.pardon', actorId, targetId } });
    await this.modLog.post(`🛡️ <@${actorId}> (Crown) pardoned <@${targetId}>: they can't be dropped at the next reshuffle`);
    return `🛡️ <@${targetId}> is safe at the next reshuffle: they can't be dropped for rank or inactivity (they still lose VIP if they leave, get timed out or are blocked).`;
  }

  /** VipService hook: VIPs protected at this reshuffle. */
  async protectedIds(): Promise<Set<string>> {
    const rows = await this.db.crownHolder.findMany({ where: { pardonUserId: { not: null }, pardonUsed: false, endedAt: null } });
    return new Set(rows.map((r) => r.pardonUserId!));
  }

  /** After-reshuffle hook: a pardon covers one reshuffle. */
  async afterReshuffle(): Promise<void> {
    await this.db.crownHolder.updateMany({ where: { pardonUserId: { not: null }, pardonUsed: false }, data: { pardonUsed: true } });
  }

  // 🎭 Carter's mood

  async setMood(actorId: string, key: string): Promise<string> {
    const access = await this.#crownOnly(actorId);
    if (!access.ok) return access.message;
    const mood = moodByKey(key);
    if (!mood) return '❌ Pick one of the moods.';
    await this.db.crownHolder.update({ where: { id: access.crown.id }, data: { mood: mood.key } });
    // A fixed choice with nothing for staff to check, so it's kept out of the mod-log.
    await this.db.auditLog.create({ data: { action: 'crown.mood', actorId, data: { mood: mood.key } } });
    return `${mood.emoji} Carter's mood this week: **${mood.label}**. You can change it any time.`;
  }

  // 📌 Spotlight

  async spotlight(actorId: string, targetId: string, rawReason: string): Promise<string> {
    const access = await this.#crownOnly(actorId);
    if (!access.ok) return access.message;
    const guild = this.client.guilds.cache.get(this.guildId);
    const member: GuildMember | null = guild ? (guild.members.cache.get(targetId) ?? (await guild.members.fetch(targetId).catch(() => null))) : null;
    if (!member) return "❌ They're not in the server.";
    if (member.user.bot) return '❌ Bots can’t be in the spotlight.';
    const clean = cleanPublicText(rawReason.replace(/\s+/g, ' '), await this.#blocked(), SPOTLIGHT_MAX);
    if (!clean.ok) return `❌ ${clean.error}`;
    if (!(await this.#claimDaily(actorId, 'spotlight'))) return '📌 You’ve used today’s spotlight. Try again tomorrow.';
    try {
      await this.db.crownHolder.update({ where: { id: access.crown.id }, data: { spotlightId: targetId, spotlightReason: clean.text, spotlightAt: this.clock.now() } });
    } catch (err) {
      await this.#releaseDaily(actorId, 'spotlight');
      throw err;
    }
    await this.modLog.post(`📌 <@${actorId}> (Crown) spotlighted <@${targetId}>: "${clean.text}"`);
    this.onChange();
    return `📌 <@${targetId}> is in the spotlight on the VIP board: "${clean.text}"`;
  }

  // 🎵 Theme of the week

  async setTheme(actorId: string, raw: string): Promise<string> {
    const access = await this.#crownOnly(actorId);
    if (!access.ok) return access.message;
    const clean = cleanPublicText(raw.replace(/\s+/g, ' '), await this.#blocked(), THEME_MAX);
    if (!clean.ok) return `❌ ${clean.error}`;
    if (!(await this.#claimDaily(actorId, 'theme'))) return '🎵 You’ve changed the theme today. Try again tomorrow.';
    await this.db.crownHolder.update({ where: { id: access.crown.id }, data: { theme: clean.text } });
    await this.modLog.post(`🎵 <@${actorId}> (Crown) set the theme of the week: "${clean.text}"`);
    this.onChange();
    return `🎵 Theme of the week: **${clean.text}**. It's on the VIP board and in Carter's status.`;
  }

  /** The current theme, for the bot's status and the board. */
  async theme(): Promise<string | null> {
    return (await this.crown.current())?.theme ?? null;
  }
}
