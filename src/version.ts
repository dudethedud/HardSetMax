import { readFileSync } from 'node:fs';

// The one-file bundle (scripts/bundle.mjs) bakes the version in; from source it's
// read from package.json (one level up from both src/ and dist/).
declare const __BOT_VERSION__: string | undefined;

export const VERSION: string =
  typeof __BOT_VERSION__ === 'string'
    ? __BOT_VERSION__
    : (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
