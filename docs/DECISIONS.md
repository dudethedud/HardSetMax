# Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-10-22 | Levels stay with bleed; this bot only does activity tracking + VIP | Avoid duplicate level systems |
| 2026-10-22 | 10 VIP slots, 7-day window, daily reshuffle | Carson's choice |
| 2026-10-22 | Swap announcements combined in one message, ping new VIPs only | Carson's format; avoids publicly pinging people who dropped out |
| 2026-10-22 | Crown custom role uses a lounge button + modal, not a slash command | Keeps the "no public commands" rule and gives a proper input form |
| 2026-10-22 | Postgres on Railway (separate service) instead of SQLite in the container | Container disk is wiped on redeploy; a separate DB service survives redeploys and has built-in backups |
| 2026-10-22 | TypeScript + discord.js v14 + Prisma | Matches the EDSA project stack |
