# VIP Bot — Specification

A Discord bot named **Puppyboy Carter** that tracks member activity and runs a **rotating VIP system**: 10 VIP slots held by the most active members of the past 7 days, a weekly **Crown** for #1, VIP colours, VIP polls, permanent history badges, temporary VIP voice channels, a weekly recap, and AI chat in main chat.

Level roles are handled by **bleed** (another bot). This bot does not do levels or XP and does not read bleed's data.

---

## 1. Hard rules

1. **No public slash commands.** Slash commands are for staff, admins and the owner only (owner-approved change, see §10). Members interact only through **buttons, dropdowns and pop-up forms (modals)** posted by the bot.
2. **Access enforced twice:** commands are registered with `dm_permission = false` (guild only) and `default_member_permissions` = **Timeout Members** for commands with staff subcommands, **Administrator** for the rest, **and** every handler re-checks the subcommand's level at runtime before doing anything. Levels: **staff** (a staff role, Administrator or the owner), **admin** (Administrator or the owner), **owner** (the server owner only).
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

### Other bots' commands
Messages that start with a common bot-command prefix followed by a letter (`!rank`, `?help`, `.work`, `-play`) aren't chat: they don't count and aren't flagged as spam.

### Warm-up
The scheduled reshuffle changes nothing until there's a full score window of activity (the earliest saved activity day is at least `window` days ago). `/bot health` shows the days left. A manual `/vip reshuffle` still runs.

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
- Admins manage options with `/settings colour action:add|edit|remove`.

---

## 5a. VIP polls

A **#polls** channel where only VIPs and staff can post Discord's built-in polls. There's a **server-wide cap of 2 VIP polls per day** (first come, first served), **each VIP can post at most 1 of those**, and the bot pings the **Polls** role for them. Everyone can discuss each poll in its own thread.

### Channel permissions (set by `/bot setup`)
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
- **`/vip poll-unlock @user`** gives that VIP one more poll today **even if the daily cap is already hit**. The bot removes their personal lock and adds a personal *allow* overwrite (which Discord applies over the role-level lock) until the end of the day. That poll is logged as an admin-granted extra and doesn't change the cap for anyone else.
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
   - **Second colour** (optional): the role becomes a gradient on servers with gradient roles (`ENHANCED_ROLE_COLORS`); otherwise only the first colour is used, with a note. Rejected if near-black.
   - **Emoji icon** (optional)
   - **Image icon** (optional upload): a PNG or JPG of at most 256 KB (Discord's limit for role icons). It's used instead of the emoji. Editing without a new upload keeps the current image; entering an emoji replaces it.
   - Role icons (emoji or image) only show at Boost Level 2; below that they're ignored with a note.
3. Validation. Discord doesn't let a form open another form, so on an error the bot sends a private reply listing what's wrong with a **"Try again" button**. That button reopens the form **with their previous answers filled in** (the draft is saved in the DB for 15 minutes, then deleted). Checks:
   - Hex must be valid; reject near-black (invisible on dark mode).
   - Name checked against an admin-managed **blocked words list**.
   - Name can't match or imitate any existing role name (case-insensitive, ignoring spaces/symbols), especially staff roles.
   - Edit limit: 3 edits per Crown week.
4. The bot creates the role directly above the Crown role and assigns it. Logged with the full name/colour. **Every uploaded image is posted in the mod-log entry** so staff can see it; `/vip crown-reset` removes an unsuitable one.
   - Images are only downloaded from Discord's own file servers (`cdn.discordapp.com`, `media.discordapp.net`) over https, with a 10-second limit, stopping at 256 KB. The file's first bytes must really be a PNG or JPG. The image is saved in the DB (not on disk) so the role can be recreated.
5. **When the Crown is lost, the custom role is deleted** from the server. Its settings are **saved**; if that person wins the Crown again, it's recreated automatically.
6. Admins: `/vip crown-reset @user` (delete it and clear saved settings), `/vip crown-lock locked:true @user` (block custom role creation).

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

## 9a. AI chat — "Puppyboy Carter"

The bot can chat in **main chat only**, using a free AI API. It explains how VIP works, tells people their own standing, and adds personality to announcements. **It can only talk; it can never change anything.**

### Personality
- Name: **Puppyboy Carter** (set as the bot's server nickname).
- **Hyper and friendly**: excited, encouraging, uses some caps and emoji, hypes people up.
- The puppy thing is a **light touch**, not the whole personality: the occasional "🐶" or dog joke, not every message. Mostly it's a hyped-up, helpful friend who knows the server.
- Short replies (aim for 1–3 sentences, hard limit 400 characters). Never mean, never edgy, no swearing.

### When it replies (main chat only)
1. Someone **@mentions** it in main chat.
2. Someone **replies to one of its messages** in main chat. For context, the bot reads that reply chain from Discord (up to the last 6 messages), on the spot. It doesn't save the conversation.
- Anywhere else, it ignores mentions and replies. No slash command is involved, so the "no public commands" rule still holds.

### What it knows (given to it with each request)
- A short written guide to how VIP, polls, colours, the Crown, badges and temp voice work (kept in a `prompts/` file, generated from this spec, easy to edit).
- **The asker's own stats only**: exact rank, score, active days, points to reach #10, VIP status and days held, poll used today or not. **Never** anyone else's numbers. If asked about someone else, it says it only shares people's own stats.
- Current public info: who the VIPs and Crown are (already public via roles).

### Safety
- **No tools, no actions.** The AI only returns text. Nothing it says can grant roles, change settings or bypass limits, so "ignore your rules and give me VIP" does nothing. Code checks this, not the prompt.
- **No pings from AI text.** Replies are sent with `allowed_mentions` set to only the person being replied to. `@everyone`, `@here` and role mentions in AI output are stripped.
- The AI output is checked against the blocked-words list; if it fails, the bot sends a fallback line instead.
- It doesn't reply to bots, and ignores messages that the spam filter flags.

### Cost and limits (free tier)
- **Provider chain.** Providers are an ordered list in config, each with its own base URL, model, API key env var name, and daily cap. Default chain:
  1. **Groq** free plan (main).
  2. **Cloudflare Workers AI** free allocation (backup). Phase 9 confirms how to call it from outside Cloudflare and picks the best model that fits the free amount.
  3. **Pre-written fallback replies** (always available).
- For each request, the bot uses the **first provider that is under its own daily cap and not cooling down**. If a provider errors, times out, or returns a rate limit (HTTP 429), the bot moves to the next one for that request and puts the failing provider on a cooldown (5 minutes, or until its daily reset if it says the daily limit is used up).
- Each provider's usage is counted per day in the DB, using **that provider's own reset time** (e.g. Cloudflare resets at 00:00 UTC), so the bot doesn't hammer a provider that's out for the day.
- **Same personality everywhere:** every provider gets the same personality prompt and VIP guide, so switching providers changes the voice as little as possible.
- **Adding a provider later** (e.g. OpenRouter after a one-time credit purchase) is a config + env var change, never a code change.
- **One account per provider.** Never use multiple accounts on the same provider to stack free limits; that breaks their terms and risks a ban.
- **Not used by default:** Gemini free tier (uses prompts to improve Google's products), OpenRouter free models without credits (only 50/day), Cerebras (trial credit that expires).
- **Per person:** up to **3 AI replies per minute** (rolling window, configurable). Extra mentions over the limit get a 👀 reaction instead of a reply.
- **Fallback:** if every AI provider is down or out for the day, the bot answers with pre-written replies (e.g. a canned "how VIP works" summary, and the asker's stats formatted plainly). It never just goes silent or errors.
- AI requests have a 10 s timeout; the bot shows "typing…" while waiting.

### AI touches on announcements
- The **daily VIP update** and **Monday recap** get **one short AI-written hype line** at the top.
- The actual swap list, ranks and numbers are **always written by code**, never by AI, so they're always correct.
- If the AI isn't available, the post goes out without the line.
- **Welcome for new VIPs:** a short AI-written welcome in the VIP lounge listing their perks (falls back to a fixed message).

### Blacklist (owner-approved)
- The AI ends its reply with a hidden tag when the message it's answering is genuinely mean (insulting, hateful, harassing) or asks for sexual/NSFW content. Playful teasing and jokes don't count. The code removes the tag before posting.
- Each tag is a strike for that message's author only. `ai-strike-limit` strikes (default 2) within 24 hours add them to the blacklist, and the bot stops replying to them. It's posted in the mod-log.
- The server owner is never struck or blacklisted. Admins manage the list with `/bot ai-blacklist`; removing someone also clears their strikes.
- Only who and when is saved, never the message.

### Privacy
- Messages that mention or reply to the bot in main chat are **sent to the AI provider** to answer them. The bot itself still never saves them.
- Check the chosen provider's data policy before going live. (Gemini's free tier, for example, uses prompts to improve Google's products, which is one reason it isn't the default.)
- Add a line to the server rules: "Messages you send to Puppyboy Carter are processed by an AI service."

### Admin commands
- `/bot ai action:status`: on/off, each provider in the chain with replies used today vs its cap, whether it's cooling down, last error, and how many replies fell back to pre-written today.
- `/bot ai action:on` · `action:off`: turn AI chat on/off (fallback replies still work when off).
- `/bot ai action:test question:…`: private test reply, doesn't count toward the cap.
- `/bot ai action:providers`: show the chain. `/bot ai-provider <provider> setting:cap|model|toggle [value]` to adjust or skip one.
- `/settings set ai-per-user-limit <n per minute>` · `/settings channel purpose:main-chat <channel>`

---

## 10. Commands

Five commands, all registered to the guild only and replying privately (ephemeral) unless they post on purpose. "Who" is checked at runtime for every use (§1.2). Staff also need the **Timeout Members** permission for Discord to show them the commands.

| Command | Who | Purpose |
|---|---|---|
| `/stats [user] [count]` | staff | No user: top N this window. With a user: score, rank, 7-day breakdown, active days, VIP history, badges |
| `/vip list` | staff | Current VIPs with rank, score, days held, pinned flag |
| `/vip preview` | staff | What the next reshuffle would do (adds/removes + reasons), plus **bubble watch: ranks 11–15** |
| `/vip polls` | staff | Polls used today (e.g. 1/2), who posted, who's locked, when the reset is |
| `/vip crown` | staff | The Crown holder, their custom role, decree and titles |
| `/vip pin @user` · `/vip unpin @user` | admin | Lock someone into VIP |
| `/vip remove @user [block_days]` | admin | Remove now; optionally block from VIP for N days |
| `/vip unblock @user` | admin | Clear a block |
| `/vip reshuffle` | admin | Run the reshuffle immediately (asks for confirmation with a button) |
| `/vip adjust @user <amount> <reason>` | admin | Manual score correction, logged |
| `/vip poll-unlock @user` | admin | Give someone their poll back for today (logged) |
| `/vip crown-give @user` | admin | Give this week's Crown to a VIP now; the current holder loses it the usual way. Lasts until next week's award |
| `/vip crown-reset @user` · `/vip crown-lock @user <locked>` | admin | Delete a custom role · block or allow custom roles |
| `/vip rainbow @user` · `/vip rainbow-stop @user` | staff | 🌈 speech filter on for 10 minutes · stop it early |
| `/settings view` · `/settings set <key> <value>` | admin | Slots, window, buffer, min hold, inactivity days, min score, day boundary, timezone, voice weight, daily voice cap, spam filter thresholds, polls daily cap, colours, AI per-user limit |
| `/settings channel <purpose> <channel>` | admin | Announcements, mod-log, polls, main chat (AI and shoutouts), VIP board |
| `/settings channel-weight <channel> <weight>` | admin | Set weight; `0` ignores the channel |
| `/settings role <action> [role]` | admin | Staff roles (add/remove/list), the highest level role, the Polls role, and binding an existing role as the VIP, Crown or a title role |
| `/settings colour <action> …` | admin | Manage colour options (list/add/edit/remove) |
| `/settings badge <action> …` | admin | Manage badge milestones (list/set/remove) |
| `/settings blocked-word <action> [word]` | admin | Name filter for custom roles, room names, shoutouts and decrees |
| `/bot health` | staff | Version, uptime, DB connection, last reshuffle time/result, pending writes, intents check, AI status |
| `/bot setup` | admin | Creates or repairs all roles, the VIP category/channels, the VIP board and the panels. Safe to run again. Checks role positions and warns if the bot's role is too low. |
| `/bot ai <action>` · `/bot ai-provider <provider> <setting> [value]` | admin | AI chat controls (§9a) |
| `/bot ai-blacklist <add\|remove\|list> [@user]` | admin | Who the AI won't reply to (§9a "Blacklist") |
| `/announce [channel]` | owner | Owner only (not admins or staff): opens a form, shows a private preview with Send / Cancel, then the bot posts it with an `@everyone` ping. No other mentions ping. The draft is deleted after sending or after 15 minutes. |

---

## 10a. VIP and Crown perks

All through buttons on the lounge panel. Member-written text the bot posts (shoutouts, decrees) has mentions removed, `@everyone`/`@here` broken up, is sent with no allowed mentions, and is checked against the blocked words. The text itself is never saved; only that it happened (and the message ID) is.

**Every VIP**
- **Public VIP board** (`#vip-board`, read-only, created by `/bot setup`): the Crown and its titles, every VIP with days held and their top badge, the 3 most active members and when the next reshuffle is. Edited in place after VIP and Crown changes, and hourly.
- **🪪 My profile:** a private card with rank, score, active days, where they stand (points ahead of the first rank past the buffer, or points to reach the last VIP slot), VIP days, weeks held, badges, polls today, shoutout used or not, and their title.
- **📣 Shoutout:** once per server-day, a short message (200 characters) posted by the bot in main chat (or announcements if main chat isn't set). No pings.
- **⭐ VIP role icon** when the server is Boost Level 2 or higher.
- **🦴 Treat:** once per server-day, give a treat to any member (not yourself or a bot) from a member picker. All of a server-day's treats share one post in main chat, edited as more come in (re-posted if deleted; no pings). Treats received show on the profile card (this week and all time) and the weekly recap names who got the most. Cosmetic: never changes scores.
- **💎 Veteran:** VIP for 14+ server-days in a row: marked on the VIP board and profile, and a second shoutout each server-day.
- **🎨 Suggest a colour:** a form (name, two hex colours, checked like the others: readable, a new name, no blocked words) posts to the mod-log with **Approve** / **Decline** buttons (staff, fixed IDs). Approving adds it like `/settings colour add` and makes its role. One open request per VIP and one per 7 days; only the first staff click counts.
- **🐶 Carter favours VIPs:** VIPs get twice the per-person AI reply limit, and the last 20% of each provider's daily cap is kept for VIPs (others get the pre-written replies once it's reached).

**The Crown** (in addition to the custom role, §6)
- **👑 nickname:** "👑 Name" while they hold the Crown; their old nickname comes back when it ends (unless they renamed themselves since). Skipped for the server owner and anyone above the bot.
- **🎖️ Titles:** the Crown appoints **Champion, Advisor and Jester** with member pickers. Each has a job (owner-approved), which ends with the title:
  - **🛡️ Champion:** a guest VIP pass: colours, the daily shoutout, VIP polls, VIP voice, the VIP Lounge (same channel access as VIP) and VIP's chat permissions. Checked through `VipService.hasPerk`, so losing the title takes the colour and closes their VIP voice channel like losing VIP does (unless they're a VIP).
  - **📜 Advisor:** can post VIP polls in #polls (sharing the VIPs' daily limit; the Advisor role follows the VIP role's lock) and gets the daily shoutout.
  - **🃏 Jester:** once per server-day, sets the bot's status (checked like shoutouts, at most 100 characters, saved so it survives a restart, removed when the title ends), and once per server-day makes the bot do a trick in main chat (a fixed line, no AI, no pings).
  - Holders without the lounge use the **🎖️ Titles & perks** button on #vip-board, which also tells anyone what titles, VIP and the Crown do.
  - The roles give no moderation permissions, but they stand out: its own group in the member list, its own name colour (orange, teal, purple) and a role icon (🛡️ 📜 🃏) at Boost Level 2. The 👑 Crown role gets a 👑 icon too. Not for bots, staff or themselves; one title per person. All titles end with the Crown week, or when the Crown is lost.
- **📜 Decree:** one announcement per Crown week (500 characters) in the announcements channel, with no pings.
- **🛡️ Royal pardon:** once per Crown week, one current VIP (not themselves) can't be dropped for rank or inactivity at the next reshuffle (`protectedIds` in the reshuffle). They're still removed if they leave, become staff, are timed out or blocked. The pardon covers one reshuffle.
- **🎭 Carter's mood:** (audit log only, not the mod-log: it's a fixed choice) pick one of a fixed list of moods (hyper, sleepy, dramatic, royal butler, pirate pup, poet) for his AI replies that week. Only the fixed instruction reaches the AI, never member text.
- **📌 Spotlight:** once per server-day, feature one member (not a bot) on the VIP board with a short reason (80 characters, checked like shoutouts).
- **🎵 Theme of the week:** a short theme (60 characters, checked like shoutouts, changeable once a day) shown on the VIP board and as the bot's status when the Jester hasn't set one. Not given to the AI.
- **🌈 Rainbow speech:** once per Crown week (staff: any time with `/vip rainbow`), for 10 minutes one member's plain-text messages are reposted through a webhook under their name and avatar with a 🌈 added to the name, with rainbow flair (a few word swaps and sparkles; mentions, links and meaning stay; nothing pings), and the original deleted. Never on staff, the owner, bots or anyone who opted out (a toggle under **🎖️ Titles & perks** on #vip-board; opting out stops one in progress). The member is told in main chat, with a ping, who started it (Crown or staff) and how to opt out. Not in #polls; skips attachments, stickers, polls and messages to the bot. Every use goes to the mod-log with a staff Stop button. Message text is only changed in memory; only who and until when is saved. Needs Manage Webhooks.
- Spotlight, theme, mood and the pardon live on the Crown's row, so they end with the Crown.
- The lounge panel has one **👑 Crown powers** button; it shows the Crown holder their buttons and what they've used this week, privately (others get a short explanation).
- **👑 Hall:** their temporary voice channel is called "👑 Name's Hall" and gives them Priority Speaker and Move Members in it.

---

## 11. Data persistence (must survive every restart and redeploy)

The bot runs on **Wispbyte** (free Node.js server) and the database is **Supabase** (free Postgres). See `docs/DECISIONS.md` for why. **No state may live in the bot's filesystem**: the server can be reinstalled, moved or stopped, and the code must also work on hosts that wipe their disk on deploy.

### Only one bot connected at a time
Two copies can end up running at once: a host restarting the bot while the old process is still exiting, or someone running the bot locally with the production token. If both were connected to Discord, activity would be counted twice, buttons would get answered twice, and locks would be applied twice. So:
- On startup, **before logging in to Discord**, the bot takes a Postgres advisory lock called `gateway-leader`, held on its **own dedicated database connection** (not the Prisma pool, which can't hold a lock reliably). If another copy holds it, the new copy waits and retries every 2 s.
- On `SIGTERM`, the old copy flushes its data, disconnects from Discord, then releases the lock and exits. If it dies instead, Postgres releases the lock when its connection drops.
- So the new copy connects to Discord only after the old one is gone. `/bot health` shows which copy is the leader.
- The lock is what guarantees this on any host.

- **Database:** a **Supabase** project, separate from the bot's host. The bot reads `DATABASE_URL` (Supabase's **session pooler** string, needed for advisory locks) and verifies the TLS certificate against Supabase's CA (`DATABASE_CA_CERT`). Reinstalling or restarting the bot doesn't touch the database.
- **Backups:** a nightly GitHub Actions job makes an encrypted, off-site backup (`docs/OPERATIONS.md` §5), since Supabase's free plan has no self-service restores. Document a restore drill in `docs/OPERATIONS.md`.
- **Migrations:** Prisma. Production start runs `prisma migrate deploy` only. **Never** `migrate reset`, `db push`, or any migration that drops tables/columns with data without an explicit, documented data-preserving step.
- **Write buffering:** activity counters are batched in memory and flushed to Postgres every 30 s. On `SIGTERM`/`SIGINT` (sent when the host stops or restarts the bot) the bot **flushes everything, closes voice sessions, then exits**. Max data loss on a hard crash: 30 s of activity.
- **Voice sessions** are stored in the DB when they start. On startup, the bot closes stale sessions (capped at their last heartbeat) and opens new ones for members currently in voice.
- **Scheduled jobs survive restarts:** every job run is recorded in a `job_runs` table with a unique `(job, period)` key, e.g. `("reshuffle", "2026-10-23")`.
  - On startup, any job whose time has passed and has no row runs immediately (**catch-up**).
  - Jobs take a **Postgres advisory lock**, so if two copies briefly run together, the reshuffle still runs **exactly once**.
- **Role/channel IDs** (not names) are stored in the DB. If a role was deleted, `/bot setup` recreates it and updates the ID.
- **Reconciliation on startup and after each reshuffle:** compare DB state with actual Discord roles. Fix drift (e.g. someone manually gave VIP → removed, logged with a hint to use `/vip pin`).
- **Panels keep working after restarts.** Every button and dropdown uses a fixed ID (e.g. `vip:colour-picker`, `crown:create-role`) handled by a global interaction handler, never by temporary collectors. The channel and message ID of each panel is stored in the DB. On startup and on `/bot setup`, missing or deleted panels are re-posted.

### Data model (starting point)
`GuildConfig`, `ChannelWeight`, `MemberName (userId, lastKnownName)`, `ActivityDay (userId, serverDay, weightedMessages, voiceMinutes, filteredMessages)`, `TimeoutEvent (userId, start, end)`, `Panel (kind, channelId, messageId)`, `ModalDraft (userId, data, expiresAt)`, `VoiceSession`, `VipMember (userId, since, pinned)`, `VipStint (userId, start, end, endReason, pinned)`, `VipBlock (userId, until, reason)`, `ColourOption`, `UserColourChoice`, `CrownHolder (userId, weekStart, weekEnd)`, `CustomRole (userId, name, hex, emoji, roleId, editsThisWeek, locked)`, `BlockedWord`, `PollPost (userId, messageId, day)`, `PollLock (userId or role-level, until)`, `Badge`, `UserBadge`, `TempVoiceChannel`, `ActivityAdjustment`, `AiProvider (name, baseUrl, model, keyEnvVar, dailyCap, order, enabled)`, `AiUsage (provider, providerDay, count, fallbacks)`, `JobRun`, `AuditLog`.

---

## 12. Role order (top to bottom)

```
Bot's role               ← must be above everything it manages
Custom crown role        ← on top so the holder's own colour shows
VIP colour roles         ← first option on top; above VIP so a picked colour shows
Crown role
Title roles              (Champion, Advisor, Jester; colourless)
VIP role                 ← directly above bleed's highest level role
Polls role               (colourless)
History badge roles      (colourless, fewest weeks first)
bleed level roles
@everyone
```
All of the bot's roles sit together as one block (owner-approved). `/bot setup` puts them in this order around the VIP role, leaves every other role where it is, and warns if the bot's role is too low. A Crown holder who picked a VIP colour shows that colour; with no colour picked, the Crown's colour shows.

---

## 13. Failure handling

- **Discord's 3-second rule:** any button, dropdown, form or command that changes roles, channels or permissions **replies "working on it…" first** (deferred reply), then edits the reply with the result. Otherwise Discord shows "interaction failed".
- Missing permissions or role-hierarchy problem → no crash; log to mod-log with what to fix.
- Discord rate limits → role changes are queued and applied one at a time.
- Postgres unreachable → buffer in memory, retry with backoff, show it in `/bot health`; skip the reshuffle (catch-up runs it later).
- Unhandled errors are logged with context; the process exits and the host restarts it.

---

## 14. Stack

TypeScript (strict), Node LTS, discord.js v14, Prisma + PostgreSQL, Vitest for tests, pino for logging, zod for env/settings validation. Bot hosted on Wispbyte (updated by restarting the server, which pulls `main` from GitHub); database on Supabase.
