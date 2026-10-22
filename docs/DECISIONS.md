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
