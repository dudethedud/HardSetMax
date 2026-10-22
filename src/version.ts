import { readFileSync } from 'node:fs';

// Works from both src/ (tsx) and dist/ (node): package.json is one level up.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const VERSION = pkg.version;
