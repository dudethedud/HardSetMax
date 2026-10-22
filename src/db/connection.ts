// Postgres connection settings for the `pg` driver (Prisma adapter and the
// gateway-leader connection).
//
// TLS: hosted Postgres (Supabase) is always reached over TLS with the server
// certificate verified. Supabase signs its certificates with its own CA, so its
// CA file is passed via DATABASE_CA_CERT. TLS is only skipped for a local database
// or an explicit `sslmode=disable`.
import { readFileSync } from 'node:fs';
import type { ClientConfig } from 'pg';

// Connection-string TLS params. They're removed before handing the URL to `pg`,
// because `pg` lets them override the `ssl` object built here.
const SSL_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslaccept', 'uselibpqcompat'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface DbConnectionOptions {
  /** Path to a PEM CA certificate to verify the server against. */
  caCertPath?: string | undefined;
  /** Reads the CA file; replaceable in tests. */
  readFile?: (path: string) => string;
}

export function pgConfig(databaseUrl: string, { caCertPath, readFile = (p) => readFileSync(p, 'utf8') }: DbConnectionOptions = {}): ClientConfig {
  const url = new URL(databaseUrl);
  const sslmode = url.searchParams.get('sslmode');
  for (const p of SSL_PARAMS) url.searchParams.delete(p);
  const connectionString = url.toString();

  if (caCertPath) return { connectionString, ssl: { ca: readFile(caCertPath) } };
  if (sslmode === 'disable' || (LOCAL_HOSTS.has(url.hostname) && !sslmode)) return { connectionString };
  // Verified against the system's trusted CAs.
  return { connectionString, ssl: true };
}

/** A hint for errors that mean the database's certificate couldn't be verified. */
export function explainDbError(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return "The database's TLS certificate isn't trusted. For Supabase, download its SSL certificate (Database settings) and set DATABASE_CA_CERT to the file's path. See docs/OPERATIONS.md.";
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return "The database's TLS certificate doesn't match its hostname. Check DATABASE_URL uses the host shown in the Supabase dashboard.";
  }
  return null;
}
