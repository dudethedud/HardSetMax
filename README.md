# VIP Bot (Puppyboy Carter)

A Discord bot that tracks member activity and runs a rotating VIP system for one server:
- **VIP:** 10 slots for the most active members of the last 7 days, updated every night.
- **Crown:** a weekly Crown for the top VIP: a custom role, a 👑 nickname, three titles to hand out, a weekly decree and a voice hall.
- **VIP perks:** colours, polls, temporary voice channels, a public VIP board, profile cards and daily shoutouts.
- **Badges:** permanent history badges for long-time VIPs.
- **Weekly recap** in the announcements channel.
- **AI chat** in main chat.

Slash commands are for staff, admins and the owner only. Members use buttons, dropdowns and forms posted by the bot.

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

## Commands
Five commands, all guild-only and replying privately unless they post on purpose. Not sure which one you need? Run `/bot help`. Colour names, badges, blocked words and AI providers are suggested as you type, and `/settings set` shows the current value. Who can use what is checked every time:
- **Staff:** a staff role (`/settings role action:add-staff`), Administrator, or the owner. Staff also need **Timeout Members** for Discord to show them the commands.
- **Admin:** Administrator, or the owner.
- **Owner:** the server owner only.

| Command | Who | What it does |
|---|---|---|
| `/stats [user] [count]` | staff | No user: the leaderboard. With a user: score, rank, 7-day breakdown, VIP history and badges |
| `/vip list` · `/vip preview` | staff | Current VIPs · what a reshuffle would do now (plus ranks 11–15) |
| `/vip polls` · `/vip crown` | staff | Today's polls and locks · the Crown, its custom role, decree and titles |
| `/vip pin` · `unpin` · `remove [block_days]` · `unblock` | admin | Lock in, unlock, remove (and block), unblock |
| `/vip reshuffle` | admin | Run a reshuffle now (with a confirm button) |
| `/vip adjust user amount reason` | admin | Manual score correction (logged) |
| `/vip poll-unlock user` | admin | One more poll for a VIP today |
| `/vip crown-give user` | admin | Give this week's Crown to a VIP now (for testing or fixing a mistake); the current holder loses it |
| `/vip crown-reset user` · `/vip crown-lock user locked` | admin | Delete a custom role · block or allow custom roles for someone |
| `/settings view` · `/settings set key value` | admin | Every setting · change one: timezone, day-boundary, window, cooldowns, voice, spam filter, slots, buffer, min-hold, inactivity-days, min-score, timeout-days, colours, polls-daily-cap, ai-per-user-limit |
| `/settings channel purpose channel` | admin | Announcements, mod-log, polls, main-chat (AI and shoutouts) or vip-board channel |
| `/settings channel-weight channel weight` | admin | How much a channel's messages count (0 ignores it) |
| `/settings role action [role]` | admin | `add-staff` / `remove-staff` / `list-staff`, `level-top` (bleed's highest level role; VIP goes above it), `polls` (role pinged for new polls), and `vip` / `crown` / `title-champion` / `title-advisor` / `title-jester` to use an existing role for that |
| `/settings colour action ...` | admin | VIP colour options: `list`, `add name hex [hex2]` (hex2 makes a gradient), `edit name [new_name] [hex] [hex2]`, `remove name`, `reset` (switch to the default VIP gradients) |
| `/settings badge action ...` | admin | History badges: `list`, `set weeks name`, `remove weeks` |
| `/settings blocked-word action [word]` | admin | Words custom roles, room names, shoutouts and decrees can't contain |
| `/bot help` | staff | Every command *you* can use, with a line on what each does |
| `/bot health` | staff | Version, uptime, database (or database-down mode), lock, intents, server-day, last reshuffle, unsaved writes, AI |
| `/bot setup` | admin | Creates or repairs every role, channel and panel. Checks permissions and role order. Safe to run any time |
| `/bot ai action [question]` | admin | AI chat: `status`, `on`, `off`, `providers`, `test` |
| `/bot ai-blacklist action [user]` | admin | Who Puppyboy Carter won't reply to: `add`, `remove`, `list`. People are added automatically after mean or NSFW messages (see below) |
| `/bot ai-provider provider setting [value]` | admin | Change a provider's daily `cap`, `model`, or `toggle` it |
| `/announce [channel]` | owner | Write an announcement, preview it, then the bot posts it with an @everyone ping |

**`/bot setup` reuses what's already there:** if a role or channel with the expected name exists (VIP, Polls, 👑 Crown, the titles, colours and badges; #vip-board, #polls, the VIP Lounge), it uses that instead of making a duplicate. Roles are only taken over if they have no permissions (except VIP). To use a role with a different name, bind it with `/settings role`.

**If setup can't work something out** (announcements, main chat, mod-log, the role VIP goes above, or a category for #polls or #vip-board), it shows menus under its report so you can pick it there, plus a **Run setup again** button.

**The mod-log** posts each entry as an embed, coloured by kind: green done, red removed, orange needs attention, pink Crown, gold VIP.

**Fitting into your server:** `/bot setup` fills in what isn't set yet and reports every guess (🔎 lines), so you can change any of them:
- bleed's top level role (the highest role named like "Level 50"), staff roles (roles with moderator permissions), and the main chat, announcements and mod-log channels (by name)
- the first time only: bot-command, spam and counting channels stop counting toward VIP
- where a channel denies image/embed/emoji perks to everyone, VIP gets them back there (on the category for synced channels)
- channels go in the right category: #vip-board with your info/announcements, #polls with your main chat, and a new VIP Lounge category right after your chat category. Bot channels that aren't in any category get moved in; anything you placed yourself stays put

**Fair from day one:** commands for other bots (`!rank`, `.work`, `-play`) don't count as chat, and the nightly reshuffle waits until there's a full week of activity before changing VIP (`/bot health` shows the warm-up). An admin can still run `/vip reshuffle` by hand.

**Colours:** Discord shows a name in its highest coloured role's colour, so VIP gold (or a picked VIP colour) covers a level role's colour. That's on purpose.

**AI blacklist:** if someone keeps being genuinely mean to Puppyboy Carter or asks for NSFW stuff, the AI flags the message. 2 flags in 24 hours (`/settings set ai-strike-limit`) and he stops replying to that person. Playful teasing doesn't count. The server owner is never flagged. Every block is posted in the mod-log, and `/bot ai-blacklist action:remove` undoes it.

## Member perks (buttons in the VIP lounge)
| Who | Perk |
|---|---|
| VIPs | Colour picker, VIP polls, own temporary voice channel, **🪪 My profile** (rank, score, where you stand, badges, weeks held), **📣 Shoutout** (once a day, posted in main chat by the bot, no pings), a spot on the public **#vip-board**, a ⭐ role icon at Boost Level 2, **🦴 a daily treat** to give anyone, **🎨 colour suggestions** (staff approve), **💎 Veteran** after 14 days in a row (second daily shoutout), and AI replies first when Carter is busy |
| The Crown | Everything above, plus: a custom role, a **👑 nickname** for the week, **🎖️ Titles** for anyone but staff and bots, reset weekly, each with a job: 🛡️ Champion gets a guest VIP pass (colours, shoutout, polls, VIP voice, the lounge), 📜 Advisor posts VIP polls and gets the daily shoutout, 🃏 Jester sets the bot's status and makes it do a trick in main chat (once a day each). Title holders find their buttons under **🎖️ Titles & perks** on #vip-board, one **📜 Decree** a week in announcements (no pings), and a **👑 Hall** voice channel with Priority Speaker and Move Members |

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
