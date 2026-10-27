// Needs a real Postgres with migrations applied: set TEST_DATABASE_URL to run.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { Collection, GuildFeature, type Client } from 'discord.js';
import { ConfigStore } from '../config/configStore.js';
import type { Candidate, ReshuffleResult } from '../core/reshuffle.js';
import { createDb, type Db } from '../db/prisma.js';
import type { Clock } from './clock.js';
import { CrownService } from './crown.js';
import type { ModLog } from './modLog.js';
import type { RoleOp, RoleQueue } from './roleQueue.js';

const url = process.env['TEST_DATABASE_URL'];
const log = pino({ level: process.env['TEST_LOG'] ?? 'silent' });
const GUILD = '900000000000000001';
const CROWN_ROLE = '900000000000000080';
const STAFF_ROLE = '900000000000000098';
const id = (n: number) => `1000000000000000${String(n).padStart(2, '0')}`;
const MONDAY = '2026-10-26';
const NOW = new Date('2026-10-26T06:00:30Z'); // Monday 00:00:30 MDT (MST from Nov 1)

const cand = (n: number, score: number): Candidate => ({ userId: id(n), score, activeDays: 1, lastDayScore: 0, lastActiveDay: '2026-10-25', eligibility: 'eligible' });
const result = (ranked: Candidate[], finalVips: number[]): ReshuffleResult => ({ ranked, finalVips: finalVips.map(id), added: [], removed: [] });

describe.skipIf(!url)('Crown', () => {
  const db: Db = createDb({ connectionString: url }, 3);
  let clockNow = NOW;
  const clock: Clock = { offsetMinutes: 0, now: () => clockNow };

  beforeEach(async () => {
    clockNow = NOW;
    await db.$transaction([
      db.crownHolder.deleteMany(),
      db.customRole.deleteMany(),
      db.blockedWord.deleteMany(),
      db.modalDraft.deleteMany(),
      db.staffRole.deleteMany(),
      db.jobRun.deleteMany(),
      db.guildConfig.deleteMany({ where: { guildId: GUILD } }),
    ]);
    await db.guildConfig.create({ data: { guildId: GUILD, crownRoleId: CROWN_ROLE } });
    await db.staffRole.create({ data: { roleId: STAFF_ROLE } });
  });
  afterAll(() => db.$disconnect());
  afterEach(() => vi.unstubAllGlobals());

  async function setup(members: number[], premiumTier = 2, gradients = false) {
    const memberRoles = new Map(members.map((n) => [id(n), new Set<string>()]));
    let nextRole = 0;
    type FakeRole = { id: string; name: string; position: number; colour: number; colour2?: number | null; emoji?: string | null; icon?: Buffer | null; members: Collection<string, unknown> };
    type RoleOpts = { name?: string; colors?: { primaryColor: number; secondaryColor?: number | null }; unicodeEmoji?: string | null; icon?: Buffer | null };
    const roles = new Collection<string, FakeRole>();
    const addRole = (r: Omit<FakeRole, 'members'>) => {
      const role = {
        ...r,
        get members() {
          return new Collection([...memberRoles].filter(([, set]) => set.has(r.id)).map(([uid]) => [uid, {}]));
        },
        edit(o: RoleOpts) {
          if (o.name) role.name = o.name;
          if (o.colors) [role.colour, role.colour2] = [o.colors.primaryColor, o.colors.secondaryColor ?? null];
          if (o.unicodeEmoji !== undefined) role.emoji = o.unicodeEmoji;
          if (o.icon !== undefined) role.icon = o.icon;
          return Promise.resolve(role);
        },
        setPosition: (p: number) => ((role.position = p), Promise.resolve(role)),
        delete: () => (roles.delete(role.id), Promise.resolve()),
      };
      // Discord's raw position: the same number as `position` in this fake.
      Object.defineProperty(role, 'rawPosition', { get: () => role.position });
      roles.set(r.id, role);
      return role;
    };
    addRole({ id: GUILD, name: '@everyone', position: 0, colour: 0 });
    addRole({ id: CROWN_ROLE, name: '👑 Crown', position: 20, colour: 0 });
    addRole({ id: STAFF_ROLE, name: 'Moderator', position: 30, colour: 0 });
    const botRole = addRole({ id: '900000000000000099', name: 'Bot', position: 40, colour: 0 });
    const guild = {
      id: GUILD,
      premiumTier,
      features: gradients ? [GuildFeature.EnhancedRoleColors] : [],
      members: { cache: { has: (uid: string) => memberRoles.has(uid) }, me: { roles: { highest: botRole } } },
      roles: {
        cache: roles,
        fetch: () => Promise.resolve(roles),
        setPositions: (list: { role: string; position: number }[]) => {
          for (const { role, position } of list) roles.get(role)!.position = position;
          return Promise.resolve();
        },
        create: (o: RoleOpts & { name: string; colors: { primaryColor: number } }) =>
          Promise.resolve(
            addRole({ id: `90000000000000100${nextRole++}`, name: o.name, position: 1, colour: o.colors.primaryColor, colour2: o.colors.secondaryColor ?? null, emoji: o.unicodeEmoji, icon: o.icon }),
          ),
      },
    };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
    const queue = {
      run: (op: RoleOp) => {
        const set = memberRoles.get(op.userId);
        if (set && op.action === 'add') set.add(op.roleId);
        if (set && op.action === 'remove') set.delete(op.roleId);
        return Promise.resolve({ ok: true });
      },
    } as unknown as RoleQueue;
    const modLines: string[] = [];
    const modImages: { name: string; data: Buffer }[] = [];
    const modLog = { post: (t: string, image?: { name: string; data: Buffer }) => (modLines.push(t), image && modImages.push(image), Promise.resolve()) } as unknown as ModLog;
    const config = new ConfigStore(db, GUILD);
    await config.load();
    const crown = new CrownService(client, GUILD, db, config, queue, modLog, clock, log);
    return { crown, memberRoles, roles, modLines, modImages };
  }

  const good = { name: 'Sunset Club', hex: '#FF8800', emoji: '🔥' };

  it('the week’s first reshuffle crowns the top member of the new VIP list, once', async () => {
    const t = await setup([1, 2, 3]);
    expect(await t.crown.afterReshuffle(MONDAY, result([cand(1, 90), cand(2, 80)], [2, 1]))).toBe(id(1));
    expect(t.memberRoles.get(id(1))!.has(CROWN_ROLE)).toBe(true);
    // Tuesday's reshuffle in the same week doesn't change it.
    expect(await t.crown.afterReshuffle('2026-10-27', result([cand(2, 99)], [2]))).toBeNull();
    expect((await t.crown.current())?.userId).toBe(id(1));
  });

  it('if Monday was missed, the first reshuffle later that week awards it', async () => {
    const t = await setup([1]);
    expect(await t.crown.afterReshuffle('2026-10-28', result([cand(1, 90)], [1]))).toBe(id(1));
    expect((await t.crown.current())?.weekStart).toBe(MONDAY);
  });

  it('no VIPs: no Crown that week, and later reshuffles that week don’t award one', async () => {
    const t = await setup([1]);
    expect(await t.crown.afterReshuffle(MONDAY, result([], []))).toBeNull();
    expect(await t.crown.afterReshuffle('2026-10-27', result([cand(1, 50)], [1]))).toBeNull();
    expect(await t.crown.current()).toBeNull();
  });

  it('next week: the new winner gets it, the old holder loses the role and their custom role (settings kept)', async () => {
    const t = await setup([1, 2]);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    expect((await t.crown.submit(id(1), good)).ok).toBe(true);
    const custom = await db.customRole.findUniqueOrThrow({ where: { userId: id(1) } });
    expect(t.memberRoles.get(id(1))!.has(custom.roleId!)).toBe(true);

    clockNow = new Date('2026-11-02T07:00:30Z');
    expect(await t.crown.afterReshuffle('2026-11-02', result([cand(2, 90), cand(1, 80)], [1, 2]))).toBe(id(2));
    expect(t.memberRoles.get(id(1))!.has(CROWN_ROLE)).toBe(false);
    expect(t.roles.has(custom.roleId!)).toBe(false);
    expect(await db.customRole.findUniqueOrThrow({ where: { userId: id(1) } })).toMatchObject({ name: 'Sunset Club', roleId: null });

    // Winning again later recreates it automatically.
    clockNow = new Date('2026-11-09T07:00:30Z');
    await t.crown.afterReshuffle('2026-11-09', result([cand(1, 99)], [1]));
    const back = await db.customRole.findUniqueOrThrow({ where: { userId: id(1) } });
    expect(back.roleId).not.toBeNull();
    expect(t.roles.get(back.roleId!)?.name).toBe('Sunset Club');
  });

  it('losing VIP mid-week takes the Crown and custom role, and nobody else gets it that week', async () => {
    const t = await setup([1, 2]);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90), cand(2, 80)], [1, 2]));
    await t.crown.submit(id(1), good);
    await t.crown.onVipRemoved(id(1), 'timed out');
    expect(await t.crown.current()).toBeNull();
    expect(t.memberRoles.get(id(1))!.has(CROWN_ROLE)).toBe(false);
    expect(await db.customRole.findUniqueOrThrow({ where: { userId: id(1) } })).toMatchObject({ roleId: null });
    expect(await t.crown.afterReshuffle('2026-10-27', result([cand(2, 90)], [2]))).toBeNull();
    // Someone else losing VIP does nothing.
    await t.crown.onVipRemoved(id(2), 'left');
  });

  it('only the Crown holder can open the form', async () => {
    const t = await setup([1, 2]);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    expect((await t.crown.formAccess(id(2))).ok).toBe(false);
    expect(await t.crown.formAccess(id(1))).toEqual({ ok: true, prefill: null });
  });

  it('a rejected form saves a draft for "Try again", which expires after 15 minutes', async () => {
    const t = await setup([1]);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    const bad = { name: 'M0derator', hex: '#000000', emoji: '' };
    const r = await t.crown.submit(id(1), bad);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.length).toBe(2);
    expect(await t.crown.formAccess(id(1))).toEqual({ ok: true, prefill: { ...bad, hex2: '', hasImage: false } });
    clockNow = new Date(NOW.getTime() + 16 * 60_000);
    expect(await t.crown.formAccess(id(1))).toEqual({ ok: true, prefill: null });
  });

  it('creates the role above the Crown role; 3 edits per week, then refuses', async () => {
    const t = await setup([1]);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    expect((await t.crown.submit(id(1), good)).ok).toBe(true);
    const roleId = (await db.customRole.findUniqueOrThrow({ where: { userId: id(1) } })).roleId!;
    expect(t.roles.get(roleId)).toMatchObject({ name: 'Sunset Club', colour: 0xff8800, emoji: '🔥' });
    // Directly above the Crown role: nothing in between.
    const byPos = [...t.roles.values()].sort((a, b) => a.position - b.position).map((r) => r.id);
    expect(byPos.indexOf(roleId)).toBe(byPos.indexOf(CROWN_ROLE) + 1);
    for (const n of [1, 2, 3]) expect((await t.crown.submit(id(1), { ...good, name: `Sunset ${n}` })).ok).toBe(true);
    const fourth = await t.crown.submit(id(1), { ...good, name: 'Sunset 4' });
    expect(fourth.ok).toBe(false);
    expect(t.roles.get(roleId)?.name).toBe('Sunset 3');
  });

  it('can’t take the name of a staff role or a blocked word; can keep its own name', async () => {
    const t = await setup([1]);
    await db.blockedWord.create({ data: { word: 'rude' } });
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    expect((await t.crown.submit(id(1), { ...good, name: 'Moderator Squad' })).ok).toBe(false);
    expect((await t.crown.submit(id(1), { ...good, name: 'Ru de' })).ok).toBe(false);
    expect((await t.crown.submit(id(1), good)).ok).toBe(true);
    expect((await t.crown.submit(id(1), { ...good, hex: '#00FF00' })).ok).toBe(true); // same name as its own role
  });

  it('a second colour makes a gradient only where the server has gradient roles', async () => {
    const t = await setup([1], 2, true);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    expect((await t.crown.submit(id(1), { ...good, hex2: '#9B8CFF' })).ok).toBe(true);
    const roleId = (await db.customRole.findUniqueOrThrow({ where: { userId: id(1) } })).roleId!;
    expect(t.roles.get(roleId)).toMatchObject({ colour: 0xff8800, colour2: 0x9b8cff });
    // Dropping the second colour clears the gradient.
    expect((await t.crown.submit(id(1), good)).ok).toBe(true);
    expect(t.roles.get(roleId)).toMatchObject({ colour: 0xff8800, colour2: null });

    const plain = await setup([1], 2, false);
    await db.customRole.deleteMany();
    const r = await plain.crown.submit(id(1), { ...good, hex2: '#9B8CFF' });
    expect(r.ok && r.message).toMatch(/only your first colour/);
    const plainId = (await db.customRole.findUniqueOrThrow({ where: { userId: id(1) } })).roleId!;
    expect(plain.roles.get(plainId)).toMatchObject({ colour: 0xff8800, colour2: null });
  });

  it('an uploaded image becomes the icon, is shown in the mod-log, and stays until replaced by an emoji', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const fetchMock = vi.fn(() => Promise.resolve(new Response(png)));
    vi.stubGlobal('fetch', fetchMock);
    const t = await setup([1]);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    const upload = { url: 'https://cdn.discordapp.com/attachments/1/2/icon.png', contentType: 'image/png', size: png.length };
    expect((await t.crown.submit(id(1), good, upload)).ok).toBe(true);
    const saved = await db.customRole.findUniqueOrThrow({ where: { userId: id(1) } });
    expect(Buffer.from(saved.iconImage!)).toEqual(png);
    expect(t.roles.get(saved.roleId!)).toMatchObject({ icon: png, emoji: null });
    expect(t.modImages).toEqual([{ name: 'icon.png', data: png }]);
    expect(t.modLines.at(-1)).toMatch(/crown-reset/);

    // Editing without a new upload or emoji keeps the image.
    expect((await t.crown.submit(id(1), { ...good, emoji: '' })).ok).toBe(true);
    expect(t.roles.get(saved.roleId!)).toMatchObject({ icon: png });
    expect((await t.crown.formAccess(id(1))).ok && (await t.crown.formAccess(id(1)))).toMatchObject({ prefill: { hasImage: true } });
    // An emoji replaces it.
    expect((await t.crown.submit(id(1), good)).ok).toBe(true);
    expect(t.roles.get(saved.roleId!)).toMatchObject({ icon: null, emoji: '🔥' });
    expect((await db.customRole.findUniqueOrThrow({ where: { userId: id(1) } })).iconImage).toBeNull();
  });

  it('refuses images from outside Discord or that are not really PNG/JPG', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>not an image</html>'))));
    const t = await setup([1]);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    const r = await t.crown.submit(id(1), good, { url: 'https://cdn.discordapp.com/attachments/1/2/icon.png', contentType: 'image/png', size: 30 });
    expect(!r.ok && r.errors[0]).toMatch(/PNG or JPG/);
    const r2 = await t.crown.submit(id(1), good, { url: 'https://example.com/icon.png', contentType: 'image/png', size: 30 });
    expect(!r2.ok && r2.errors[0]).toMatch(/uploaded to Discord/);
    expect(await db.customRole.findUnique({ where: { userId: id(1) } })).toBeNull();
  });

  it('ignores the emoji below boost level 2', async () => {
    const t = await setup([1], 1);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    const r = await t.crown.submit(id(1), good);
    expect(r.ok && r.message).toContain('Boost Level 2');
  });

  it('locked members can’t open the form; reset deletes role and settings', async () => {
    const t = await setup([1]);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    await t.crown.submit(id(1), good);
    await t.crown.setLocked(id(1), true, id(9));
    expect((await t.crown.formAccess(id(1))).ok).toBe(false);
    await t.crown.setLocked(id(1), false, id(9));
    expect(await t.crown.resetRole(id(1), id(9))).toBe(true);
    expect(await db.customRole.count()).toBe(0);
  });

  it('reconcile: only the holder has the Crown role; others lose stray custom roles', async () => {
    const t = await setup([1, 2]);
    await t.crown.afterReshuffle(MONDAY, result([cand(1, 90)], [1]));
    t.memberRoles.get(id(2))!.add(CROWN_ROLE);
    t.memberRoles.get(id(1))!.delete(CROWN_ROLE);
    await t.crown.reconcile();
    expect(t.memberRoles.get(id(2))!.has(CROWN_ROLE)).toBe(false);
    expect(t.memberRoles.get(id(1))!.has(CROWN_ROLE)).toBe(true);
  });
});
