# Operations

The bot runs on a free **Wispbyte** Node.js server. Its data (menus, banners, a few role IDs) lives in a free **Supabase** Postgres database. Nothing important is stored on the Wispbyte server itself.

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
2. Point it at the GitHub repo `https://github.com/dudethedud/HardSetMax` with branch **`deploy`** (not `main`), and turn on **auto update** (pull on start). If the repo is private, create a GitHub fine-grained token with read-only **Contents** access to this repo only, and enter it with your GitHub username.
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
5. Start the server. On each start it pulls `deploy` and runs `start.js`, which applies new database migrations and starts the bot. There's **no `npm install` and no build** on the server.
6. **Log in to Wispbyte at least every 2 weeks**, or the free server stops. After 30 days stopped it's moved to storage, and nothing is deleted. Set a phone reminder.

**Why the `deploy` branch:** the free server stops anything that keeps its CPU busy, and `npm install` plus the TypeScript build did (it was blocked for "using too much CPU"). So GitHub builds the bot instead: on every merge to `main`, `.github/workflows/deploy.yml` runs the checks and tests, bundles the whole bot into one file (`bot.mjs`, about 9 MB) and replaces the `deploy` branch with it, the migration files and a small `start.js`. The `deploy` branch has no `package.json`, so the panel skips `npm install`. Migrations are applied by the bot itself (`src/db/migrate.ts`), the same way `prisma migrate deploy` does, so the Prisma CLI isn't needed on the server.

**Updating the bot:** merge to `main`, wait for the **Build deploy branch** run in the repo's **Actions** tab to go green (about 2 minutes), then click **Restart** in the panel. If the run fails, nothing is published and the server keeps the last good build.

**Switching an existing server from `main` to `deploy`:** in the File Manager, delete **everything except `.env` and `certs/`** (`package.json`, `node_modules`, `dist`, `src`, `.git` and the rest, plus any `core` crash file). Then set the branch to `deploy` in the Startup tab and start. If `package.json` is still there, the panel tries to `npm install` again.

### Memory
The free server has 512 MB. There's no build on the server any more; the bot itself uses well under that.

### What the startup log should show
```
{"msg":"database is up to date"}        (or "applied migration" for each new one)
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
| `Discord refused the intents` | Turn on **Server Members Intent** in the Developer Portal (Bot page). |
| `bot is not in GUILD_ID` | Invite the bot to the server, or fix `GUILD_ID`. |
| Server keeps restarting with no clear error | It may be out of memory. Check the panel's memory graph. |
| Console shows `npm install` (the `\|/-` spinner), or "stopped for using too much CPU" | The server is still on `main`. Switch it to the `deploy` branch (above). |
| `Migration … failed earlier and must be resolved` | A migration broke halfway. Don't restart in a loop: send the log to whoever maintains the bot. The failed row is in the `_prisma_migrations` table; `prisma migrate resolve` fixes it from a computer with the repo. |

## 3. Supabase limits to watch
- **500 MB** of database storage on the free plan. The bot only stores the menus, their banners and a few role IDs, so it uses very little.
- Free projects **pause after a week with no activity**. A running bot keeps it active. If the bot was stopped for a week, restore the project in Supabase before restarting the bot.
- The session pooler allows a limited number of connections. The bot uses up to `DATABASE_POOL_MAX` (default 5), plus one for `gateway-leader` and one during migrations.

## 4. Backups
`.github/workflows/backup.yml` runs every night at 09:17 UTC (early morning in Edmonton), and can also be run by hand from the **Actions** tab. It:
1. dumps the bot's tables (schema `public` only) with `pg_dump` over verified TLS,
2. checks the dump can be read,
3. encrypts it with `age` for your public key, and keeps it as a workflow artifact for **30 days**.

GitHub never sees your data unencrypted. Only the private key (`vipbot-backup-key.txt`, kept by you) can open a backup. It needs secrets `BACKUP_DATABASE_URL` and `SUPABASE_CA_CERT`, and variable `BACKUP_AGE_RECIPIENT`.

- **Failures:** GitHub emails you when a scheduled run fails. Check the run's log: errors name the missing secret or the connection problem.
- **Inactive repos:** GitHub turns off scheduled workflows in a repo with no activity for 60 days, and emails before it does. Click **Enable workflow** in the Actions tab if that happens.
- **Postgres version:** the workflow installs `pg_dump` 18. If Supabase ever moves to a newer Postgres, the run fails with a version mismatch. Change `postgresql-client-18` and `PG_BIN` in the workflow to the new version.

### Restoring
`scripts/restore.mjs` only restores into an **empty** database. It refuses if the target already has tables, so it can't overwrite live data. To recover:
1. Download the backup: **Actions** → a successful **Nightly database backup** run → **Artifacts**. Unzip it to get `vipbot-<date>.dump.age`.
2. Create a **new** Supabase project (free allows two), and get its session pooler string and certificate (part 1 above).
3. On a computer with Node 22+, `age` and the PostgreSQL client tools (`psql`, `pg_restore`, version 18 or newer, the same as the workflow's `pg_dump`; on Windows, the EDB PostgreSQL installer with only **Command Line Tools** ticked), from a clone of this repo:
   ```
   RESTORE_DATABASE_URL='<new session pooler string>' RESTORE_CA_CERT=path/to/supabase-ca.crt \
     node scripts/restore.mjs vipbot-<date>.dump.age path/to/vipbot-backup-key.txt
   ```
   (PowerShell: set each variable first with `$env:RESTORE_DATABASE_URL='...'`.)
4. Put the new string in Wispbyte's `.env` and in the `BACKUP_DATABASE_URL` secret, then restart the bot.

Tested locally (Postgres 16 with TLS and a private CA): backup → decrypt → restore into an empty database gave identical rows, and the bot's migrations ran on the copy. Restoring over a database with tables, decrypting with the wrong key, and connecting with a wrong certificate all fail.

## 5. Setting up the menus
1. **Developer Portal → Bot:** turn on **Server Members Intent**. Invite the bot with **Manage Roles**, and drag its role **above every colour role** in Server Settings → Roles.
2. `/colours unlock-role add role:@…` for each role your other bots give reppers (server tag, `.gg/femboii` in status). Any one of them unlocks colours.
3. `/colours menu create title:Pinks/Magentas emoji:🫐 banner:<image>` for each group.
4. `/colours menu add-role menu:Pinks/Magentas role:@Rose ⸝⸝` for each colour. Use your existing roles: the bot never creates or edits roles. Roles with moderator/admin permissions, roles above the bot and bot-managed roles are refused.
5. `/colours post channel:#colour-yourself` posts every menu, in order. Run it again any time: it updates them in place. `fresh:true` deletes and reposts them all (use it after changing a menu's `position`).
6. Optional: `/colours log-channel channel:#staff-logs` logs each colour the bot takes off.
7. Delete your old menu messages.

## 6. How it behaves
- **Picking:** reppers pick from any dropdown. It removes every other colour from **all** menus and gives the new one (one Discord request, so it can't half-apply). "Remove colour" takes it off. Non-reppers get a private "rep the server to unlock colours" note and nothing changes.
- **Losing repper:** when a member loses their **last** unlock role, the bot takes their menu colours off straight away. It also checks everyone at startup and every hour, in case Discord missed an event (e.g. the bot was offline).
- Removing an unlock role with `/colours unlock-role remove` takes colours off anyone left without one. With **no** unlock roles set, nobody is stripped (that's a setup gap, not people who stopped repping).
- Taking a role out of a menu, or deleting a menu, doesn't take it off people already wearing it. They keep it until they pick another colour.
- Editing a menu or its roles updates the posted message in place.

## 7. When something goes wrong
| Problem | Fix |
|---|---|
| "The application did not respond" | The bot isn't running or is still starting. Check the Wispbyte console. If it says it's waiting for `gateway-leader`, an old copy is still running: stop the server fully, wait a minute, start it again. |
| "Couldn't change your colour" | The bot's role is below a colour role, or lacks Manage Roles. |
| A menu message was deleted | `/colours post` posts it again. |
| Colours not removed when someone stops repping | Check `/colours unlock-role list` has the right roles, and the Server Members Intent is on. The hourly sweep catches anything missed. |

## Local development
1. Run Postgres locally, copy `.env.example` to `.env` and fill in a **test** bot's token and IDs. For a local database, `DATABASE_URL=postgresql://user:pass@localhost:5432/colours` needs no certificate.
2. `npm install --include=dev` (the repo's `.npmrc` leaves dev tools out, for the server), then `npx prisma migrate dev` to apply migrations.
3. `npm run dev` starts the bot with reload on save.
4. Checks: `npm run typecheck`, `npm run lint`, `npm test`. To also run the database tests, point `TEST_DATABASE_URL` at a **separate, migrated test database**. They empty its tables, so never point it at real data.
5. Schema changes: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <what-changed>` and commit the migration folder. Migrations must not drop data without an approved plan (CLAUDE.md).

Slash commands are registered to `GUILD_ID` every time the bot starts. `npm run register-commands` does the same by hand.

`npm run bundle` builds the same `deploy/` folder the Action publishes, if you want to try it locally: `cd deploy && node start.js` (with the variables set).
