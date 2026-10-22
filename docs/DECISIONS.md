# Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-10-22 | Levels stay with bleed; this bot only does activity tracking + VIP | Avoid duplicate level systems |
| 2026-10-22 | 10 VIP slots, 7-day window, daily reshuffle | Carson's choice |
| 2026-10-22 | Swap announcements combined in one message, ping new VIPs only | Carson's format; avoids publicly pinging people who dropped out |
| 2026-10-22 | Crown custom role uses a lounge button + modal, not a slash command | Keeps the "no public commands" rule and gives a proper input form |
| 2026-10-22 | Postgres on Railway (separate service) instead of SQLite in the container | Container disk is wiped on redeploy; a separate DB service survives redeploys and has built-in backups |
| 2026-10-22 | TypeScript + discord.js v14 + Prisma | Matches the EDSA project stack |
| 2026-10-22 | VIP polls: 1 per VIP per day, channel locks for that VIP right after their poll, bot pings the Polls role | Carson's rule; locking immediately prevents a second poll instead of punishing after; VIPs can't spam the ping |
| 2026-10-22 | Server-wide cap of 2 polls/day (first come, first served); channel locks for the whole VIP role once hit | 10 VIPs × 1 poll each would mean up to 10 pings a day; Carson chose a server cap |
| 2026-10-22 | Crown always goes to a current VIP (top scorer of the new VIP list) | Avoids a Crown holder without VIP perks |
| 2026-10-22 | Poll discussion happens in a bot-created thread on each poll; everyone can chat in threads only | Keeps #polls clean while letting people discuss |
| 2026-10-22 | Staff can post polls with no limits; their polls get the ping and thread and don't use the VIP cap | Carson's choice |
| 2026-10-22 | Losing VIP is immediate and complete (colour, Crown, custom role, temp voice) through one shared routine; the slot refills at the next reshuffle | Mid-day removals shouldn't leave people with VIP perks until midnight |
| 2026-10-22 | Single-instance lock before connecting to Discord | Railway redeploys can overlap; two connected copies would double-count activity and double-answer buttons |
| 2026-10-22 | One "server-day" boundary (default 00:00 local, DST-aware) used by everything | The old 00:00 day vs 00:05 reset mismatch could unlock polls wrongly |
| 2026-10-22 | Spam filter (repeats, low effort, bursts) + 60 s cooldown instead of a daily message cap | Carson's choice: filter spam, don't cap genuine chatting |
| 2026-10-22 | Voice capped at 240 counted minutes per day | Stops overnight voice farming |
| 2026-10-22 | Threads use their parent channel's weight | Threads are separate channels in Discord and would otherwise dodge ignored channels |
| 2026-10-22 | Pinned time doesn't count toward history badges | Badges should be earned, not given by a pin |
| 2026-10-22 | Bot keeps its own timeout history + audit-log catch-up on startup | Discord only exposes active timeouts |
| 2026-10-22 | `/polls unlock` works even past the daily cap | Otherwise the command does nothing once the cap is hit |
| 2026-10-22 | Fixed tie-breaker order ending in Discord user ID | Preview and real reshuffle must always agree |
