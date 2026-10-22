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
| **Message** | At most **1 per user per 60 s** (configurable) | Under 4 characters after trimming, emoji/sticker-only, in an ignored channel, from a bot, in DMs |
| **Voice minute** | User is in a voice channel with at least 1 other non-bot member | Alone, in the AFK channel, self-deafened, server-deafened |

### Channel weighting
- Each text channel has a weight, default `1.0`. Example: main chat `1.0`, memes `0.5`, bot-spam `0` (ignored).
- Voice minutes have a global weight, default `0.2` (5 voice minutes ≈ 1 message).

### Score
```
score(user) = Σ over the last 7 days of (weighted messages + voice_minutes × voice_weight)
```
- Window length (default **7 days**) is configurable.
- Stored as **daily buckets per user** (date in the server's timezone, default `America/Edmonton`). Days are counted as "active" if the user had any counted activity.
- Buckets older than 60 days are pruned.

### Required Discord intents
`Guilds`, `GuildMembers` (privileged), `GuildMessages`, `MessageContent` (privileged — needed for the length/emoji check), `GuildVoiceStates`. Turn both privileged intents on in the Developer Portal.

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

---

## 4. Daily reshuffle

Runs **once a day** at a configured time (default 00:05 server time). Never live.

### Algorithm (pure function, fully unit-tested)
Inputs: eligible members with scores and last-active dates, current VIPs (with `vipSince`), pinned users, blocked users, config.

1. **Rank** all eligible members by score (ties broken by more active days, then earlier last-active).
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
- **Losing VIP removes the colour role** in the same reshuffle.
- The user's **last pick is saved**; regaining VIP restores it automatically.
- Admins manage options with `/vip colours add|edit|remove`.

---

## 5a. VIP polls

A **#polls** channel where only VIPs can post Discord's built-in polls. There's a **server-wide cap of 2 polls per day** (first come, first served), **each VIP can post at most 1 of those**, and the bot pings the **Polls** role for them.

### Channel permissions (set by `/setup run`)
| Who | Can |
|---|---|
| @everyone | View channel, read history, vote in polls. Can't send messages. |
| VIP role | Send Messages + Send Polls |
| Bot | Send Messages, Manage Messages, Manage Permissions, Mention @everyone/roles |

### Posting
1. A VIP posts a Discord poll in #polls.
2. The bot **immediately locks the channel for that VIP only**: a member-specific permission overwrite denying Send Messages and Send Polls. The lock is saved in the DB (`PollLock`) with the reset time.
3. If that poll **reaches the daily cap**, the bot also **locks the channel for the whole VIP role** (a role overwrite denying Send Messages and Send Polls) until the reset. Saved in the DB as a role-level lock.
4. The bot **replies to the poll** with `<@&PollsRole> 📊 New poll from @vipname`, using `allowed_mentions` so only the Polls role and the author are pinged.
5. **VIPs never ping the Polls role themselves.** The Polls role is not mentionable, and VIPs don't have Mention Everyone, so typing `@Polls` does nothing.

### Rules
- **Server cap: 2 polls per server-day** across all VIPs (config `polls-daily-cap`, default 2). Days use the same timezone as the reshuffle.
- **Per VIP: 1 poll per server-day.**
- **Race safety:** polls are counted in the order Discord received them. Any poll over either limit (the same VIP's second, or the server's third) that lands before a lock is applied is deleted and logged, and gets no ping.
- **Non-poll messages** from VIPs in #polls are deleted and logged. Discussion goes in the poll's thread or a normal channel.
- **Deleting your own poll doesn't give your daily poll back.**
- **Daily reset:** at the reshuffle time, a `poll-unlock` job (same `job_runs` + advisory lock + catch-up rules as §11) removes every expired lock overwrite, including the role-level cap lock.
- **Losing VIP:** access is lost through the VIP role; any lock overwrite for that person is removed at the next reset so overwrites don't pile up.
- Staff and admins are not limited.
- **Startup reconciliation:** lock overwrites in Discord are made to match `PollLock` rows (missing locks re-applied, expired or orphaned ones removed).

---

## 6. Crown (#1 of the week)

- Awarded at the **Monday reshuffle** to the top-ranked eligible member. Held for one week. Same person can win again.
- Crown gives:
  - A **Crown role** (above VIP, hoisted) with an **exclusive colour** not in the colour picker.
  - The ability to **create their own custom role**.
- If the Crown holder becomes ineligible mid-week (timed out, leaves, blocked), the Crown is removed and **not** reassigned until Monday. Logged.

### Custom role (button → pop-up form)
Slash commands would be visible to everyone, so this uses a button instead, which also gives a proper input form:

1. The VIP lounge panel has **"👑 Create your role"** / **"Edit your role"** buttons. Anyone who isn't the current Crown gets a private "Crown only" reply.
2. Clicking opens a **modal** with:
   - **Role name** (required, 2–32 chars)
   - **Hex colour** (required, e.g. `#ff8800`)
   - **Emoji icon** (optional; only applied if the server has Boost Level 2, otherwise ignored with a note)
3. Validation (show errors in a private reply, keep what they typed where possible):
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
- **Total weeks held** = total VIP days ÷ 7, across all stints.
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
| `/config view` · `/config set <key> <value>` | Slots, window, buffer, min hold, inactivity days, min score, reshuffle time, timezone, voice weight, channels (announce, mod-log), staff roles |
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

### Data model (starting point)
`GuildConfig`, `ChannelWeight`, `ActivityDay (userId, date, weightedMessages, voiceMinutes)`, `VoiceSession`, `VipMember (userId, since, pinned)`, `VipStint (userId, start, end, endReason)`, `VipBlock (userId, until, reason)`, `ColourOption`, `UserColourChoice`, `CrownHolder (userId, weekStart, weekEnd)`, `CustomRole (userId, name, hex, emoji, roleId, editsThisWeek, locked)`, `BlockedWord`, `PollPost (userId, messageId, day)`, `PollLock (userId or role-level, until)`, `Badge`, `UserBadge`, `TempVoiceChannel`, `ActivityAdjustment`, `JobRun`, `AuditLog`.

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

- Missing permissions or role-hierarchy problem → no crash; log to mod-log with what to fix.
- Discord rate limits → role changes are queued and applied one at a time.
- Postgres unreachable → buffer in memory, retry with backoff, show it in `/bot health`; skip the reshuffle (catch-up runs it later).
- Unhandled errors are logged with context; the process restarts cleanly (Railway restart policy).

---

## 14. Stack

TypeScript (strict), Node LTS, discord.js v14, Prisma + PostgreSQL, Vitest for tests, pino for logging, zod for env/config validation. Deployed on Railway from GitHub (push to `main` = deploy).
