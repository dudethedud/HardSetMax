// VIP colour requests (owner-approved): a VIP suggests a new VIP gradient (name
// and two colours). It's checked, then posted in the mod-log with Approve and
// Decline buttons for staff. Approving adds it like `/settings colour add`.
// One open request per VIP, and one request per VIP per 7 days.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { ConfigStore } from '../config/configStore.js';
import { checkColourRequest, type ColourRequestInput } from '../core/vipExtras.js';
import type { Db } from '../db/prisma.js';
import type { Clock } from './clock.js';
import type { ColourService } from './colours.js';
import type { ModLog } from './modLog.js';
import type { VipService } from './vipService.js';

export const COLOUR_REQUEST_APPROVE_ID = 'colour-request:approve';
export const COLOUR_REQUEST_DECLINE_ID = 'colour-request:decline';
const WEEK_MS = 7 * 24 * 3600_000;

type Access = { ok: true } | { ok: false; message: string };

export class ColourRequestService {
  constructor(
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly vip: VipService,
    private readonly colours: ColourService,
    private readonly modLog: ModLog,
    private readonly clock: Clock,
    /** Runs after a colour is added (makes its role and refreshes the panels). Returns problems to show. */
    private readonly afterAdd: () => Promise<string[]>,
  ) {}

  async access(userId: string): Promise<Access> {
    if (!this.vip.vips.has(userId)) return { ok: false, message: '🎨 Colour requests are a VIP perk.' };
    const last = await this.db.colourRequest.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    if (last?.status === 'pending') return { ok: false, message: `🎨 Your request for **${last.name}** is still waiting for staff.` };
    if (last && last.createdAt.getTime() > this.clock.now().getTime() - WEEK_MS) {
      return { ok: false, message: `🎨 One request a week. Your next one is ready <t:${Math.floor((last.createdAt.getTime() + WEEK_MS) / 1000)}:R>.` };
    }
    return { ok: true };
  }

  /** Form submitted. Returns the private reply. */
  async submit(userId: string, input: ColourRequestInput): Promise<string> {
    const access = await this.access(userId);
    if (!access.ok) return access.message;
    const existing = (await this.colours.options()).map((o) => o.name);
    const pending = (await this.db.colourRequest.findMany({ where: { status: 'pending' } })).map((r) => r.name);
    const blocked = (await this.db.blockedWord.findMany()).map((w) => w.word);
    const check = checkColourRequest(input, { existingNames: [...existing, ...pending], blockedWords: blocked });
    if (!check.ok) return `❌ Couldn't send your request:\n${check.errors.map((e) => `• ${e}`).join('\n')}`;
    const v = check.value;
    const row = await this.db.colourRequest.create({ data: { userId, ...v, createdAt: this.clock.now() } });
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(COLOUR_REQUEST_APPROVE_ID).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(COLOUR_REQUEST_DECLINE_ID).setLabel('Decline').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    );
    const messageId = await this.modLog.post(`🎨 <@${userId}> suggested a VIP colour: **${v.name}** ${v.hex} → ${v.hex2}`, undefined, { components: [buttons], colour: Number.parseInt(v.hex.slice(1), 16) });
    if (!messageId) {
      await this.db.colourRequest.delete({ where: { id: row.id } });
      return '❌ Couldn’t reach the staff log channel. Ask an admin to set one with `/settings channel purpose:mod-log`.';
    }
    await this.db.colourRequest.update({ where: { id: row.id }, data: { messageId } });
    return `✅ Sent! Staff will look at **${v.name}** (${v.hex} → ${v.hex2}). You'll see it in the colour menu if it's approved.`;
  }

  /** A staff button on the mod-log message. Returns the private reply. */
  async decide(messageId: string, actorId: string, approve: boolean): Promise<string> {
    // Only one staff member's click counts, even if two press at once.
    const { count } = await this.db.colourRequest.updateMany({
      where: { messageId, status: 'pending' },
      data: { status: approve ? 'approved' : 'declined', decidedBy: actorId, decidedAt: this.clock.now() },
    });
    const req = await this.db.colourRequest.findUnique({ where: { messageId } });
    if (!req) return 'That request no longer exists.';
    if (!count) return `This request was already ${req.status} by <@${req.decidedBy}>.`;
    await this.db.auditLog.create({ data: { action: approve ? 'colour.request.approve' : 'colour.request.decline', actorId, targetId: req.userId, data: { name: req.name, hex: req.hex, hex2: req.hex2 } } });
    if (!approve) {
      await this.modLog.post(`🎨 <@${actorId}> declined <@${req.userId}>'s colour **${req.name}**`);
      return `Declined **${req.name}**.`;
    }
    const added = await this.colours.addOption(req.name, req.hex, actorId, req.hex2);
    if (!added.startsWith('✅')) {
      await this.db.colourRequest.update({ where: { id: req.id }, data: { status: 'pending', decidedBy: null, decidedAt: null } });
      return added;
    }
    const problems = (await this.afterAdd()).filter((l) => !l.startsWith('✅'));
    await this.modLog.post(`🎨 <@${actorId}> approved <@${req.userId}>'s colour **${req.name}** (${req.hex} → ${req.hex2})`);
    return [`✅ Added **${req.name}** to the VIP colours.`, ...problems].join('\n');
  }
}
