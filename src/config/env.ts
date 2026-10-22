// Environment variables, validated once at startup. Secrets only ever come from here.
import 'dotenv/config';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: snowflake,
  GUILD_ID: snowflake,
  DATABASE_URL: z.string().url(),
  // Path to the database's CA certificate (Supabase's SSL certificate file).
  DATABASE_CA_CERT: z.string().min(1).optional(),
  // Prisma pool size. Supabase's free session pooler allows few connections, and
  // gateway-leader and migrations need one each on top of this.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Testing only: shifts the bot's clock for the reshuffle schedule, e.g. 600 to make
  // midnight happen 10 hours early. Leave unset in production.
  CLOCK_OFFSET_MINUTES: z.coerce.number().int().min(-10080).max(10080).default(0),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Name the bad variables, never their values.
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment variables:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
