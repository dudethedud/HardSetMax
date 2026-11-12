// Server emojis by name (pure). Text uses `{name|fallback}` placeholders: the
// server's emoji with that name (any case), or the fallback when it's been renamed
// or deleted, so a message never shows a broken emoji code.

const TOKEN = /\{([A-Za-z0-9_]{2,32})\|([^{}]*)\}/g;

/** `lookup(name)` returns the emoji's message form (e.g. `<a:animBlueHeart:123>`), or null. */
export function fillEmojis(template: string, lookup: (name: string) => string | null): string {
  return template.replace(TOKEN, (_, name: string, fallback: string) => lookup(name) ?? fallback);
}
