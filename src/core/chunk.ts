// Splitting long replies to fit Discord's 2000-character message limit. Pure.

/** Joins lines into messages of at most `max` characters, breaking between lines (a single overlong line is cut). */
export function chunkLines(lines: readonly string[], max = 2000): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of lines) {
    const line = raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
    if (cur && cur.length + 1 + line.length > max) {
      out.push(cur);
      cur = line;
    } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
