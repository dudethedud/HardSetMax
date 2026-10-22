import { PrismaPg } from '@prisma/adapter-pg';
import type { ClientConfig } from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type Db = PrismaClient;

export function createDb(connection: ClientConfig, poolMax: number): Db {
  return new PrismaClient({ adapter: new PrismaPg({ ...connection, max: poolMax }) });
}
