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
3. Run `/settings set key:day-boundary value:04:30`, then `/settings view`. It should show `day-boundary = 04:30`.
4. Click **Restart** in Wispbyte. When it's back, `/settings view` must still show `04:30`.
5. **Second-copy check:** on your own computer, clone the repo, create the same `.env`, and run `npm install` then `npm start`. With the hosted bot still running, the local copy must log
   ```
   another copy of the bot holds gateway-leader; waiting for it to exit
   ```
   and must not log `connected to Discord`. Stop the local copy with Ctrl+C. It should exit at once.
6. Put the setting back: `/settings set key:day-boundary value:00:00`.

Every `/settings set` is also saved in the `AuditLog` table (`action = 'config.set'`, with old and new values). You can see it in Supabase's **Table Editor**.

## 4. Supabase limits to watch
- **500 MB** of database storage on the free plan. The bot stores counts and timestamps only, and prunes activity older than 60 days (Phase 10).
- Free projects **pause after a week with no activity**. A running bot keeps it active. If the bot was stopped for a week, restore the project in Supabase before restarting the bot.
- The session pooler allows a limited number of connections. The bot uses up to `DATABASE_POOL_MAX` (default 5), plus one for `gateway-leader` and one during migrations.

## 5. Backups
`.github/workflows/backup.yml` runs every night at 09:17 UTC (early morning in Edmonton), and can also be run by hand from the **Actions** tab. It:
1. dumps the bot's tables (schema `public` only) with `pg_dump` over verified TLS,
2. checks the dump can be read,
3. encrypts it with `age` for your public key, and keeps it as a workflow artifact for **30 days**.

GitHub never sees your data unencrypted. Only the private key (`vipbot-backup-key.txt`, kept by you) can open a backup. Setup is in `docs/SETUP.md` part 7. It needs secrets `BACKUP_DATABASE_URL` and `SUPABASE_CA_CERT`, and variable `BACKUP_AGE_RECIPIENT`.

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

## Commands
Five commands: `/stats`, `/vip`, `/settings`, `/bot` and `/announce`. They reply privately. Each subcommand is for **staff** (a staff role, Administrator or the owner), **admin** (Administrator or the owner) or the **owner** only; the README has the full list with who can use what. Staff need **Timeout Members** for Discord to show them the commands; the bot checks the level itself every time, whatever Discord shows.

| Command | What it does |
|---|---|
| `/bot health` | Version, uptime, database, lock, intents, current server-day, writes waiting to be saved |
| `/settings view` | All settings and channel weights |
| `/settings set key value` | Change a setting: timezone, day boundary, window, cooldown, voice weight and cap, spam filter limits |
| `/settings channel-weight channel weight` | 0 ignores a channel, 0.5 counts half, 1 is normal (max 5). Threads use their parent's weight |
| `/stats user` | Score, rank, active days, points to reach #10, today so far, 7-day breakdown |
| `/stats [count]` | Top members this window |
| `/vip adjust user amount reason` | Add or remove points (saved with the reason, counts from tomorrow's window) |
| `/bot setup` | Create or repair the VIP role, VIP Lounge and panels; checks role order and bot permissions. Safe to rerun |
| `/settings channel purpose channel` | Announcements and mod-log channels |
| `/settings role action:add-staff/remove-staff/list-staff` | Members with a staff role can't be VIP |
| `/settings role action:level-top role` | bleed's highest level role; VIP goes directly above it on `/bot setup` |
| `/vip list` | VIPs with rank, score, days held, 📌 if pinned |
| `/vip preview` | What a reshuffle would do now, plus ranks 11–15 |
| `/vip pin user` / `/vip unpin user` | Lock someone into VIP (gives VIP now if needed) / let the reshuffle decide again |
| `/vip remove user [block_days]` | Remove VIP now; optionally block from VIP for N days |
| `/vip unblock user` | Clear a block |
| `/vip reshuffle` | Run a reshuffle now, after a confirm button. The nightly one still runs |
| `/settings colour action:list/add/edit/remove` | VIP colour options (up to 24); changes update the roles and the lounge picker |
| `/settings badge action:list/set/remove` | History badge milestones (defaults: 4 weeks VIP Regular, 12 VIP Veteran, 26 VIP Legend) |
| `/vip crown` | This week's Crown holder and their custom role |
| `/vip crown-reset user` | Delete someone's custom role and its saved settings |
| `/vip crown-lock user locked:true` / `/vip crown-lock user locked:false` | Block or allow creating and editing a custom role |
| `/settings blocked-word action:add/remove/list` | Words custom role names can't contain (lookalikes like 0 for o are caught) |
| `/vip polls` | VIP polls used today, who posted, who's locked, when it resets |
| `/vip poll-unlock user` | Give a VIP one more poll today, even past the daily limit (logged) |
| `/settings channel purpose:polls` / `/settings role action:polls` / `/settings set polls-daily-cap` | Use an existing polls channel or ping role; server-wide daily VIP poll limit (default 2) |

### AI chat (Puppyboy Carter)
- The bot replies only in the **main chat** channel (`/settings channel purpose:main-chat`), when @mentioned or when someone replies to one of its messages. It reads up to 6 messages of the reply chain from Discord at that moment and saves nothing. It ignores bots and spam-flagged messages.
- Each person gets up to `ai-per-user-limit` replies a minute (default 3); after that it reacts with 👀.
- **What the AI is given:** `prompts/personality.md` and `prompts/vip-guide.md` (edit, then restart), the asker's **own** stats only, and the current VIPs and Crown holder. It has no tools: it can't change anything, whatever it says.
- **Safety:** replies can only ping the asker. `@everyone`, `@here` and role mentions are stripped, and anything with a blocked word is replaced with a fixed line. Replies are at most 400 characters.
- **Provider chain:** `/bot ai action:providers` shows it. Default: Groq (`openai/gpt-oss-20b`, 1,000/day) → Cloudflare Workers AI (`@cf/zai-org/glm-4.7-flash`, 800/day) → pre-written replies.
  - Each provider's cap resets at its own time (default 00:00 UTC).
  - On an error, a 10 s timeout or a 429, the bot uses the next provider and cools the failing one down for 5 min, or until its reset if the daily limit is used up.
- **Adding a provider:** insert an `AiProvider` row (OpenAI-compatible base URL, model, the env var name holding its key, cap, order) and add the key to `.env`. No code change.
- **Posts:** the daily VIP update and the weekly recap get one AI hype line on top. It's dropped if it contains numbers, since numbers always come from code, and the post goes without it if the AI is unavailable. New VIPs get a welcome in the lounge, with a fixed message if the AI is unavailable.
- Commands: `/bot ai action:status`, `/bot ai action:off` (pre-written replies still work when off), `/bot ai action:test`, `/bot ai action:providers`, `/bot ai-provider setting:cap`, `/bot ai-provider setting:toggle`, `/bot ai-provider setting:model`.

### Temporary VIP voice channels
- In the VIP Lounge panel, **🔊 Create VIP voice** makes a voice channel in the VIP Lounge category named "*Name*'s room". Only VIPs can see it. Each VIP can have one at a time.
- The owner gets **Rename** and **Set user limit** buttons in the channel's chat. Names are 1–32 characters, checked against the custom role blocked words. Discord allows 2 renames per 10 minutes. The limit is 0 (none) to 99. Nobody else can use the buttons, and the owner doesn't get Manage Channel.
- It's deleted after 60 seconds empty (bots don't count), including if nobody joins within a minute of creating it. If the owner loses VIP, it's deleted as soon as it's empty.
- On startup, empty saved channels are deleted, and ones deleted by hand are forgotten.

### Badges and the weekly recap
- **Badges:** total weeks held = all unpinned VIP time ÷ 7 days, rounded down. Each reshuffle checks it and gives any new badge role. Badge roles have no colour, aren't hoisted, and sit just above @everyone. They're permanent, even after VIP is lost.
- New badges appear in that day's VIP update post, which goes out even if no VIP changed. Badge earners are shown but not pinged.
- **Weekly recap:** posted in the announcements channel right after the week's first reshuffle and the Crown, once per week, with no pings. It covers last Monday to Sunday:
  - the Crown holder
  - the top 3 with scores
  - the longest-standing current VIP (days in a row, including pinned time)
  - VIP swaps (everyone who gained VIP in that week's reshuffles, including `/vip reshuffle`)
  - badges earned

### How the Crown works
- The week's first reshuffle (normally Monday's, at midnight) gives the **👑 Crown** role to the top member of the new VIP list, for that week (Monday to Sunday). No VIPs means no Crown that week.
- If the holder loses VIP mid-week, the Crown and their custom role go with it, and nobody else gets the Crown until next week.
- **Custom role:** the Crown holder clicks **Create your role** in the VIP Lounge panel and fills in a name (2–32 characters), a hex colour and an optional emoji. The emoji needs Server Boost Level 2; otherwise it's left off.
  - **Rejected:** names that match or imitate any role, or contain a staff role's name; blocked words; near-black colours.
  - If something's wrong, a **Try again** button reopens the form with their answers, for 15 minutes.
  - Creating is free, then 3 edits per Crown week.
  - The role sits right above the Crown role. It's deleted when the Crown is lost, but its settings are kept, so it comes back automatically if they win again.

### VIP and Crown perks
- **#vip-board** is edited in place a few seconds after any VIP or Crown change, and every hour. If someone deletes it, the bot posts it again on startup or `/bot setup`.
- **🪪 My profile** and **📣 Shoutout** are buttons in the VIP Lounge. Shoutouts: one per VIP per server-day, 200 characters, posted in main chat (or announcements) with mentions removed and no pings. The text isn't saved; the mod-log links to the message.
- **The Crown's titles** (🎖️ button): pick a member per title. Not for staff, bots or themselves; one title each. All titles are cleared at the weekly handover and when the Crown is lost. They're roles with no permissions; rename them in Server Settings if you like (the bot only keeps them permission-free).
- **Decree** (📜 button): one per Crown week, 500 characters, posted in announcements with no pings. `/vip crown` shows whether it's been used.
- **👑 nickname:** set when the Crown is awarded and restored when it ends, unless they changed it themselves in between. The bot can't rename the server owner or anyone with a role above the bot's.
- **👑 Hall:** the Crown's temporary voice channel gets Priority Speaker and Move Members for them, in that channel only.

### /announce (owner only)
`/announce [channel]` opens a form. After you submit it you get a private preview with **Send** and **Cancel**. Send posts it from the bot with an `@everyone` ping (other mentions in the text don't ping). The draft is deleted once it's sent, or after 15 minutes. Only the server owner can use it; admins and staff get "Only the server owner can use this."

### How VIP polls work
- In #polls only VIPs, staff and admins can post. Everyone can vote and chat in each poll's thread.
- Polls are handled one at a time, in the order Discord received them. A VIP's first poll of the day:
  - locks #polls for them until the next server-day starts
  - gets the bot's ping of the Polls role
  - gets a discussion thread
- The poll that reaches `polls-daily-cap` also locks #polls for the whole VIP role.
- Anything over a limit (a second poll from the same VIP, or past the cap) is deleted and logged, with no ping. Normal messages from VIPs in #polls are deleted too; discussion goes in the threads.
- Staff and admin polls have no limits and still get the ping and thread.
- Deleting your own poll doesn't give your poll back.
- At the day boundary, the `poll-unlock` job removes only locks that have expired. Startup and `/bot setup` make the #polls permissions match the saved locks.
- Polls posted while the bot is offline aren't checked.

### How the daily reshuffle runs
- Every 15 s the bot checks whether the server-day that just ended has a reshuffle in `JobRun` (job `reshuffle`, period = that day). If not, it runs it. This also covers catch-up: if the bot was offline at midnight, it runs as soon as it's back, once, for the most recent day only.
- The reshuffle saves all VIP changes and marks itself done in **one transaction**, so it can't half-apply or run twice. Roles are applied after that, one at a time. Then the mod-log entries and the VIP update post go out. If the bot dies in between, startup fixes roles to match the database and posts any VIP update that didn't go out.
- It's skipped (and retried) until `/bot setup` has created the VIP role.

### Testing midnight without waiting (test server only)
Set `CLOCK_OFFSET_MINUTES` in `.env` to shift the bot's clock for the schedule. For example, if it's 14:00 now, `CLOCK_OFFSET_MINUTES=605` makes the bot think it's 00:05 tomorrow, so the reshuffle runs right after start. Restart mid-day with the same offset and check in `/bot health` and the mod-log that it neither repeats nor gets skipped. **Remove the setting afterwards.** Message and voice counts always use the real time.

## 6. When something goes wrong (SPEC §13)
- **Database unreachable:** the bot goes into **database-down mode**:
  - it keeps counting activity in memory (unsaved writes show in `/bot health`)
  - it pauses the reshuffle and other scheduled jobs, and posts a mod-log notice
  - it reconnects with growing waits (2 s up to 1 min)

  When the database is back, it takes its lock back, saves everything and runs any missed job (catch-up). If another copy of the bot got the lock first, this copy stops. Activity is only lost if the bot itself crashes during the outage.
- **Missing permissions or role order:** the bot doesn't crash. An hourly check posts what to fix in the mod-log, once per new problem and again when it's fixed. Failed role changes also post the reason and the fix.
- **Discord rate limits:** role changes go one at a time through a queue.
- **Buttons, forms and commands** answer within Discord's 3 seconds ("working on it…") and then finish.
- **Unexpected errors** are logged with context. The bot shuts down cleanly and Wispbyte restarts it.
- **Old data:** a daily `prune` job deletes activity, adjustments, poll records, voice sessions, timeout records and AI usage older than 60 days. The audit log, VIP stints, badges and Crown history are kept.

## 7. Backup restore drill (do this once)
Prove a backup can really be restored, without touching live data:
1. In Supabase, create a **second** free project (e.g. `vip-bot-restore-test`). Get its session pooler string and certificate (SETUP part 3).
2. In GitHub **Actions**, download the newest **Nightly database backup** artifact and unzip it.
3. On your computer:
   - Install Node 22+, `age` and the PostgreSQL 18 client tools (OPERATIONS §5 "Restoring").
   - Clone the repo and run `npm install`.
   - Run `scripts/restore.mjs` with the new project's string, its certificate, the backup file and your `vipbot-backup-key.txt`.
4. In the new project's **Table Editor**, check that `ActivityDay`, `VipMember` and `GuildConfig` have rows, and that the numbers look like the live ones.
5. Write down the date you did it here: _not done yet_. Then delete the test project, or keep it for the next drill.

## 8. Going live on the real server
1. Do SETUP parts 1–5 for the real server: invite the bot with all the permissions, and in `.env` set `GUILD_ID` to the real server and remove `CLOCK_OFFSET_MINUTES`.
   - **Tip:** use a fresh Supabase project for the real server, so test-server data doesn't mix in.
2. Drag the bot's role above bleed's level roles. Then:
   - `/settings role action:level-top`
   - `/settings channel` for announcements, mod-log and main-chat
   - `/settings role action:add-staff` for each staff role
   - `/settings channel-weight` (e.g. memes 0.5, bot-spam 0)
3. `/bot setup`, then read the report. Then `/bot health`: everything should be ✅.
4. Check the role order in **Server Settings → Roles**, top to bottom: bot role, custom crown role, 👑 Crown, the colour roles, VIP, bleed's level roles, badge roles, @everyone.
5. Let it collect activity. The first reshuffle runs at the next midnight. `/vip preview` shows what it will do.
6. After that first midnight, check the VIP update post, the mod-log entries and `/vip list`.

## Local development
1. Run Postgres locally, copy `.env.example` to `.env` and fill in a **test** bot's token and IDs. For a local database, `DATABASE_URL=postgresql://user:pass@localhost:5432/vipbot` needs no certificate.
2. `npm install`, then `npx prisma migrate dev` to apply migrations.
3. `npm run dev` starts the bot with reload on save.
4. Checks: `npm run typecheck`, `npm run lint`, `npm test`. To also run the database tests, point `TEST_DATABASE_URL` at a **separate, migrated test database** (`DATABASE_URL=<test db> npx prisma migrate deploy` first). Otherwise they're skipped. They empty the activity tables in that database, so never point it at real data.
5. Schema changes: edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <what-changed>` and commit the new migration folder. Migrations must not drop or rename columns that hold data without an approved plan (CLAUDE.md).

Slash commands are registered to `GUILD_ID` every time the bot starts. `npm run register-commands` does the same thing by hand.
