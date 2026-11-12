# Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-11-08 | The VIP/Crown bot was deleted and replaced with a colour menu bot. All old code, docs and prompts were removed, and a migration drops every old table | Owner: "delete everything, we are making this bot simply for colour role menus". The old code stays in Git history |
| 2026-11-08 | Reppers are recognised by **unlock roles** that other bots already give (server tag, `.gg/femboii` in status); any one of them unlocks colours | Owner: tagging/status is "already handled by other bots to equip a role" |
| 2026-11-08 | Colours are existing roles; the bot never creates or edits roles | Owner picked "your existing roles" |
| 2026-11-08 | One colour across all menus: picking replaces any other menu colour | Owner's choice |
| 2026-11-08 | Layout copies the owner's example: banner, then a box with emoji + underlined heading, role mentions, "Max Selection: 1", and a "Make a selection" dropdown (components v2) | Owner's screenshot |
| 2026-11-08 | Colours come off when the last unlock role goes (member update), plus a sweep at startup and hourly. With no unlock roles configured, nobody is stripped | Events can be missed while offline; an empty config is a setup gap, not people who stopped repping |
| 2026-11-08 | Roles with moderator/admin permissions, bot-managed roles and roles above the bot can't be colours | A menu would hand those to anyone |
| 2026-11-08 | Banners are stored in the database, not as links | Discord attachment links expire |
| 2026-11-08 | Who wears which colour isn't stored; Discord's roles are the record | Nothing to drift out of sync |
| 2026-11-09 | Build on GitHub, not on the host: `.github/workflows/deploy.yml` tests and bundles the bot into one file (esbuild) and force-pushes it with the migration files to a `deploy` branch; Wispbyte runs the `deploy` branch with no `npm install` or build | Wispbyte's free plan blocked the server for "using too much CPU" during `npm install` and the TypeScript build |
| 2026-11-09 | The bot applies migrations itself (`src/db/migrate.ts`): Prisma's advisory lock, its `_prisma_migrations` table and sha256 checksums, one transaction per migration, a failed one blocks startup. Checked: Prisma reports the result as up to date with no drift | The Prisma CLI (~150 MB of packages) can't be on the server without `npm install` |
| 2026-11-10 | Members get a DM when the bot removes their colour for not repping (colour, reason, where to pick again). Closed DMs are skipped; sweep DMs are 3 s apart | Owner request |
| 2026-11-11 | Donations via Ko-fi's webhook (owner picked automatic over staff-confirmed): the bot never handles payments; a per-member code in the Ko-fi message links a donation to a Discord account; private donations stay anonymous; donor emails and messages are never stored; rounds via reset keep history; USD; fund "Giveaway fund" with no goal by default | Owner request; PayPal didn't suit them |
| 2026-11-11 | The bot listens on one HTTP port (`POST /kofi`, `GET /` health) only when the Ko-fi token is set; plain HTTP on the host's port, with a relay as the fallback if Ko-fi requires HTTPS | Wispbyte gives the server one public port; Ko-fi's docs couldn't be checked from the build environment |
| 2026-11-12 | Donor perks: the base Donor role plus tier roles set by `/donations tier`, by lifetime total; members wear only their highest tier. No donor-only colours (colours stay for reppers) and no extra giveaway entries for donors (paid chances to win count as a lottery in many places) | Owner request; owner kept colours separate |
