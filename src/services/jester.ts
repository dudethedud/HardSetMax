// The Jester's job (owner-approved): once per server-day, set Puppyboy Carter's
// status, and once per server-day make him do a trick in main chat. The status
// text is checked like shoutouts, saved so it survives a restart, and removed
// when the Jester loses the title. Tricks are fixed lines, never AI.
import { ActivityType, type Client } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { cleanPublicText, JESTER_STATUS_MAX, pickTrick } from '../core/perks.js';
import { serverDayAt } from '../core/serverDay.js';
import type { Db } from '../db/prisma.js';
import type { Logger } from '../logger.js';
import type { Clock } from './clock.js';
import type { CrownPowers } from './crownPowers.js';
import type { ModLog } from './modLog.js';

const STATUS_ID = 'jester';
type Access = { ok: true } | { ok: false; message: string };

export class JesterService {
  constructor(
    private readonly client: Client,
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly powers: CrownPowers,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly random: () => number = Math.random,
  ) {}

  #day() {
    return serverDayAt(this.clock.now(), this.config.current.boundary);
  }

  async #access(userId: string, perk: 'status' | 'trick'): Promise<Access> {
    await this.powers.titles(); // fresh holders
    if (this.powers.titleOf(userId) !== 'jester') return { ok: false, message: '🃏 Only the Jester can do that. The Crown hands out the title.' };
    const day = this.#day();
    if (await this.db.perkUse.findUnique({ where: { userId_perk_period: { userId, perk: `jester-${perk}`, period: day.key } } })) {
      return { ok: false, message: `🃏 You've already done that today. Next one <t:${Math.floor(day.end.getTime() / 1000)}:R>.` };
    }
    return { ok: true };
  }

  statusAccess(userId: string): Promise<Access> {
    return this.#access(userId, 'status');
  }

  /** Claims today's use first, so two quick clicks can't both run. False if already used. */
  async #claim(userId: string, perk: 'status' | 'trick'): Promise<boolean> {
    const { count } = await this.db.perkUse.createMany({ data: [{ userId, perk: `jester-${perk}`, period: this.#day().key }], skipDuplicates: true });
    return count > 0;
  }

  async #release(userId: string, perk: 'status' | 'trick'): Promise<void> {
    await this.db.perkUse.deleteMany({ where: { userId, perk: `jester-${perk}`, period: this.#day().key } });
  }

  /** Sets the bot's status. Returns the private reply. */
  async setStatus(userId: string, raw: string): Promise<string> {
    const access = await this.statusAccess(userId);
    if (!access.ok) return access.message;
    const blocked = (await this.db.blockedWord.findMany()).map((w) => w.word);
    const clean = cleanPublicText(raw.replace(/\s+/g, ' '), blocked, JESTER_STATUS_MAX);
    if (!clean.ok) return `❌ ${clean.error}`;
    if (!(await this.#claim(userId, 'status'))) return "🃏 You've already set the status today.";
    await this.db.botStatus.upsert({ where: { id: STATUS_ID }, create: { id: STATUS_ID, text: clean.text, setById: userId }, update: { text: clean.text, setById: userId, setAt: this.clock.now() } });
    this.#show(clean.text);
    await this.modLog.post(`🃏 <@${userId}> (Jester) set the bot's status: "${clean.text}"`);
    return `✅ Puppyboy Carter's status is now: **${clean.text}**`;
  }

  /** Posts a trick in main chat. Returns the private reply. */
  async trick(userId: string): Promise<string> {
    const access = await this.#access(userId, 'trick');
    if (!access.ok) return access.message;
    const g = this.config.current.guild;
    const channelId = g.mainChatChannelId ?? g.announceChannelId;
    if (!channelId) return '❌ There’s no main chat channel set yet. Ask an admin.';
    if (!(await this.#claim(userId, 'trick'))) return "🃏 You've already asked for a trick today.";
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isSendable()) throw new Error('the channel is missing');
      const message = await channel.send({ content: `🃏 The Jester <@${userId}> asked Puppyboy Carter for a trick… he ${pickTrick(this.random())}`, allowedMentions: { parse: [] } });
      return `✅ Trick done: ${message.url}`;
    } catch (err) {
      await this.#release(userId, 'trick');
      this.log.warn({ err }, "couldn't post the Jester's trick");
      return "❌ Couldn't post the trick. You can try again.";
    }
  }

  #show(text: string | null): void {
    this.client.user?.setPresence({ activities: text ? [{ name: 'Custom Status', state: text, type: ActivityType.Custom }] : [] });
  }

  /** Title hook: the status goes when the Jester who set it loses the title. */
  async onTitleLost(userId: string): Promise<void> {
    const { count } = await this.db.botStatus.deleteMany({ where: { id: STATUS_ID, setById: userId } });
    if (count) this.#show(null);
  }

  /** Startup: show the saved status if its Jester still holds the title. */
  async restore(): Promise<void> {
    const status = await this.db.botStatus.findUnique({ where: { id: STATUS_ID } });
    if (!status) return;
    await this.powers.titles();
    if (this.powers.titleOf(status.setById) === 'jester') this.#show(status.text);
    else await this.onTitleLost(status.setById);
  }
}
