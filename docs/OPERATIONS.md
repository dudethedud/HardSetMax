# Operations

## Railway service settings
- **Build command:** `npm run build` (generates the Prisma client and compiles TypeScript).
- **Start command:** `npm start` (runs `prisma migrate deploy`, then the bot). Never `migrate reset` or `db push`.
- **Variables:** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GUILD_ID`, and `DATABASE_URL` as a reference variable to the Postgres service (`${{Postgres.DATABASE_URL}}`). Optional: `LOG_LEVEL` (default `info`).
- **Restart policy:** "On failure". The bot exits with code 1 when it loses the database connection that holds `gateway-leader`, and Railway restarts it.
- Turn off deploy overlap if the service settings offer it. The `gateway-leader` lock stops two copies connecting either way.

Slash commands are registered to `GUILD_ID` on every startup. `npm run register-commands` does the same thing by hand (needs dev dependencies).

## Phase 1 proof: data survives a redeploy

Do this on the test server after Phase 0 is set up.

1. Deploy the bot and wait for `connected to Discord` in the deploy logs.
2. In Discord, run `/bot health`. Check that Database, Gateway leader and Intents show ✅, and note the deploy ID in the Gateway leader line.
3. Run `/config set key:day-boundary value:04:30`, then `/config view`. It should show `day-boundary = 04:30`.
4. In Railway, click **Redeploy** on the bot service (or push a commit to `main`).
5. Watch the logs of the **new** deployment. If the old copy was still running, you'll see:
   ```
   another copy of the bot holds gateway-leader; waiting for it to exit
   acquired gateway-leader
   connected to Discord
   ```
   And in the **old** deployment's logs, before that:
   ```
   shutting down  (reason: SIGTERM)
   shutdown: discord done
   shutdown: database done
   released gateway-leader
   ```
   The new copy must not log `connected to Discord` until the old one has logged `released gateway-leader`. If Railway stopped the old copy before starting the new one, there's no "waiting" line, which is also fine.
6. Run `/bot health` again. The deploy ID should be the new one.
7. Run `/config view`. It must still show `day-boundary = 04:30`.
8. Put it back: `/config set key:day-boundary value:00:00`.

Every `/config set` is also saved in the `AuditLog` table (`action = 'config.set'`, with old and new values).

## Local development
1. Run Postgres locally and copy `.env.example` to `.env`, filling in a test bot's token and IDs.
2. `npm install`, then `npx prisma migrate dev` to apply migrations.
3. `npm run dev` starts the bot with reload on save.
4. Checks: `npm run typecheck`, `npm run lint`, `npm test`. To also run the `gateway-leader` lock tests against a real database, set `TEST_DATABASE_URL` first (otherwise they're skipped).
5. Schema changes: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <what-changed>` and commit the new migration folder. Migrations must not drop or rename columns that hold data without an approved plan (CLAUDE.md).

## Backups
Restore drill is written in Phase 10.
