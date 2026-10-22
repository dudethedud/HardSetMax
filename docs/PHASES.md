# Build phases

Do **one phase per session**. Plan first, wait for approval, then build. Each phase ends with its checks passing and a pull request to review.

Every phase must pass, before it's called done:
- `npm run typecheck` and `npm test` pass
- `npm run lint` passes
- **Redeploy check** (from Phase 1 on): data created in this phase is still there after a Railway redeploy
- `docs/DECISIONS.md` updated with any choices made

---

## Phase 0 — Setup (Carson, not Claude Code)
- [ ] Create the application + bot in the Discord Developer Portal. Turn on **Server Members** and **Message Content** intents.
- [ ] Invite it to a **test server** first (copy the real server's bleed level roles and a few channels).
- [ ] Create a Railway project: add a **Postgres** service, then a service connected to this GitHub repo.
- [ ] In the bot service, add variables: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GUILD_ID`, and `DATABASE_URL` as a reference to the Postgres service.
- [ ] Turn on scheduled backups in the Postgres **Backups** tab.

## Phase 1 — Skeleton + persistence proof
- TypeScript project, discord.js client, env validation (zod), pino logging.
- Prisma set up with `GuildConfig`, `JobRun`, `AuditLog`. `start` script runs `prisma migrate deploy` then the bot.
- Admin command framework: guild-only registration, `default_member_permissions = Administrator`, runtime admin check, ephemeral replies.
- `/bot health`.
- Graceful shutdown handler (SIGTERM/SIGINT) wired up, even if it has little to flush yet.
- **Proof:** set a config value, redeploy on Railway, confirm it's still there. Write the steps in `docs/OPERATIONS.md`.

## Phase 2 — Activity tracking
- Message counting (cooldown, length/emoji filter, channel weights, ignored channels).
- Voice tracking (alone/AFK/deafened rules), sessions stored in DB, startup reconciliation.
- In-memory buffer, 30 s flush, flush on shutdown.
- `/config channel-weight`, `/stats`, `/leaderboard`, `/activity adjust`.
- Tests for the counting rules (pure functions).

## Phase 3 — Reshuffle engine (pure logic)
- `computeReshuffle(input) → { added, removed, finalVips }` exactly as SPEC §4.
- `pairAnnouncements(added, removed)`.
- No Discord calls in this phase. **Thorough unit tests:** buffer zone, min hold, inactivity, pinned, blocked, ties, not enough eligible members, min score, empty server.

## Phase 4 — Running the reshuffle for real
- `/setup run`: creates VIP role, lounge category/channels, checks role order.
- Scheduler: daily job, `job_runs` unique key, advisory lock, catch-up on startup.
- Applies roles through a rate-limited queue, records `VipStint`s.
- Announcement message (ping new only) and mod-log entries.
- Reconciliation on startup.
- `/vip list|preview|pin|unpin|remove|unblock|reshuffle-now`, `/config` commands.
- **Test:** run with a clock override on the test server; restart the bot mid-day and confirm the reshuffle neither repeats nor gets skipped.

## Phase 5 — VIP colours + VIP polls
- Colour roles created by `/setup run`, placed above level roles.
- Dropdown panel in the lounge, saved choice, restore on regaining VIP, removal on losing VIP.
- `/vip colours` admin commands.
- #polls channel and permissions created by `/setup run` (SPEC §5a).
- Poll detection, per-user lock on first poll, server-wide daily cap with a role-level lock, bot pings the Polls role, extra polls and non-poll messages deleted.
- `poll-unlock` daily job, startup reconciliation of lock overwrites.
- `/polls status`, `/polls unlock`, polls config keys.
- **Test:** post two polls quickly from one VIP account and confirm only one survives and only one ping goes out. Then post from three different VIP accounts in quick succession and confirm only the first two survive, the channel locks for all VIPs, and it unlocks at the reset.

## Phase 6 — Crown + custom role
- Monday crown logic (pure function + tests), crown role with exclusive colour.
- Lounge buttons → modal with name / hex / emoji.
- Validation (hex, near-black, blocked words, role-name impersonation, edit limit).
- Delete on crown loss, save settings, recreate on re-win.
- `/crown` admin commands and blocked-words management.

## Phase 7 — History badges + weekly recap
- Total-weeks calculation from `VipStint`s (tests), badge roles, milestone awards.
- Monday recap post.

## Phase 8 — Temporary VIP voice
- Create button, one per VIP, owner controls, delete after 60 s empty, startup cleanup.

## Phase 9 — Hardening + handoff
- Failure handling from SPEC §13; permission/hierarchy errors reported clearly.
- Data pruning (activity older than 60 days).
- **Backup restore drill** done once and documented.
- `README.md`: setup, Railway deploy, environment variables, every admin command.
- Move from test server to the real server: `/setup run`, check role order, watch the first reshuffle.
