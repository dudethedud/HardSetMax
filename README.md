# VIP Bot (Puppyboy Carter)

A Discord bot that tracks member activity and runs a rotating VIP system for one server:
- **VIP:** 10 slots for the most active members of the last 7 days, updated every night.
- **Crown:** a weekly Crown with a custom role for the top VIP.
- **VIP perks:** colours, polls, and temporary voice channels.
- **Badges:** permanent history badges for long-time VIPs.
- **Weekly recap** in the announcements channel.
- **AI chat** in main chat.

Every slash command is admin-only. Members use buttons, dropdowns and forms posted by the bot.

- **Setup, step by step:** [`docs/SETUP.md`](docs/SETUP.md)
- **Running it** (how things work, troubleshooting, backups): [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- **Full requirements:** [`docs/SPEC.md`](docs/SPEC.md) · **Build plan:** [`docs/PHASES.md`](docs/PHASES.md) · **Decisions:** [`docs/DECISIONS.md`](docs/DECISIONS.md)
- **Rules for Claude Code:** [`CLAUDE.md`](CLAUDE.md)

## How it's hosted
| Part | Where | Cost |
|---|---|---|
| The bot | A free **Wispbyte** Node.js server. Restarting it pulls `main` from GitHub, installs and builds | Free (log in every 2 weeks) |
| Database | A free **Supabase** Postgres project (session pooler, TLS verified) | Free |
| Backups | A nightly **GitHub Actions** job; encrypted, kept 30 days | Free |
| AI chat | **Groq** → **Cloudflare Workers AI** → pre-written replies | Free tiers |

Nothing important is stored on the bot's server: everything lives in Postgres, so restarts and reinstalls lose nothing.

## Environment variables (`.env` on the bot's server)
| Variable | Needed | What it is |
|---|---|---|
| `DISCORD_TOKEN` | yes | The bot's token (secret) |
| `DISCORD_CLIENT_ID` | yes | The application ID |
| `GUILD_ID` | yes | Your server's ID |
| `DATABASE_URL` | yes | Supabase session pooler string, ending in `?sslmode=require` (secret) |
| `DATABASE_CA_CERT` | for Supabase | Path to Supabase's SSL certificate, e.g. `certs/supabase-ca.crt` |
| `DATABASE_POOL_MAX` | no | Database connections (default 5) |
| `LOG_LEVEL` | no | `info` (default), `debug`, `warn`… |
| `GROQ_API_KEY` | for AI | Groq API key (secret) |
| `CLOUDFLARE_ACCOUNT_ID` | for AI | Cloudflare account ID (not secret) |
| `CLOUDFLARE_AI_TOKEN` | for AI | Cloudflare Workers AI API token (secret) |
| `CLOCK_OFFSET_MINUTES` | testing only | Shifts the reshuffle clock to test midnight. Leave unset in production |

GitHub (for backups): secrets `BACKUP_DATABASE_URL` and `SUPABASE_CA_CERT`, and variable `BACKUP_AGE_RECIPIENT` (see SETUP part 7).

## Admin commands
All are guild-only, need Administrator, and reply privately unless they post on purpose.

| Command | What it does |
|---|---|
| `/setup run` | Creates or repairs every role, channel and panel. Checks permissions and role order. Safe to run any time |
| `/bot health` | Version, uptime, database (or database-down mode), lock, intents, server-day, last reshuffle, unsaved writes, AI |
| `/config view` | Every setting, channel and role |
| `/config set key value` | Change a setting: timezone, day-boundary, window, cooldowns, voice, spam filter, slots, buffer, min-hold, inactivity-days, min-score, timeout-days, colours, polls-daily-cap, ai-per-user-limit |
| `/config channel purpose channel` | Announcements, mod-log, polls, or main-chat (AI) channel |
| `/config channel-weight channel weight` | How much a channel's messages count (0 ignores it) |
| `/config staff-roles add/remove/list` | Members with these roles can't be VIP |
| `/config level-roles-top role` | bleed's highest level role; VIP goes above it |
| `/config polls-role role` | Role pinged for new VIP polls |
| `/vip list` · `/vip preview` | Current VIPs · what a reshuffle would do now (plus ranks 11–15) |
| `/vip pin` · `/vip unpin` · `/vip remove [block_days]` · `/vip unblock` | Lock in, unlock, remove (and block), unblock |
| `/vip reshuffle-now` | Run a reshuffle now (with a confirm button) |
| `/vip colours list/add/edit/remove` | VIP colour options |
| `/vip badges list/set/remove` | History badge milestones |
| `/polls status` · `/polls unlock user` | Today's polls and locks · one more poll for a VIP today |
| `/crown view` · `/crown reset-role` · `/crown lock/unlock` · `/crown blocked-words add/remove/list` | Crown and custom role management |
| `/stats user` · `/leaderboard [count]` | A member's score, rank, breakdown, VIP history and badges · the top members |
| `/activity adjust user amount reason` | Manual score correction (logged) |
| `/ai status/toggle/test/providers/provider-cap/provider-toggle/provider-model` | AI chat controls |

## Development
- **Stack:** TypeScript (strict), Node 22, discord.js 14, Prisma 7 + PostgreSQL, Vitest, pino, zod.
- **Commands:**
  - `npm install` (also builds)
  - `npm run dev`
  - `npm run typecheck`, `npm run lint`, `npm test` (database tests need `TEST_DATABASE_URL` pointing at a separate migrated test database; see OPERATIONS)
  - `npm run build`, `npm start`
- **Layout:**
  - `src/core/`: pure logic, no Discord or database
  - `src/services/`: everything that talks to Discord and the database
  - `src/discord/`: commands, buttons, dropdowns, forms
  - `prisma/`: schema and migrations
  - `prompts/`: AI personality and VIP guide
  - `scripts/`: backup and restore
