// Entry point of the one-file bundle (scripts/bundle.mjs) that runs on the host:
// applies database migrations without the Prisma CLI, then starts the bot.
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config/env.js';
import { explainDbError, pgConfig } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
try {
  await runMigrations(pgConfig(env.DATABASE_URL, { caCertPath: env.DATABASE_CA_CERT }), fileURLToPath(new URL('./migrations/', import.meta.url)), log);
} catch (err) {
  log.fatal({ err, hint: explainDbError(err) ?? undefined }, 'database migration failed; not starting the bot');
  process.exit(1);
}
await import('./index.js');
