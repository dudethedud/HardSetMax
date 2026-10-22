# Setup guide (step by step)

This gets the bot running for free: **Discord** (the bot account), **Supabase** (the database), **Wispbyte** (runs the bot 24/7) and **GitHub** (nightly backups). Do the parts in order. It takes about 30–45 minutes.

Keep a private note open (e.g. a password manager or a note only you can see) to paste values into as you go. You'll collect:

| Value | From | Secret? |
|---|---|---|
| `DISCORD_TOKEN` | Discord, part 1 | **Yes**: anyone with it controls the bot |
| `DISCORD_CLIENT_ID` | Discord, part 1 | No |
| `GUILD_ID` | Discord, part 2 | No |
| `DATABASE_URL` | Supabase, part 3 | **Yes**: contains the database password |
| Supabase certificate file | Supabase, part 3 | No |
| Backup private key file | Your computer, part 5 | **Yes**: needed to open backups |

Never paste secret values into Discord, GitHub issues or chats (including with Claude).

---

## Part 1: Create the bot (Discord)

1. Go to https://discord.com/developers/applications and log in.
2. Click **New Application** (top right), name it (e.g. `Puppyboy Carter`), tick the box and click **Create**.
3. You're on **General Information**. Copy the **Application ID** → this is `DISCORD_CLIENT_ID`.
4. In the left menu, click **Bot**.
5. Click **Reset Token**, confirm, then **Copy** → this is `DISCORD_TOKEN`. Discord only shows it once. If you lose it, reset it again.
6. Still on the **Bot** page, scroll to **Privileged Gateway Intents** and turn on:
   - **Server Members Intent**
   - **Message Content Intent**

   Then click **Save Changes** at the bottom.

## Part 2: Add the bot to a test server

Use a test server first, not the real one.

1. In Discord, create a server (the **+** at the bottom of the server list → **Create My Own**). Copy a few channels and the bleed level roles from the real server.
2. Back in the Developer Portal, click **OAuth2** in the left menu, then find the **OAuth2 URL Generator**.
3. Under **Scopes**, tick `bot` and `applications.commands`.
4. Under **Bot Permissions**, tick: **Manage Roles**, **Manage Channels**, **Manage Messages**, **Mention Everyone**, **View Audit Log**, **Send Messages**, **Read Message History**.
5. Copy the **Generated URL** at the bottom, open it in your browser, pick your test server and click **Authorize**.
6. Get the server ID:
   - In Discord, open **User Settings** (gear icon) → **Advanced** → turn on **Developer Mode**.
   - Right-click your test server's icon → **Copy Server ID** → this is `GUILD_ID`.
7. In the test server, right-click the bot → **Change Nickname** → `Puppyboy Carter`.

## Part 3: Create the database (Supabase)

1. Go to https://supabase.com and click **Start your project**. Sign up with GitHub or email. No card needed.
2. Click **New project**.
   - **Name:** `vip-bot`
   - **Database Password:** click **Generate a password**, then **copy it into your private note now**. You'll need it in step 5.
   - **Region:** pick the one closest to you (e.g. a US region if you're in Canada or the US).
   - Click **Create new project** and wait a minute or two while it sets up.
3. At the top of the project page, click **Connect**.
4. In the window that opens, find the connection string options and choose **Session pooler** (not "Direct connection", not "Transaction pooler"). Copy the string. It looks like:
   ```
   postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres
   ```
5. In your note, replace `[YOUR-PASSWORD]` (including the brackets) with the password from step 2, and add `?sslmode=require` to the very end. The result is your `DATABASE_URL`:
   ```
   postgresql://postgres.abcdefghijklmnop:MyPassw0rd@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require
   ```
   If your password contains `@`, `#`, `?`, `&`, `/` or `:`, generate a new password without them (**Project Settings → Database → Reset database password**). Those characters break the link.
6. Download the certificate: in the left menu, open **Project Settings** (gear icon) → **Database**. Scroll to **SSL Configuration** and click **Download certificate**. You get a file like `prod-ca-2021.crt`. Keep it; you'll upload it in part 4.
7. On the same page, if there's an **Enforce SSL on incoming connections** switch, turn it on.

## Part 4: Run the bot (Wispbyte)

> Wispbyte's panel may name things slightly differently from below. Look for the closest match. If you get stuck, send me a screenshot (with no secrets visible).

1. Create your free **Node.js** server, if you haven't already (the screen from earlier, **Create server**).
2. Open the server and go to the **Startup** tab.
   - **Docker image / Node version:** pick **Node 22** or higher if there's a choice.
   - **Startup Command** (or **Main file**): `node start.js` (or just `start.js` if the field only asks for a file name).
   - **Git repo address** (if there's one): `https://github.com/dudethedud/HardSetMax`
   - **Branch:** `main`. Until the Phase 1 pull request is merged, use `claude/phase-1-skeleton` to test.
   - **Auto update** (pull on start): **on** / `1`.
   - **Git username + access token:** only if the repo is private. On GitHub, go to your profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**. Pick **Only select repositories** → `HardSetMax`, and under **Repository permissions** set **Contents** to **Read-only**. Generate the token, copy it and paste it here. Treat it like a password.
3. Go to the **Files** / **File Manager** tab.
   - Create a folder `certs`. Open it and upload the Supabase certificate, then rename it to `supabase-ca.crt`.
   - Go back to the main folder and create a new file named exactly `.env` (with the dot). Paste this in, fill in your values from the note, and save:
     ```
     DISCORD_TOKEN=paste-token-here
     DISCORD_CLIENT_ID=paste-application-id-here
     GUILD_ID=paste-server-id-here
     DATABASE_URL=paste-database-url-here
     DATABASE_CA_CERT=certs/supabase-ca.crt
     ```
     No spaces around `=`, no quotes.
   - **If there's no git option in Startup:** on GitHub, open the repo, pick the branch, click **Code** → **Download ZIP**. Upload the zip in the File Manager, **Unarchive** it, and move the files out of the extracted folder into the main folder. You'll redo this for every update, so git is much easier if available.
4. Go to the **Console** tab and click **Start**. The first start takes a few minutes, because it installs and builds everything. You should see, in order:
   ```
   No pending migrations to apply.      (or "applied 1 migration")
   "msg":"starting"
   "msg":"acquired gateway-leader"
   "msg":"registered guild commands"
   "msg":"connected to Discord"
   ```
   If you see an error, check the table in `docs/OPERATIONS.md` ("Common startup errors").
5. In your test server, type `/bot health`. Database, Gateway leader and Intents should all show ✅.
6. **Set a phone reminder to log in to Wispbyte every 2 weeks.** If you don't, the free server stops.

## Part 5: Nightly backups (GitHub)

Every night, GitHub makes an **encrypted** copy of the database and keeps the last 30 days. It's encrypted with a key that only you have, so nobody else (not GitHub, not anyone with access to the repo) can read it.

### 5a. Make your backup key (on your own computer, once)
1. Install **age**, a small encryption tool:
   - **Windows:** open **PowerShell** and run `winget install FiloSottile.age`, then close and reopen PowerShell.
   - **Mac:** `brew install age` (needs Homebrew).
2. Run:
   ```
   age-keygen -o vipbot-backup-key.txt
   ```
   It prints `Public key: age1...`. Copy that `age1...` line into your note. It's **not** secret.
3. The file `vipbot-backup-key.txt` is your **private key**. Store it somewhere safe and private: a password manager, a USB stick, or a private cloud folder, ideally two of these. **If you lose it, the backups can't be opened by anyone.** Never upload it to GitHub, Wispbyte or a chat.

### 5b. Give GitHub what it needs
1. Go to https://github.com/dudethedud/HardSetMax → **Settings** (top bar of the repo) → **Secrets and variables** → **Actions**.
2. On the **Secrets** tab, click **New repository secret** twice:
   - Name `BACKUP_DATABASE_URL`, value: your `DATABASE_URL` (the same one as in `.env`).
   - Name `SUPABASE_CA_CERT`, value: open the Supabase certificate file in Notepad (or TextEdit) and paste **everything**, including the `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` lines.
3. On the **Variables** tab, click **New repository variable**:
   - Name `BACKUP_AGE_RECIPIENT`, value: your `age1...` public key.

### 5c. Check it works
Backups start once the pull request is merged into `main`.
1. In the repo, click **Actions** → **Nightly database backup** → **Run workflow** → **Run workflow**.
2. After a minute or two, it should show a green tick. Click the run: under **Artifacts** there's a `database-backup-…` file.
3. From then on it runs every night by itself. If a run fails, GitHub emails you.

How to restore a backup is in `docs/OPERATIONS.md` §5.

---

## Done?
Then do the restart test in `docs/OPERATIONS.md` §3, and tell me how it went. If anything doesn't match these steps, send a screenshot with the secrets hidden.
