import { PrismaPg } from '@prisma/adapter-pg';
import type { ClientConfig } from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type Db = PrismaClient;

/**
 * Opening a connection to a hosted database (TLS + login) can take a few seconds,
 * so idle connections are kept for a while and transactions may wait up to 20 s
 * for one. Prisma's default 2 s wait made the reshuffle fail with P2028 on a cold pool.
 */
export function createDb(connection: ClientConfig, poolMax: number): Db {
  return new PrismaClient({
    adapter: new PrismaPg({ ...connection, max: poolMax, idleTimeoutMillis: 5 * 60_000, connectionTimeoutMillis: 15_000, keepAlive: true }),
    transactionOptions: { maxWait: 20_000, timeout: 60_000 },
  });
}
