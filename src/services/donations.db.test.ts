// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Collection, type Client } from 'discord.js';
import { createDb, type Db } from '../db/prisma.js';
import { DonationService } from './donations.js';

const url = process.env['TEST_DATABASE_URL'];
const GUILD = '900000000000000001';
const PANEL = '900000000000000060';
const LOG = '900000000000000061';
const DONOR_ROLE = '900000000000000062';
const ALICE = '100000000000000001';
const TOKEN = 'kofi-test-token';

const kofi = (over: Record<string, unknown> = {}) =>
  new URLSearchParams({
    data: JSON.stringify({ verification_token: TOKEN, message_id: 'k1', type: 'Donation', is_public: true, from_name: 'Bubbles', message: '', amount: '5.00', currency: 'USD', ...over }),
  }).toString();

describe.skipIf(!url)('donations', () => {
  const db: Db = createDb({ connectionString: url }, 3);

  beforeEach(async () => {
    await db.$transaction([db.donation.deleteMany(), db.donationCode.deleteMany(), db.donationSettings.deleteMany(), db.settings.deleteMany()]);
    await db.settings.create({ data: { guildId: GUILD, logChannelId: LOG } });
  });
  afterAll(() => db.$disconnect());

  function setup() {
    const sent: { channelId: string; opts: Record<string, unknown> }[] = [];
    const messages = new Map<string, { id: string; edits: unknown[]; edit: (o: unknown) => Promise<unknown> }>();
    const channel = (channelId: string) => ({
      id: channelId,
      isSendable: () => true,
      messages: { fetch: (id: string) => (messages.has(id) ? Promise.resolve(messages.get(id)) : Promise.reject(new Error('Unknown Message'))) },
      send: (opts: Record<string, unknown>) => {
        sent.push({ channelId, opts });
        const m = { id: `m${sent.length}`, edits: [] as unknown[], edit: (o: unknown) => (m.edits.push(o), Promise.resolve(m)) };
        messages.set(m.id, m);
        return Promise.resolve(m);
      },
    });
    const aliceRoles = new Collection<string, unknown>();
    const alice = { id: ALICE, displayName: 'Alice', roles: { cache: aliceRoles, add: (r: string) => (aliceRoles.set(r, {}), Promise.resolve()) } };
    const guild = { id: GUILD, members: { fetch: (id: string) => (id === ALICE ? Promise.resolve(alice) : Promise.reject(new Error('Unknown Member'))) } };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) }, channels: { fetch: (id: string) => Promise.resolve(channel(id)) } } as unknown as Client;
    let n = 0;
    const service = new DonationService(client, GUILD, db, pino({ level: 'silent' }), () => Uint8Array.from([n++, 1, 2, 3]));
    return { service, sent, messages, channel, aliceRoles };
  }

  const embedOf = (opts: Record<string, unknown>) => (opts['embeds'] as { toJSON(): { title?: string; fields?: { name: string; value: string }[] } }[])[0]!.toJSON();
  const text = (opts: Record<string, unknown>) => JSON.stringify((opts['components'] as { toJSON(): unknown }[]).map((c) => c.toJSON()));

  it('setup posts the panel; a bad Ko-fi link is refused', async () => {
    const t = setup();
    expect(await t.service.setup(t.channel(PANEL) as never, 'https://paypal.me/x')).toMatch(/Ko-fi page link/);
    expect(await t.service.setup(t.channel(PANEL) as never, 'https://ko-fi.com/softhearts')).toMatch(/posted/);
    expect(text(t.sent[0]!.opts)).toContain('Giveaway fund');
    expect(text(t.sent[0]!.opts)).toContain('$0.00');
  });

  it('a Ko-fi donation with a member’s code: thanked (only they are pinged), donor role, panel, log; counted once', async () => {
    const t = setup();
    await t.service.setup(t.channel(PANEL) as never, 'https://ko-fi.com/softhearts');
    await t.service.setDonorRole(DONOR_ROLE);
    const code = await t.service.codeFor(ALICE);
    expect(await t.service.codeFor(ALICE)).toBe(code);

    expect(await t.service.handleKofi(kofi({ message: `yay ${code.toLowerCase()}` }), TOKEN)).toBe(200);
    const thanks = t.sent.find((s) => s.channelId === PANEL && typeof s.opts['content'] === 'string')!;
    expect(thanks.opts).toMatchObject({ content: `💖 <@${ALICE}> donated **$5.00** to the **Giveaway fund**! Thank you so much!`, allowedMentions: { users: [ALICE] } });
    expect(t.aliceRoles.has(DONOR_ROLE)).toBe(true);
    const log = t.sent.find((s) => s.channelId === LOG)!;
    expect(embedOf(log.opts)).toMatchObject({ title: '💖 Donation' });
    expect(text(t.messages.get('m1')!.edits.at(-1) as Record<string, unknown>)).toContain('$5.00');

    // Ko-fi sending the same donation again changes nothing.
    const before = t.sent.length;
    expect(await t.service.handleKofi(kofi({ message: `yay ${code}` }), TOKEN)).toBe(200);
    expect(t.sent.length).toBe(before);
    expect(await db.donation.count()).toBe(1);
  });

  it('a private donation is anonymous; a wrong token is refused and nothing is saved', async () => {
    const t = setup();
    await t.service.setup(t.channel(PANEL) as never, 'https://ko-fi.com/softhearts');
    expect(await t.service.handleKofi(kofi({ verification_token: 'nope' }), TOKEN)).toBe(401);
    expect(await db.donation.count()).toBe(0);
    expect(await t.service.handleKofi(kofi({ message_id: 'k2', is_public: false, from_name: 'Secret Sam' }), TOKEN)).toBe(200);
    const thanks = t.sent.find((s) => typeof s.opts['content'] === 'string' && String(s.opts['content']).includes('donated'))!;
    expect(thanks.opts).toMatchObject({ content: '💖 Someone donated **$5.00** to the **Giveaway fund**! Thank you so much!', allowedMentions: { users: [] } });
    expect(JSON.stringify(t.sent)).not.toContain('Secret Sam');
  });

  it('totals, top donors and the goal bar; manual add/remove; reset starts from $0 but keeps history', async () => {
    const t = setup();
    await t.service.setup(t.channel(PANEL) as never, 'https://ko-fi.com/softhearts');
    expect(await t.service.setGoal(null, 2000)).toMatch(/goal \$20\.00/);
    await t.service.handleKofi(kofi({ message_id: 'k3', amount: '3.00' }), TOKEN);
    expect(await t.service.addManual(ALICE, 500, '100000000000000099')).toMatch(/Added \$5\.00/);
    const panel = text(await t.service.render());
    expect(panel).toContain('**$8.00** raised of **$20.00**');
    expect(panel).toContain('▰▰▰▰▱▱▱▱▱▱ 40%');
    expect(panel).toContain(`🥇 <@${ALICE}> · $5.00`);
    expect(panel).toContain('🥈 **Bubbles** · $3.00');
    const list = await t.service.list();
    expect(list).toMatch(/\$8\.00 from 2 donation/);
    const id = Number(/#(\d+) · \$3\.00/.exec(list)![1]);
    expect(await t.service.remove(id, '100000000000000099')).toMatch(/Removed/);
    expect(text(await t.service.render())).toContain('**$5.00** raised');
    expect(await t.service.reset('100000000000000099')).toMatch(/New round/);
    expect(text(await t.service.render())).toContain('**$0.00** raised');
    expect(await db.donation.count()).toBe(1);
  });

  it('the Donate button gives the member their code and the Ko-fi link', async () => {
    const t = setup();
    expect((await t.service.donateReply(ALICE)).content).toMatch(/aren’t set up/);
    await t.service.setup(t.channel(PANEL) as never, 'https://ko-fi.com/softhearts');
    const reply = await t.service.donateReply(ALICE);
    expect(reply.content).toContain(await t.service.codeFor(ALICE));
    expect(JSON.stringify((reply.components as { toJSON(): unknown }[])[0]!.toJSON())).toContain('https://ko-fi.com/softhearts');
  });
});
