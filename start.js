// Production entry point: applies database migrations, then starts the bot.
// `npm start` runs this; hosts that run a JS file directly (Wispbyte's Node.js
// server) should point at this file.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Prisma's migration engine only checks the server's TLS certificate with
// `sslaccept=strict`, and takes the CA file as `sslcert`. Verify it the same way the
// bot does (src/db/connection.ts).
function migrateUrl(databaseUrl, caCertPath) {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode === 'disable' || (LOCAL_HOSTS.has(url.hostname) && !sslmode)) return databaseUrl;
  url.searchParams.set('sslmode', 'require');
  url.searchParams.set('sslaccept', 'strict');
  if (caCertPath) url.searchParams.set('sslcert', resolve(caCertPath));
  return url.toString();
}

const { DATABASE_URL, DATABASE_CA_CERT } = process.env;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set. See docs/OPERATIONS.md.');
  process.exit(1);
}

const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
// Only `migrate deploy`: never `migrate reset` or `db push` (CLAUDE.md).
const migrate = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: migrateUrl(DATABASE_URL, DATABASE_CA_CERT) },
});
if (migrate.status !== 0) {
  console.error('Database migration failed; not starting the bot.');
  if (!DATABASE_CA_CERT) {
    console.error("If the error mentions TLS or a certificate, set DATABASE_CA_CERT to the database's CA file. See docs/OPERATIONS.md.");
  }
  process.exit(migrate.status ?? 1);
}

await import('./dist/index.js');
