// Role order (SPEC §12). Pure. Orders are role IDs from the bottom (@everyone)
// to the top, like Discord's role positions.

/** The order after moving `roleId` directly above (or below) `anchorId`. */
export function moveNextTo(order: readonly string[], roleId: string, anchorId: string, side: 'above' | 'below'): string[] {
  if (roleId === anchorId || !order.includes(roleId) || !order.includes(anchorId)) return [...order];
  const next = order.filter((id) => id !== roleId);
  const anchor = next.indexOf(anchorId);
  next.splice(side === 'above' ? anchor + 1 : anchor, 0, roleId);
  return next;
}

/**
 * The position updates that turn `before` into `after`: only roles whose place
 * changed, each given the raw position of the slot it moves into. Roles that
 * don't move (like the bot's own role) are never sent, so Discord can't refuse
 * the change for touching a role above the bot.
 */
export function positionChanges(before: readonly string[], after: readonly string[], rawPositions: ReadonlyMap<string, number>): { id: string; position: number }[] {
  const changes: { id: string; position: number }[] = [];
  after.forEach((id, i) => {
    if (before[i] !== id) changes.push({ id, position: rawPositions.get(before[i]!)! });
  });
  return changes;
}
