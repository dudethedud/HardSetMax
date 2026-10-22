import { pino } from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    // Never log credentials, even by accident.
    redact: ['token', '*.token', 'DISCORD_TOKEN', 'DATABASE_URL', '*.DATABASE_URL'],
  });
}
