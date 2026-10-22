// Shared by backup.mjs and restore.mjs: turns a connection string into libpq PG*
// variables, so the password never appears in a process list or log, and TLS is
// always verified ("verify-full") except for a local database without a CA.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function fail(message) {
  console.error(`failed: ${message}`);
  process.exit(1);
}

/** @param caCert PEM text of the CA certificate, or undefined. @param workDir where to write it. */
export function pgEnv(databaseUrl, caCert, workDir) {
  const url = new URL(databaseUrl);
  const env = {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)) || 'postgres',
    PGCONNECT_TIMEOUT: '20',
  };
  if (LOCAL_HOSTS.has(url.hostname) && !caCert) return env;
  if (!caCert) fail('the Supabase CA certificate is required for a remote database.');
  const caFile = join(workDir, 'ca.crt');
  writeFileSync(caFile, caCert.endsWith('\n') ? caCert : `${caCert}\n`);
  return { ...env, PGSSLMODE: 'verify-full', PGSSLROOTCERT: caFile };
}
