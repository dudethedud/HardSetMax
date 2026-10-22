# Operations

The bot runs on a free **Wispbyte** Node.js server. Its data lives in a free **Supabase** Postgres database. Nothing important is stored on the Wispbyte server itself (SPEC §11).

**First-time setup, click by click: `docs/SETUP.md`.** This file is the reference.

## 1. Supabase (database)
1. Create a project at https://supabase.com. Save the database password somewhere safe. Pick the region closest to your Wispbyte server.
2. Click **Connect** and copy the **Session pooler** connection string. It looks like:
   ```
   postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
   Don't use the **Transaction pooler** (port 6543): the `gateway-leader` lock needs a session connection. The **Direct connection** string usually only works over IPv6, so most hosts can't use it.
3. Add `?sslmode=require` to the end. This is your `DATABASE_URL`.
4. In **Database** (left icon menu) **→ Settings → SSL Configuration**, click **Download certificate**. This is Supabase's CA certificate. It's public, not a secret. The bot uses it to check it's really talking to Supabase.
5. In the same place, turn on **Enforce SSL** if it's offered.

Keep the connection string secret: it contains the database password. It only goes in the `.env` file on the server, never in Git or chat.

## 2. Wispbyte (bot)
Settings are in the server's **Startup** tab. Names may differ slightly in Wispbyte's panel.

1. Create a **Node.js** server and pick **Node 22** (or newer) as the Docker image/version.
2. Point it at the GitHub repo `https://github.com/dudethedud/HardSetMax` with branch `main`, and turn on **auto update** (pull on start). If the repo is private, create a GitHub fine-grained token with read-only **Contents** access to this repo only, and enter it with your GitHub username.
3. Set the **main file** / startup file to `start.js`.
4. In the **File Manager**:
   - upload the Supabase certificate as `certs/supabase-ca.crt`
   - create a file called `.env`:
     ```
     DISCORD_TOKEN=...
     DISCORD_CLIENT_ID=...
     GUILD_ID=...
     DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
     DATABASE_CA_CERT=certs/supabase-ca.crt
     ```
   `.env` and `certs/` aren't in Git, so pulling updates keeps them.
5. Start the server. On each start it pulls `main`, runs `npm install` (which also builds: `prisma generate` and TypeScript), then `start.js` applies migrations with `prisma migrate deploy` and starts the bot.
6. **Log in to Wispbyte at least every 2 weeks**, or the free server stops. After 30 days stopped it's moved to storage, and nothing is deleted. Set a phone reminder.

**Updating the bot:** merge to `main`, then click **Restart** in the panel.

If the panel doesn't run `npm install` on start, run it once from the panel's install/reinstall option. The bot won't start without `dist/` and the generated Prisma client.

### Memory
The free server has 512 MB. Measured locally: the build (`tsc`) peaks around 280 MB and runs before the bot starts. The bot itself was around 175 MB at startup, before connecting to Discord.

### What the startup log should show
```
1 migration found in prisma/migrations
No pending migrations to apply.        (or "applied")
{"msg":"starting"}
{"msg":"acquired gateway-leader"}
{"msg":"registered guild commands"}
{"msg":"connected to Discord"}
```

### Common startup errors
| Log says | Fix |
|---|---|
| `Invalid environment variables` | A line in `.env` is missing or wrong. The message names it. |
| `P1011: Error opening a TLS connection` or `TLS certificate isn't trusted` | `DATABASE_CA_CERT` is missing or points to the wrong file. Re-download the certificate from Supabase. |
| `P1001: Can't reach database server` | Wrong host in `DATABASE_URL`, or the Supabase project is paused (open it in Supabase and click Restore). |
| `Discord refused the intents` | Turn on **Server Members** and **Message Content** in the Developer Portal. |
| `bot is not in GUILD_ID` | Invite the bot to the server, or fix `GUILD_ID`. |
| Server keeps restarting with no clear error | It may be out of memory. Check the panel's memory graph. |

## 3. Phase 1 proof: data survives a restart and update

Do this on the test server.

1. Start the bot and wait for `connected to Discord`.
2. In Discord, run `/bot health`. Database, Gateway leader and Intents should show ✅.
3. Run `/config set key:day-boundary value:04:30`, then `/config view`. It should show `day-boundary = 04:30`.
4. Click **Restart** in Wispbyte. When it's back, `/config view` must still show `04:30`.
5. **Second-copy check:** on your own computer, clone the repo, create the same `.env`, and run `npm install` then `npm start`. With the hosted bot still running, the local copy must log
   ```
   another copy of the bot holds gateway-leader; waiting for it to exit
   ```
   and must not log `connected to Discord`. Stop the local copy with Ctrl+C. It should exit at once.
6. Put the setting back: `/config set key:day-boundary value:00:00`.

Every `/config set` is also saved in the `AuditLog` table (`action = 'config.set'`, with old and new values). You can see it in Supabase's **Table Editor**.

## 4. Supabase limits to watch
- **500 MB** of database storage on the free plan. The bot stores counts and timestamps only, and prunes activity older than 60 days (Phase 10).
- Free projects **pause after a week with no activity**. A running bot keeps it active. If the bot was stopped for a week, restore the project in Supabase before restarting the bot.
- The session pooler allows a limited number of connections. The bot uses up to `DATABASE_POOL_MAX` (default 5), plus one for `gateway-leader` and one during migrations.

## 5. Backups
`.github/workflows/backup.yml` runs every night at 09:17 UTC (early morning in Edmonton), and can also be run by hand from the **Actions** tab. It:
1. dumps the bot's tables (schema `public` only) with `pg_dump` over verified TLS,
2. checks the dump can be read,
3. encrypts it with `age` for your public key, and keeps it as a workflow artifact for **30 days**.

GitHub never sees your data unencrypted. Only the private key (`vipbot-backup-key.txt`, kept by you) can open a backup. Setup is in `docs/SETUP.md` part 5. It needs secrets `BACKUP_DATABASE_URL` and `SUPABASE_CA_CERT`, and variable `BACKUP_AGE_RECIPIENT`.

- **Failures:** GitHub emails you when a scheduled run fails. Check the run's log: errors name the missing secret or the connection problem.
- **Inactive repos:** GitHub turns off scheduled workflows in a repo with no activity for 60 days, and emails before it does. Click **Enable workflow** in the Actions tab if that happens.
- **Postgres version:** the workflow installs `pg_dump` 18. If Supabase ever moves to a newer Postgres, the run fails with a version mismatch. Change `postgresql-client-18` and `PG_BIN` in the workflow to the new version.

### Restoring
`scripts/restore.mjs` only restores into an **empty** database. It refuses if the target already has tables, so it can't overwrite live data. To recover:
1. Download the backup: **Actions** → a successful **Nightly database backup** run → **Artifacts**. Unzip it to get `vipbot-<date>.dump.age`.
2. Create a **new** Supabase project (free allows two), and get its session pooler string and certificate (`docs/SETUP.md` part 3).
3. On a computer with Node 22+, `age` and the PostgreSQL client tools (`psql`, `pg_restore`, version 18 or newer, the same as the workflow's `pg_dump`; on Windows, the EDB PostgreSQL installer with only **Command Line Tools** ticked), from a clone of this repo:
   ```
   RESTORE_DATABASE_URL='<new session pooler string>' RESTORE_CA_CERT=path/to/supabase-ca.crt \
     node scripts/restore.mjs vipbot-<date>.dump.age path/to/vipbot-backup-key.txt
   ```
   (PowerShell: set each variable first with `$env:RESTORE_DATABASE_URL='...'`.)
4. Put the new string in Wispbyte's `.env` and in the `BACKUP_DATABASE_URL` secret, then restart the bot.

Tested locally (Postgres 16 with TLS and a private CA): backup → decrypt → restore into an empty database gave identical rows, and the bot's migrations ran on the copy. Restoring over a database with tables, decrypting with the wrong key, and connecting with a wrong certificate all fail. The full drill on Supabase is still Phase 10.

## Local development
1. Run Postgres locally, copy `.env.example` to `.env` and fill in a **test** bot's token and IDs. For a local database, `DATABASE_URL=postgresql://user:pass@localhost:5432/vipbot` needs no certificate.
2. `npm install`, then `npx prisma migrate dev` to apply migrations.
3. `npm run dev` starts the bot with reload on save.
4. Checks: `npm run typecheck`, `npm run lint`, `npm test`. To also run the `gateway-leader` lock tests against a real database, set `TEST_DATABASE_URL` first (otherwise they're skipped).
5. Schema changes: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <what-changed>` and commit the new migration folder. Migrations must not drop or rename columns that hold data without an approved plan (CLAUDE.md).

Slash commands are registered to `GUILD_ID` every time the bot starts. `npm run register-commands` does the same thing by hand.
