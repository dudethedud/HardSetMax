// Nightly backup (SPEC §11): dumps the bot's tables with pg_dump, checks the dump
// is readable, and encrypts it with `age` for a public key. Only the matching
// private key, kept offline by the owner, can decrypt it. Run by
// .github/workflows/backup.yml; can also be run by hand.
//
//   BACKUP_DATABASE_URL   Supabase session pooler string (secret)
//   BACKUP_CA_CERT        Supabase CA certificate, PEM text (optional for localhost)
//   BACKUP_AGE_RECIPIENT  age public key, "age1..."
//   PG_BIN                directory with pg_dump/pg_restore (optional)
//
// Usage: node scripts/backup.mjs <output dir>
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, pgEnv as buildPgEnv } from './pg-env.mjs';

const { BACKUP_DATABASE_URL, BACKUP_CA_CERT, BACKUP_AGE_RECIPIENT, PG_BIN } = process.env;
const outDir = process.argv[2] ?? 'backup';
if (!BACKUP_DATABASE_URL) fail('BACKUP_DATABASE_URL is not set (GitHub secret).');
if (!BACKUP_AGE_RECIPIENT?.startsWith('age1')) fail('BACKUP_AGE_RECIPIENT must be an age public key starting with "age1" (GitHub variable).');

const work = mkdtempSync(join(tmpdir(), 'vipbot-backup-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const pgEnv = buildPgEnv(BACKUP_DATABASE_URL, BACKUP_CA_CERT, work);

const bin = (name) => (PG_BIN ? join(PG_BIN, name) : name);

function run(cmd, args, { stdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...pgEnv },
      stdio: ['ignore', stdout ? 'pipe' : 'inherit', 'inherit'],
    });
    if (stdout) child.stdout.pipe(stdout);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

// A file name, not day logic: UTC so backups sort in order.
const stamp = new Date().toISOString().replace(/:\d\d\.\d+Z$/, 'Z').replace(':', '');
const dump = join(work, 'vipbot.dump');
const listing = join(work, 'listing.txt');
mkdirSync(outDir, { recursive: true });
const encrypted = join(outDir, `vipbot-${stamp}.dump.age`);

try {
  // Only the bot's own tables (schema "public"), not Supabase's internal schemas.
  await run(bin('pg_dump'), ['--format=custom', '--schema=public', '--no-owner', '--no-privileges', `--file=${dump}`]);
  const out = createWriteStream(listing);
  await run(bin('pg_restore'), ['--list', dump], { stdout: out });
  await run('age', ['--encrypt', '--recipient', BACKUP_AGE_RECIPIENT, '--output', encrypted, dump]);
} catch (err) {
  fail(err.message);
}
console.log(`backup written: ${encrypted}`);
