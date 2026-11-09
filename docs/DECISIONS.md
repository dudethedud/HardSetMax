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
