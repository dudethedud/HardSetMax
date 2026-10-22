# VIP Bot — Specification

A Discord bot that tracks member activity and runs a **rotating VIP system**: 10 VIP slots held by the most active members of the past 7 days, a weekly **Crown** for #1, VIP colours, permanent history badges, temporary VIP voice channels, and a weekly recap.

Level roles are handled by **bleed** (another bot). This bot does not do levels or XP and does not read bleed's data.

---

## 1. Hard rules

1. **No public slash commands.** Every slash command is admin-only. Members interact only through **buttons, dropdowns and pop-up forms (modals)** posted by the bot in the VIP lounge.
2. **Admin-only enforced twice:** commands are registered with `default_member_permissions = Administrator` and `dm_permission = false`, **and** every handler re-checks Administrator at runtime before doing anything.
3. **No message content is stored.** The bot stores counts and timestamps only.
4. **All state lives in Postgres.** The bot process is stateless; nothing important is written to local disk. Redeploying, restarting or crashing must never lose data (see §11).
5. **The database is the source of truth** for who is VIP, Crown, pinned, blocked, etc. Discord roles are made to match the database, never the other way round.
6. **Every role change is logged** to the mod-log channel with a reason.

---

## 2. Activity tracking

### What counts
| Source | Counts when | Doesn't count when |
|---|---|---|
| **Message** | At most **1 per user per 60 s** (configurable), and it passes the spam filter below | Under 4 characters after trimming, emoji/sticker-only, flagged as spam, in an ignored channel, from a bot, in DMs |
| **Voice minute** | User is in a voice channel with at least 1 other non-bot member | Alone, in the AFK channel, self-deafened, server-deafened, or over the daily voice cap |

### Spam filter (messages)
A message that would otherwise count is **not counted** if any of these are true:
- **Repeat:** it's the same as, or nearly the same as, one of that user's last 5 messages (e.g. compare after lowercasing and stripping spaces/punctuation).
- **Low effort:** fewer than 3 distinct letters/digits ("aaaa", "!!!!!!", "hahahaha" passes, "hhhhhh" doesn't), or it's only mentions, links or emoji.
- **Burst:** the user sent 8+ messages in 30 s. Nothing from them counts for the next 10 minutes.

Thresholds are configurable. The filter is pure logic with unit tests. **Message text is only looked at in memory**: for the repeat check, the bot keeps short fingerprints of each user's last 5 messages in memory for 10 minutes, then drops them. Nothing about message text is ever written to the database. Flagged messages are just not counted; they are not deleted and nobody is warned. `/stats` shows how many messages were filtered.

### Voice cap
At most **240 counted voice minutes per user per day** (configurable). Stops people sitting in voice overnight to farm score.

### Channel weighting
- Each text channel has a weight, default `1.0`. Example: main chat `1.0`, memes `0.5`, bot-spam `0` (ignored).
- **Threads and forum posts always use their parent channel's weight** (a thread under an ignored channel is ignored too).
- Voice minutes have a global weight, default `0.2` (5 voice minutes ≈ 1 message).

### Score
```
score(user) = Σ over the last 7 days of (weighted messages + voice_minutes × voice_weight)
```
- Window length (default **7 days**) is configurable. The window is the **last 7 complete server-days** (see "Server-day" below), so at the reshuffle it never includes a few minutes of the new day.
- Stored as **daily buckets per user**, one per server-day. Days are counted as "active" if the user had any counted activity.
- Buckets older than 60 days are pruned.

### Server-day (one definition used everywhere)
- The bot has **one day boundary**: a time of day in the server's timezone (default **00:00**, timezone default `America/Edmonton`).
- A **server-day** runs from one boundary to the next. Activity buckets, the poll limits, poll locks, the daily reshuffle and the weekly Crown all use this same definition. Nothing in the code uses UTC dates or a separate "midnight".
- Daily jobs run **at** the boundary. Each job's `job_runs` key is the server-day it closes.
- **Daylight saving time:** the boundary is scheduled in the server's timezone (not as a fixed UTC time), so it stays at the same local time all year. Server-days on the two DST change dates are 23 or 25 hours long, and that's fine. If the boundary is set to a local time that doesn't exist on the spring-forward day (e.g. 02:30), it runs at the next valid time. Tests cover both DST dates.

### Timeout tracking
Discord only shows timeouts that are active right now, so the bot keeps its own record:
- Every timeout the bot sees (member update) is saved in a `TimeoutEvent` table with start and end.
- **On startup**, the bot reads the server audit log back to the last timeout it saved and records any it missed while it was offline (needs the **View Audit Log** permission).
- Eligibility ("timed out within the last N days") is always checked against `TimeoutEvent`.

### Saved names
The bot saves each member's **last known display name** whenever it sees them, so announcements and logs still show a name for people who left the server.

### Required Discord intents
`Guilds`, `GuildMembers` (privileged), `GuildMessages`, `MessageContent` (privileged — needed for the spam filter and to see polls), `GuildVoiceStates`, `GuildModeration` (for audit log/timeout events). Turn both privileged intents on in the Developer Portal.

---

## 3. The VIP role

### What VIP gives
- **Shown separately** in the member list (hoisted).
- **Image perms:** Attach Files + Embed Links.
- **External emojis & stickers, soundboard, create threads** (only the ones @everyone and level roles don't already have).
- **VIP lounge:** a private category with a text channel and a voice channel only current VIPs can see.
- **VIP colours** (§5), **VIP polls** (§5a), **temp voice channels** (§8).
- VIP role itself has a distinctive colour not used by any bleed level role.

### Eligibility
Not eligible: bots, members with any configured staff role, members currently timed out or timed out within the last N days (default 3), members on the VIP block list, members who left the server.

### Losing VIP is always immediate and complete
There is **one removal routine** used everywhere: the daily reshuffle, `/vip remove`, and mid-day events (a VIP gets timed out, leaves, gets a staff role, or is blocked; the bot listens for these and removes VIP right away instead of waiting for the reshuffle). It does all of this at once:
- Removes the VIP role and their VIP colour role (colour choice stays saved).
- Removes the Crown and deletes their custom crown role (settings stay saved), if they hold it. The Crown is not reassigned until Monday.
- Poll access ends with the VIP role. Any personal poll lock is cleaned up at the next reset.
- Their temp voice channel is deleted once empty.
- Ends their `VipStint`, logs to the mod-log with the reason.

The freed slot is filled at the **next daily reshuffle**, not instantly.

---

## 4. Daily reshuffle

Runs **once a day at the day boundary** (default 00:00 server time, see §2 "Server-day"). Never live.

### Algorithm (pure function, fully unit-tested)
Inputs: eligible members with scores and last-active dates, current VIPs (with `vipSince`), pinned users, blocked users, config.

1. **Rank** all eligible members by score. Ties are broken in this order, so the result is always the same for the same data:
   1. current VIPs before non-VIPs (keeps things stable),
   2. more active days in the window,
   3. higher score on the most recent day,
   4. smaller Discord user ID (never changes, so `/vip preview` and the real reshuffle always agree).
2. **Forced removals** — a current VIP is removed regardless of rank if any:
   - became ineligible (left, staff, timed out, blocked), or
   - no counted activity for `inactivityDays` (default **3**).
3. **Rank removals** — a current, non-pinned VIP is removed if **both**:
   - rank is worse than `slots + buffer` (default 10 + 3 = below **#13**), and
   - has held VIP at least `minHoldDays` (default **5**).
4. **Pinned** users always hold a slot and are never removed by steps 2–3 (except leaving the server).
5. **Fill** every open slot with the highest-ranked non-VIP eligible members whose score ≥ `minScore` (default 20, prevents giving VIP for one message in a dead week).
6. Output: `added[]`, `removed[]` (each with a reason), final VIP list.

### Announcement (public channel)
- One message per reshuffle, **only if something changed**.
- Pair by rank: highest new VIP with lowest-ranked removed VIP, and so on.
  ```
  ⭐ VIP update
  @newvip1 → replaced oldvip1
  @newvip2 → replaced oldvip2
  @newvip3 → filled an open slot
  ```
- **Ping only new VIPs.** Old VIPs appear by display name with no ping (use `allowed_mentions`).
- Removals with no matching addition (e.g. not enough eligible members) are listed as `oldvip left VIP` without a ping.

### Mod-log
Every addition/removal with its reason: `ranked #3 (score 212)`, `dropped to #15`, `inactive 3 days`, `timed out`, `removed by @admin`, etc.

---

## 5. VIP colours

- On setup the bot **creates 10 colour roles** (names and hex values configurable), positioned **above all bleed level roles** so the colour shows.
- A **colour picker panel** (dropdown) lives in the VIP lounge. Picking a colour replaces the previous one; there's a "Remove colour" option.
- Non-VIPs who use the dropdown get a private "VIP only" reply.
- **Losing VIP removes the colour role** immediately (see §3, "Losing VIP").
- The user's **last pick is saved**; regaining VIP restores it automatically.
- Admins manage options with `/vip colours add|edit|remove`.

---

## 5a. VIP polls

A **#polls** channel where only VIPs and staff can post Discord's built-in polls. There's a **server-wide cap of 2 VIP polls per day** (first come, first served), **each VIP can post at most 1 of those**, and the bot pings the **Polls** role for them. Everyone can discuss each poll in its own thread.

### Channel permissions (set by `/setup run`)
| Who | Can |
|---|---|
| @everyone | View channel, read history, vote in polls, **Send Messages in Threads**. Can't post in the channel itself or create threads. |
| VIP role | Send Messages + Send Polls |
| Staff roles (from config) | Send Messages + Send Polls |
| Bot | Send Messages, Manage Messages, Manage Permissions, Create Public Threads, Mention @everyone/roles |

### Posting
1. A VIP or staff member posts a Discord poll in #polls.
2. The bot **immediately locks the channel for that VIP only**: a member-specific permission overwrite denying Send Messages and Send Polls. The lock is saved in the DB (`PollLock`) and **expires at the end of the server-day the poll was posted in**.
3. If that poll **reaches the daily cap**, the bot also **locks the channel for the whole VIP role** (a role overwrite denying Send Messages and Send Polls), expiring the same way. Saved in the DB as a role-level lock.
4. The bot **replies to the poll** with `<@&PollsRole> 📊 New poll from @vipname`, using `allowed_mentions` so only the Polls role and the author are pinged.
5. The bot **creates a discussion thread** on the poll (named after the poll question, auto-archive 24 h), where everyone can chat.
6. **VIPs never ping the Polls role themselves.** The Polls role is not mentionable, and VIPs don't have Mention Everyone, so typing `@Polls` does nothing.

Steps 2–3 (locks) apply to VIPs only. **Staff polls** skip the limits and locks, don't count toward the cap, and still get the bot's ping and discussion thread.

### Rules
- **Server cap: 2 polls per server-day** across all VIPs (config `polls-daily-cap`, default 2). A poll belongs to the server-day of its Discord timestamp (§2 "Server-day").
- **Per VIP: 1 poll per server-day.**
- **Race safety:** polls are counted in the order Discord received them. Any poll over either limit (the same VIP's second, or the server's third) that lands before a lock is applied is deleted and logged, and gets no ping.
- **Non-poll messages** from VIPs in #polls are deleted and logged. Discussion goes in the poll's thread. (Staff and admins can post normal messages there, e.g. for announcements.)
- **Deleting your own poll doesn't give your daily poll back.**
- **Daily reset:** at the day boundary, a `poll-unlock` job (same `job_runs` + advisory lock + catch-up rules as §11) removes **only locks that have expired**, including the role-level cap lock. A lock created a moment after the boundary (before the job ran) belongs to the new day and is left alone.
- **`/polls unlock @user`** gives that VIP one more poll today **even if the daily cap is already hit**. The bot removes their personal lock and adds a personal *allow* overwrite (which Discord applies over the role-level lock) until the end of the day. That poll is logged as an admin-granted extra and doesn't change the cap for anyone else.
- **Losing VIP:** access is lost through the VIP role; any lock overwrite for that person is removed at the next reset so overwrites don't pile up.
- **Staff and admins are not limited** by the per-person limit, the daily cap or the locks.
- **Startup reconciliation:** lock overwrites in Discord are made to match `PollLock` rows (missing locks re-applied, expired or orphaned ones removed).

---

## 6. Crown (#1 of the week)

- Awarded at the **Monday reshuffle**, right after VIPs are updated, to the **highest-scoring member of the new VIP list**. The Crown holder is always a VIP. Held for one week. Same person can win again.
- If there are no VIPs (e.g. a dead week where nobody reaches the minimum score), there's no Crown that week.
- Crown gives:
  - A **Crown role** (above VIP, hoisted) with an **exclusive colour** not in the colour picker.
  - The ability to **create their own custom role**.
- If the Crown holder **loses VIP for any reason** mid-week, the Crown goes with it (§3, "Losing VIP") and is **not** reassigned until Monday. Logged.

### Custom role (button → pop-up form)
Slash commands would be visible to everyone, so this uses a button instead, which also gives a proper input form:

1. The VIP lounge panel has **"👑 Create your role"** / **"Edit your role"** buttons. Anyone who isn't the current Crown gets a private "Crown only" reply.
2. Clicking opens a **modal** with:
   - **Role name** (required, 2–32 chars)
   - **Hex colour** (required, e.g. `#ff8800`)
   - **Emoji icon** (optional; only applied if the server has Boost Level 2, otherwise ignored with a note)
3. Validation. Discord doesn't let a form open another form, so on an error the bot sends a private reply listing what's wrong with a **"Try again" button**. That button reopens the form **with their previous answers filled in** (the draft is saved in the DB for 15 minutes, then deleted). Checks:
   - Hex must be valid; reject near-black (invisible on dark mode).
   - Name checked against an admin-managed **blocked words list**.
   - Name can't match or imitate any existing role name (case-insensitive, ignoring spaces/symbols), especially staff roles.
   - Edit limit: 3 edits per Crown week.
4. The bot creates the role directly above the Crown role and assigns it. Logged with the full name/colour.
5. **When the Crown is lost, the custom role is deleted** from the server. Its settings are **saved**; if that person wins the Crown again, it's recreated automatically.
6. Admins: `/crown reset-role @user` (delete it and clear saved settings), `/crown lock @user` (block custom role creation).

---

## 7. VIP history badges

- The bot records every VIP **stint** (start, end, reason).
- **Total weeks held** = total VIP days ÷ 7, across all stints. **Time spent pinned doesn't count**: pinning or unpinning someone splits their stint, and only unpinned time counts toward badges.
- At **4, 12 and 26 weeks** the member gets a **permanent badge role** (e.g. "VIP Regular", "VIP Veteran", "VIP Legend"). Badges stay after VIP is lost.
- Badge roles are created by the bot, **hoisted = false and colourless** so they never override VIP/level colours.
- Milestones are configurable. Earning a badge is mentioned in the next announcement.

---

## 8. Temporary VIP voice channels

- Lounge panel button: **"🔊 Create VIP voice"**.
- Creates a voice channel in the VIP category named after the owner (renameable). One per VIP at a time.
- Owner can rename it and set a user limit (via buttons in the channel's text chat, or limited Manage Channel permission — pick one in Phase 8 and document it).
- **Deleted after 60 s empty.** On startup, the bot deletes any temp channels from the database that are empty and re-tracks the rest.
- If the owner loses VIP, their channel is deleted once empty.

---

## 9. Weekly recap (Monday, after the reshuffle)

One post in the announcements channel:
- New 👑 Crown holder
- Top 3 of the week with scores
- Longest-standing current VIP (consecutive days)
- Number of VIP swaps that week
- Any history badges earned

---

## 10. Admin commands

All registered to the guild only, Administrator-only, and replying privately (ephemeral) unless they post on purpose.

| Command | Purpose |
|---|---|
| `/setup run` | Creates or repairs all roles, the VIP category/channels and the lounge panels. Safe to run again. Checks role positions and warns if the bot's role is too low. |
| `/config view` · `/config set <key> <value>` | Slots, window, buffer, min hold, inactivity days, min score, day boundary, timezone, voice weight, daily voice cap, spam filter thresholds, channels (announce, mod-log), staff roles |
| `/config channel-weight <channel> <weight>` | Set weight; `0` ignores the channel |
| `/vip list` | Current VIPs with rank, score, days held, pinned flag |
| `/vip preview` | What the next reshuffle would do (adds/removes + reasons), plus **bubble watch: ranks 11–15** |
| `/vip pin @user` · `/vip unpin @user` | Lock someone into VIP |
| `/vip remove @user [block_days]` | Remove now; optionally block from VIP for N days |
| `/vip unblock @user` | Clear a block |
| `/vip reshuffle-now` | Run the reshuffle immediately (asks for confirmation with a button) |
| `/vip colours add\|edit\|remove` | Manage colour options |
| `/crown view` · `/crown reset-role @user` · `/crown lock @user` · `/crown unlock @user` | Crown management |
| `/crown blocked-words add\|remove\|list` | Custom role name filter |
| `/polls status` | Polls used today (e.g. 1/2), who posted, who's locked, when the reset is |
| `/polls unlock @user` | Give someone their poll back for today (logged) |
| `/config set polls-role <role>` · `/config set polls-channel <channel>` · `/config set polls-daily-cap <n>` | Which role gets pinged, which channel is the polls channel, and the server-wide daily poll cap |
| `/stats @user` | Score, rank, 7-day breakdown, active days, VIP history, badges |
| `/leaderboard [count]` | Top N this window (private reply) |
| `/activity adjust @user <amount> <reason>` | Manual score correction, logged |
| `/bot health` | Version, uptime, DB connection, last reshuffle time/result, pending writes, intents check |

---

## 11. Data persistence on Railway (must survive every redeploy)

Railway containers are wiped on every deploy, so **no state may live in the bot's filesystem**.

### Only one bot connected at a time
During a redeploy Railway can briefly run the old and new copy together. If both were connected to Discord, activity would be counted twice, buttons would get answered twice, and locks would be applied twice. So:
- On startup, **before logging in to Discord**, the bot takes a Postgres advisory lock called `gateway-leader`, held on its **own dedicated database connection** (not the Prisma pool, which can't hold a lock reliably). If another copy holds it, the new copy waits and retries every 2 s.
- On `SIGTERM`, the old copy flushes its data, disconnects from Discord, then releases the lock and exits. If it dies instead, Postgres releases the lock when its connection drops.
- So the new copy connects to Discord only after the old one is gone. `/bot health` shows which copy is the leader.
- Setup also tells Carson to turn off deploy overlap in Railway's service settings where available. The lock is what guarantees it either way.

- **Database:** a **Railway Postgres service** in the same project, separate from the bot service. The bot reads `DATABASE_URL` through a Railway **reference variable**. Redeploying the bot doesn't touch the database.
- **Backups:** enable scheduled backups in the Postgres service's **Backups** tab. Document a restore drill in `docs/OPERATIONS.md`.
- **Migrations:** Prisma. Production start runs `prisma migrate deploy` only. **Never** `migrate reset`, `db push`, or any migration that drops tables/columns with data without an explicit, documented data-preserving step.
- **Write buffering:** activity counters are batched in memory and flushed to Postgres every 30 s. On `SIGTERM`/`SIGINT` (Railway sends SIGTERM on redeploy) the bot **flushes everything, closes voice sessions, then exits**. Max data loss on a hard crash: 30 s of activity.
- **Voice sessions** are stored in the DB when they start. On startup, the bot closes stale sessions (capped at their last heartbeat) and opens new ones for members currently in voice.
- **Scheduled jobs survive restarts:** every job run is recorded in a `job_runs` table with a unique `(job, period)` key, e.g. `("reshuffle", "2026-10-23")`.
  - On startup, any job whose time has passed and has no row runs immediately (**catch-up**).
  - Jobs take a **Postgres advisory lock**, so if Railway briefly runs the old and new instance together during a deploy, the reshuffle still runs **exactly once**.
- **Role/channel IDs** (not names) are stored in the DB. If a role was deleted, `/setup run` recreates it and updates the ID.
- **Reconciliation on startup and after each reshuffle:** compare DB state with actual Discord roles. Fix drift (e.g. someone manually gave VIP → removed, logged with a hint to use `/vip pin`).
- **Panels keep working after restarts.** Every button and dropdown uses a fixed ID (e.g. `vip:colour-picker`, `crown:create-role`) handled by a global interaction handler, never by temporary collectors. The channel and message ID of each panel is stored in the DB. On startup and on `/setup run`, missing or deleted panels are re-posted.

### Data model (starting point)
`GuildConfig`, `ChannelWeight`, `MemberName (userId, lastKnownName)`, `ActivityDay (userId, serverDay, weightedMessages, voiceMinutes, filteredMessages)`, `TimeoutEvent (userId, start, end)`, `Panel (kind, channelId, messageId)`, `ModalDraft (userId, data, expiresAt)`, `VoiceSession`, `VipMember (userId, since, pinned)`, `VipStint (userId, start, end, endReason, pinned)`, `VipBlock (userId, until, reason)`, `ColourOption`, `UserColourChoice`, `CrownHolder (userId, weekStart, weekEnd)`, `CustomRole (userId, name, hex, emoji, roleId, editsThisWeek, locked)`, `BlockedWord`, `PollPost (userId, messageId, day)`, `PollLock (userId or role-level, until)`, `Badge`, `UserBadge`, `TempVoiceChannel`, `ActivityAdjustment`, `JobRun`, `AuditLog`.

---

## 12. Role order (top to bottom)

```
Bot's role               ← must be above everything it manages
Custom crown role
Crown role
VIP colour roles
VIP role
bleed level roles
History badge roles      (colourless)
@everyone
```
`/setup run` checks this order and warns if the bot's role is too low.

---

## 13. Failure handling

- **Discord's 3-second rule:** any button, dropdown, form or command that changes roles, channels or permissions **replies "working on it…" first** (deferred reply), then edits the reply with the result. Otherwise Discord shows "interaction failed".
- Missing permissions or role-hierarchy problem → no crash; log to mod-log with what to fix.
- Discord rate limits → role changes are queued and applied one at a time.
- Postgres unreachable → buffer in memory, retry with backoff, show it in `/bot health`; skip the reshuffle (catch-up runs it later).
- Unhandled errors are logged with context; the process restarts cleanly (Railway restart policy).

---

## 14. Stack

TypeScript (strict), Node LTS, discord.js v14, Prisma + PostgreSQL, Vitest for tests, pino for logging, zod for env/config validation. Deployed on Railway from GitHub (push to `main` = deploy).
