// /bot setup's guesses about an existing server (owner-approved): which channels
// shouldn't count toward activity, which role is bleed's top level role, which
// channels are general chat / announcements / logs, and where VIP perks are blocked
// by a channel's own permissions. Pure. Setup reports every guess so admins can
// change it.

/** Channels where messages aren't real chat: bot commands, spam, counting games. */
const LOW_VALUE = /(^|[-_\s])(bots?|commands?|cmds?|spam|counting|count|bot-?spam)($|[-_\s])/i;

export function isLowValueChannel(name: string): boolean {
  return LOW_VALUE.test(name.replace(/[^\p{L}\p{N}\s_-]/gu, ''));
}

const LEVEL_ROLE = /\b(level|lvl|lv)\s*\.?\s*\d+\b/i;

/** bleed's highest level role: the top role named like "Level 50" that the bot can manage. */
export function pickLevelTop<R extends { id: string; name: string; position: number; managed: boolean }>(roles: Iterable<R>, botTopPosition: number): R | undefined {
  let best: R | undefined;
  for (const r of roles) {
    if (r.managed || r.position >= botTopPosition || !LEVEL_ROLE.test(r.name)) continue;
    if (!best || r.position > best.position) best = r;
  }
  return best;
}

const PURPOSES = {
  'main-chat': [/^(general|chat|main|main-?chat|general-?chat|lounge|hangout)$/i],
  announcements: [/announce/i, /^news$/i, /^updates?$/i],
  'mod-log': [/^(mod-?logs?|logs?|staff-?logs?|audit-?logs?|bot-?logs?|mod-?log)$/i, /mod.*log|log.*mod/i],
} as const;
export type ChannelPurpose = keyof typeof PURPOSES;

/** A channel for this purpose, by name; announcement-type channels win for announcements. */
export function pickChannel<C extends { id: string; name: string; isAnnouncement: boolean }>(channels: readonly C[], purpose: ChannelPurpose): C | undefined {
  const clean = (n: string) => n.replace(/[^\p{L}\p{N}_-]/gu, '').toLowerCase();
  if (purpose === 'announcements') {
    const typed = channels.find((c) => c.isAnnouncement);
    if (typed) return typed;
  }
  for (const re of PURPOSES[purpose]) {
    const hit = channels.find((c) => re.test(clean(c.name)));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The VIP perks a channel blocks with its own @everyone deny, which the VIP role's
 * permissions can't override. Channels @everyone can't see or post in are left
 * alone (VIPs couldn't use the perks there anyway).
 */
export function blockedVipPerks(c: { everyoneDeny: bigint; vipAllow: bigint; vipPerms: bigint; viewBit: bigint; sendBit: bigint }): bigint {
  if (c.everyoneDeny & c.viewBit || c.everyoneDeny & c.sendBit) return 0n;
  return c.everyoneDeny & c.vipPerms & ~c.vipAllow;
}

/** What a bot channel is for, which decides its category. */
export type ChannelHome = 'info' | 'chat';

const CATEGORY_NAMES: Record<ChannelHome, RegExp[]> = {
  info: [/\b(info|information|important|announce\w*|news|start|welcome|server)\b/i],
  chat: [/\b(chat|chats|community|general|social|main|text|hangout|lounge)\b/i],
};

/**
 * The category for a bot channel: where the matching server channel lives
 * (announcements for info, main chat for chat), otherwise a category named like
 * one, otherwise the other kind as a fallback. Never the VIP Lounge category.
 */
export function pickCategory(
  categories: readonly { id: string; name: string }[],
  home: ChannelHome,
  anchors: { info: string | null; chat: string | null },
  exclude: ReadonlySet<string> = new Set(),
): string | undefined {
  const allowed = categories.filter((c) => !exclude.has(c.id));
  const byAnchor = (h: ChannelHome) => {
    const id = anchors[h];
    return id && allowed.some((c) => c.id === id) ? id : undefined;
  };
  const byName = (h: ChannelHome) => {
    const clean = (n: string) => n.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ');
    for (const re of CATEGORY_NAMES[h]) {
      const hit = allowed.find((c) => re.test(clean(c.name)));
      if (hit) return hit.id;
    }
    return undefined;
  };
  const other: ChannelHome = home === 'info' ? 'chat' : 'info';
  return byAnchor(home) ?? byName(home) ?? byAnchor(other) ?? byName(other);
}
