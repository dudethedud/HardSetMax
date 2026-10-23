// Finding roles and channels that already exist (so /bot setup reuses them instead
// of making duplicates), and checking a role can be bound to a bot function. Pure.

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The first item whose name matches one of `names` (ignoring case and spacing), skipping `skip`. */
export function pickByName<T extends { name: string }>(items: Iterable<T>, names: readonly string[], skip: (item: T) => boolean = () => false): T | undefined {
  const list = [...items].filter((item) => !skip(item)); // `items` may be a one-time iterator
  for (const name of names.map(norm)) {
    const hit = list.find((item) => norm(item.name) === name);
    if (hit) return hit;
  }
  return undefined;
}

export interface BindableRole {
  id: string;
  managed: boolean;
  position: number;
}

/** Why a role can't be bound to a bot function, or null if it can. */
export function bindRoleError(role: BindableRole, opts: { everyoneId: string; botTopPosition: number; usedElsewhere: boolean }): string | null {
  if (role.id === opts.everyoneId) return "@everyone can't be used.";
  if (role.managed) return "That role belongs to a bot or integration, so it can't be used.";
  if (role.position >= opts.botTopPosition) return "That role is above the bot's highest role. Drag the bot's role higher first.";
  if (opts.usedElsewhere) return 'That role is already used for something else by the bot.';
  return null;
}
