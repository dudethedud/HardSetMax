// Restores an encrypted backup from backup.mjs into an EMPTY database (a new
// Supabase project), then the bot can be pointed at it. It never overwrites
// existing data: it refuses if the target already has tables.
//
//   RESTORE_DATABASE_URL  session pooler string of the new, empty database
//   RESTORE_CA_CERT       path to the Supabase CA certificate (optional for localhost)
//   PG_BIN                directory with pg_restore/psql (optional)
//
// Usage: node scripts/restore.mjs <backup .dump.age file> <age private key file>
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, pgEnv as buildPgEnv } from './pg-env.mjs';

const [backupFile, keyFile] = process.argv.slice(2);
const { RESTORE_DATABASE_URL, RESTORE_CA_CERT, PG_BIN } = process.env;
if (!backupFile || !keyFile) fail('usage: node scripts/restore.mjs <backup .dump.age file> <age private key file>');
if (!RESTORE_DATABASE_URL) fail('RESTORE_DATABASE_URL is not set.');

const work = mkdtempSync(join(tmpdir(), 'vipbot-restore-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
const pgEnv = buildPgEnv(RESTORE_DATABASE_URL, RESTORE_CA_CERT && readFileSync(RESTORE_CA_CERT, 'utf8'), work);
const bin = (name) => (PG_BIN ? join(PG_BIN, name) : name);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(cmd, args, { env: { ...process.env, ...pgEnv }, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

try {
  const tables = Number((await run(bin('psql'), ['-tAc', "select count(*) from pg_tables where schemaname = 'public'"])).trim());
  if (tables > 0) fail(`the target database already has ${tables} table(s) in "public". Restore into a new, empty database.`);

  const dump = join(work, 'vipbot.dump');
  await run('age', ['--decrypt', '--identity', keyFile, '--output', dump, backupFile]);

  // The target already has a "public" schema, so skip creating it.
  const list = (await run(bin('pg_restore'), ['--list', dump]))
    .split('\n')
    .filter((line) => !/ SCHEMA - public | COMMENT - SCHEMA public /.test(line))
    .join('\n');
  const listFile = join(work, 'list.txt');
  writeFileSync(listFile, list);

  await run(bin('pg_restore'), ['--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', `--use-list=${listFile}`, `--dbname=${pgEnv.PGDATABASE}`, dump]);
} catch (err) {
  fail(err.message);
}
console.log('restore finished. Point DATABASE_URL at this database and restart the bot.');
