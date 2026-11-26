// Environment variables, validated once at startup. Secrets only ever come from here.
import 'dotenv/config';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');
/** An optional setting where an empty value (`NAME=` in .env) means "not set". */
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

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
  // Donations: Ko-fi's verification token (Ko-fi → More → API). Without it, no
  // donation endpoint is opened.
  KOFI_VERIFICATION_TOKEN: z.string().min(8).optional(),
  // Port for the Ko-fi endpoint. Hosts like Wispbyte give one as SERVER_PORT.
  WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // Christmas invite event (docs/SPEC.md §8): on when LEADERBOARD_CHANNEL_ID and
  // LEVEL3_ROLE_ID are both set. The end is Edmonton time.
  INVITE_EVENT_END: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'must look like 2026-12-25T12:00').default('2026-12-25T12:00'),
  LEADERBOARD_CHANNEL_ID: optional(snowflake),
  LEVEL3_ROLE_ID: optional(snowflake),
  // Alt flags and event changes; without it they go to the /colours log channel.
  STAFF_LOG_CHANNEL_ID: optional(snowflake),
  // Where /invite-link makes personal invites; without it, the leaderboard channel.
  INVITE_LINK_CHANNEL_ID: optional(snowflake),
  // Check-in DMs for quiet members (docs/SPEC.md §9). "off" stops all check-ins.
  CHECKIN_DMS: z.enum(['on', 'off']).default('on'),
  EMBED_COLOR: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/, 'must be a hex colour like #a8d8f0')
    .default('#a8d8f0')
    .transform((c) => parseInt(c.replace('#', ''), 16)),
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
