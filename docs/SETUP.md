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
| Backup private key file | Your computer, part 7 | **Yes**: needed to open backups |

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
4. Under **Bot Permissions**, tick:
   - **Manage Roles**, **Manage Channels**, **Manage Messages**, **View Audit Log**
   - **View Channels**, **Send Messages**, **Read Message History**, **Mention Everyone**, **Connect**
   - and everything VIP gives, because Discord only lets the bot give permissions it has itself: **Attach Files**, **Embed Links**, **Use External Emojis**, **Use External Stickers**, **Use Soundboard**, **Use External Sounds**, **Create Public Threads**, **Send Messages in Threads**

   If you already added the bot, add any missing ones to the bot's role in **Server Settings → Roles** instead.
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
   If your password contains `@`, `#`, `?`, `&`, `/` or `:`, generate a new password without them (**Database → Settings → Reset database password**). Those characters break the link.
6. Download the certificate: in the main menu on the far left (the column of icons), click **Database** (cylinder icon), then **Settings** under **Configuration**. Scroll to **SSL Configuration** and click **Download certificate**. It's not under Project Settings. A direct link is `https://supabase.com/dashboard/project/<your-project-code>/database/settings`. You get a file like `prod-ca-2021.crt`. Keep it; you'll upload it in part 4.
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

## Part 5: First-time setup in Discord

Once `/bot health` works, in your test server:
1. **Server Settings → Roles:** drag the bot's role **above** bleed's level roles, so the bot can manage the roles it creates.
2. `/config level-roles-top role:<bleed's highest level role>`. The VIP role will go directly above it.
3. `/config channel purpose:announcements channel:#your-announcements` and `/config channel purpose:mod-log channel:#a-private-staff-channel`.
4. `/config staff-roles add role:<each staff role>`. Members with these can't be VIP.
5. Optional: if you already have a #polls channel or a role for poll pings, use `/config channel purpose:polls` and `/config polls-role`. Otherwise setup creates them.
6. `/setup run`. It creates:
   - the VIP role, 10 VIP colour roles (above VIP), the 👑 Crown role (above the colours), and 3 history badge roles (at the bottom)
   - the private VIP Lounge (text and voice), with a panel where VIPs pick their colour
   - `#polls` with the right permissions, and a **Polls** role. Give it to members who want poll pings (self-roles or another bot). Only the bot can ping it.

   It tells you if anything's wrong. Run it again whenever something looks off; it's safe.
7. `/vip preview` shows what the first reshuffle will do. The reshuffle runs every night at midnight (server time). It also runs once right after setup, for the day that just ended.

## Part 6: AI chat (Puppyboy Carter)

Optional, and free. Without it, the bot answers mentions with pre-written replies.

1. **Groq** (main):
   - Sign up at https://console.groq.com (no card needed).
   - Go to **API Keys → Create API Key** and copy it.
   - In **Settings → Data Controls**, turn on **Zero Data Retention**, so Groq doesn't keep the messages.
   - Check **Settings → Limits** for what the free plan allows. If `llama-3.1-8b-instant` isn't listed, run `/ai provider-model provider:groq model:<a listed model>`, e.g. `openai/gpt-oss-20b`.
2. **Cloudflare Workers AI** (backup):
   - Sign up at https://dash.cloudflare.com (free plan).
   - Your **Account ID** is on the right of the account home page.
   - Create a token under **My Profile → API Tokens → Create Token**, using the **Workers AI** template.
3. Add to the bot's `.env` on Wispbyte, then restart:
   ```
   GROQ_API_KEY=...
   CLOUDFLARE_ACCOUNT_ID=...
   CLOUDFLARE_AI_TOKEN=...
   ```
4. In Discord: `/config channel purpose:main-chat channel:#general` (the bot only chats there), then `/ai status` and `/ai test question:how does VIP work?`.
5. Add this line to your server rules: **"Messages you send to Puppyboy Carter are processed by an AI service."**

Use one account per provider. Making extra accounts to get more free usage breaks their terms.

## Part 7: Nightly backups (GitHub)

Every night, GitHub makes an **encrypted** copy of the database and keeps the last 30 days. It's encrypted with a key that only you have, so nobody else (not GitHub, not anyone with access to the repo) can read it.

### 7a. Make your backup key (on your own computer, once)
1. Install **age**, a small encryption tool:
   - **Windows:** open **PowerShell** and run `winget install FiloSottile.age`, then close and reopen PowerShell.
   - **Mac:** `brew install age` (needs Homebrew).
2. Run:
   ```
   age-keygen -o vipbot-backup-key.txt
   ```
   It prints `Public key: age1...`. Copy that `age1...` line into your note. It's **not** secret.
3. The file `vipbot-backup-key.txt` is your **private key**. Store it somewhere safe and private: a password manager, a USB stick, or a private cloud folder, ideally two of these. **If you lose it, the backups can't be opened by anyone.** Never upload it to GitHub, Wispbyte or a chat.

### 7b. Give GitHub what it needs
1. Go to https://github.com/dudethedud/HardSetMax → **Settings** (top bar of the repo) → **Secrets and variables** → **Actions**.
2. On the **Secrets** tab, click **New repository secret** twice:
   - Name `BACKUP_DATABASE_URL`, value: your `DATABASE_URL` (the same one as in `.env`).
   - Name `SUPABASE_CA_CERT`, value: open the Supabase certificate file in Notepad (or TextEdit) and paste **everything**, including the `-----BEGIN CERTIFICATE-----` and `-----END CERTIFICATE-----` lines.
3. On the **Variables** tab, click **New repository variable**:
   - Name `BACKUP_AGE_RECIPIENT`, value: your `age1...` public key.

### 7c. Check it works
Backups start once the pull request is merged into `main`.
1. In the repo, click **Actions** → **Nightly database backup** → **Run workflow** → **Run workflow**.
2. After a minute or two, it should show a green tick. Click the run: under **Artifacts** there's a `database-backup-…` file.
3. From then on it runs every night by itself. If a run fails, GitHub emails you.

How to restore a backup is in `docs/OPERATIONS.md` §5.

---

## Done?
Then do the restart test in `docs/OPERATIONS.md` §3, and tell me how it went. If anything doesn't match these steps, send a screenshot with the secrets hidden.
