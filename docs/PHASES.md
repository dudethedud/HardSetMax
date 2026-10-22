# Build phases

Do **one phase per session**. Plan first, wait for approval, then build. Each phase ends with its checks passing and a pull request to review.

Every phase must pass, before it's called done:
- `npm run typecheck` and `npm test` pass
- `npm run lint` passes
- **Redeploy check** (from Phase 1 on): data created in this phase is still there after the bot is restarted and updated
- `docs/DECISIONS.md` updated with any choices made

---

## Phase 0 — Setup (Carson, not Claude Code)
Step-by-step instructions: `docs/SETUP.md`.
- [ ] Create the application + bot in the Discord Developer Portal. Turn on **Server Members** and **Message Content** intents.
- [ ] Invite it to a **test server** first (copy the real server's bleed level roles and a few channels).
- [ ] Create a free **Supabase** project. Copy its **session pooler** connection string and download its **SSL certificate** (`docs/OPERATIONS.md`).
- [ ] Create a free **Wispbyte** Node.js server linked to this GitHub repo, with a `.env` holding `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GUILD_ID`, `DATABASE_URL` and `DATABASE_CA_CERT` (`docs/OPERATIONS.md`).
- [ ] Set a reminder to log in to Wispbyte at least every 2 weeks, or the free server stops.
- [ ] Set up nightly backups: an `age` key pair, GitHub secrets `BACKUP_DATABASE_URL` and `SUPABASE_CA_CERT`, and variable `BACKUP_AGE_RECIPIENT` (`docs/SETUP.md` part 7).
- [ ] Create a free **Groq** account and API key, and a free **Cloudflare** account with a Workers AI API token. Check each one's free limits and data policy. Add `GROQ_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_TOKEN` to the bot's `.env` (only needed by Phase 9).
- [ ] Set the bot's server nickname to **Puppyboy Carter**.
- [ ] When inviting the bot, include **View Audit Log** along with Manage Roles, Manage Channels, Manage Messages and Mention @everyone.

## Phase 1 — Skeleton + persistence proof
- TypeScript project, discord.js client, env validation (zod), pino logging.
- **Single-instance lock** (SPEC §11): `gateway-leader` advisory lock on a dedicated connection, taken before logging in to Discord, released on shutdown.
- **Server-day helper** (SPEC §2) as a pure function with tests, including both DST change dates. Every later phase uses it; no other date logic.
- Prisma set up with `GuildConfig`, `JobRun`, `AuditLog`. `start` script runs `prisma migrate deploy` then the bot.
- Admin command framework: guild-only registration, `default_member_permissions = Administrator`, runtime admin check, ephemeral replies.
- `/bot health`.
- Graceful shutdown handler (SIGTERM/SIGINT) wired up, even if it has little to flush yet.
- **Proof:** set a config value, restart the bot, confirm it's still there. Start a second copy locally and confirm it waits for the hosted one before connecting. Write the steps in `docs/OPERATIONS.md`.

## Phase 2 — Activity tracking
- Message counting (cooldown, length/emoji filter, channel weights, ignored channels). Threads use their parent channel's weight.
- **Spam filter** (repeats, low effort, bursts), message fingerprints in memory only. Filtered count saved per day.
- Voice tracking (alone/AFK/deafened rules), **240-minute daily cap**, sessions stored in DB, startup reconciliation.
- **Timeout tracking**: save timeouts as they happen, catch up from the audit log on startup.
- Save each member's last known name.
- In-memory buffer, 30 s flush, flush on shutdown.
- `/config channel-weight`, `/stats`, `/leaderboard`, `/activity adjust`.
- Tests for the counting rules and spam filter (pure functions).

## Phase 3 — Reshuffle engine (pure logic)
- `computeReshuffle(input) → { added, removed, finalVips }` exactly as SPEC §4.
- `pairAnnouncements(added, removed)`.
- No Discord calls in this phase. **Thorough unit tests:** buffer zone, min hold, inactivity, pinned, blocked, every tie-breaker level, not enough eligible members, min score, empty server.

## Phase 4 — Running the reshuffle for real
- `/setup run`: creates VIP role, lounge category/channels, checks role order.
- Scheduler: daily job, `job_runs` unique key, advisory lock, catch-up on startup.
- Applies roles through a rate-limited queue, records `VipStint`s.
- Announcement message (ping new only) and mod-log entries.
- Reconciliation on startup.
- One shared VIP removal routine (SPEC §3, "Losing VIP"), used by the reshuffle, `/vip remove`, and mid-day events (timeout, leave, staff role added, block). Later phases add their cleanup steps to this same routine.
- `/vip list|preview|pin|unpin|remove|unblock|reshuffle-now`, `/config` commands.
- Panels framework: fixed button/dropdown IDs, global handler, panel message IDs in the DB, re-posted if missing. Deferred replies for anything slow.
- **Test:** run with a clock override on the test server; restart the bot mid-day and confirm the reshuffle neither repeats nor gets skipped.

## Phase 5 — VIP colours + VIP polls
- Colour roles created by `/setup run`, placed above level roles.
- Dropdown panel in the lounge, saved choice, restore on regaining VIP, removal on losing VIP.
- `/vip colours` admin commands.
- #polls channel and permissions created by `/setup run` (SPEC §5a).
- Poll detection, per-user lock on first poll, server-wide daily cap with a role-level lock, bot pings the Polls role, extra polls and non-poll messages deleted.
- Discussion thread on every poll; @everyone can talk in threads only.
- Staff can post polls without limits; their polls still get the ping and thread.
- `poll-unlock` daily job that removes only expired locks, startup reconciliation of lock overwrites.
- `/polls status`, `/polls unlock` (works even past the cap), polls config keys.
- **Test:** post two polls quickly from one VIP account and confirm only one survives and only one ping goes out. Then post from three different VIP accounts in quick succession and confirm only the first two survive, the channel locks for all VIPs, and it unlocks at the reset.

## Phase 6 — Crown + custom role
- Monday crown logic (pure function + tests): highest scorer among the new VIP list, no Crown if no VIPs. Crown role with exclusive colour.
- Lounge buttons → modal with name / hex / emoji.
- Validation (hex, near-black, blocked words, role-name impersonation, edit limit), with a "Try again" button that reopens the form pre-filled.
- Delete on crown loss, save settings, recreate on re-win.
- `/crown` admin commands and blocked-words management.

## Phase 7 — History badges + weekly recap
- Total-weeks calculation from `VipStint`s, excluding pinned time (tests), badge roles, milestone awards.
- Monday recap post.

## Phase 8 — Temporary VIP voice
- Create button, one per VIP, owner controls, delete after 60 s empty, startup cleanup.

## Phase 9 — AI chat (Puppyboy Carter)
- AI client with a **provider chain** (Groq → Cloudflare Workers AI → pre-written replies), per-provider daily caps and reset times, failover on error/timeout/429, provider cooldowns. 10 s timeout per attempt. Confirm how to call Cloudflare Workers AI from outside Cloudflare and choose its model.
- Replies to @mentions and to replies to its own messages, **main chat only**. Reads up to 6 messages of the reply chain from Discord; saves nothing.
- Personality prompt + VIP guide in `prompts/`. Asker's own stats only.
- Safety: no tools, mention stripping, `allowed_mentions` locked to the asker, blocked-words check on output.
- Per-person limit of 3 replies per minute (👀 reaction when over), pre-written fallback replies.
- AI hype line on the daily update and Monday recap (numbers always from code), AI welcome for new VIPs.
- `/ai status|toggle|test|providers|provider-cap|provider-toggle`, AI config keys.
- **Tests:** chain moves to the next provider on error, timeout, 429 and cap; falls back to pre-written when all are out; provider usage resets at each provider's own time; "give me VIP" style prompts change nothing; AI output with `@everyone` pings nobody.

## Phase 10 — Hardening + handoff
- Failure handling from SPEC §13; permission/hierarchy errors reported clearly.
- Data pruning (activity older than 60 days).
- **Backup restore drill** done once and documented.
- `README.md`: setup, Wispbyte + Supabase deploy, environment variables, every admin command.
- Move from test server to the real server: `/setup run`, check role order, watch the first reshuffle.
