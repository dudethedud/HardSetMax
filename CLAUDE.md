# CLAUDE.md: colour menu bot

Discord bot for one server: reppers (members with an unlock role, given by other bots for the server tag or `.gg/femboii` in status) pick one colour role from menus; when they lose their last unlock role, the bot takes it off. Full requirements: `docs/SPEC.md`. Record choices in `docs/DECISIONS.md`. Running it: `docs/OPERATIONS.md`.

## How to work in this repo
1. **Read `docs/SPEC.md` before anything else.**
2. **Plan first; don't write code until the owner approves the plan.**
3. **Audit before building:** say what you'll reuse, change or remove.
4. **Actually run things:** typecheck, lint and tests after changes. Don't say something works without running it.
5. If the spec is unclear, **ask** rather than guessing, and note the answer in `docs/DECISIONS.md`.

## Non-negotiable rules
- **Commands are admin-only:** guild-only (`setContexts(Guild)`), `default_member_permissions` Administrator via `defineCommand`, plus a runtime check (`src/core/access.ts`). Members only use the menu dropdowns.
- **The bot never creates, edits or deletes roles.** It only gives and takes the colour roles admins put in menus. Roles with moderator/admin permissions can never be colours.
- **Never store message content.**
- **Only one copy of the bot connects to Discord at a time** (`gateway-leader` advisory lock).
- **Dropdowns use fixed IDs and a global handler**, so they work after restarts. Defer before slow work.
- **No state on local disk.** Everything persistent goes in Postgres via Prisma.
- **Migrations must not destroy data.** `prisma migrate dev` locally, `prisma migrate deploy` in production. Never `migrate reset` or `db push`, and never drop data without a written plan the owner approved.
- **Discord's roles are the record of who wears what;** the database holds the menus and settings.
- **Keep the rules pure** in `src/core/` (no Discord or DB imports) and unit-test them.
- Never commit secrets. Config comes from environment variables validated with zod.

## Stack
TypeScript (strict), Node 22+, discord.js v14, Prisma + PostgreSQL (Supabase), Vitest, pino, zod. Bot on Wispbyte (restart pulls `main`).

## Layout
```
src/
  core/        pure rules + tests (colours, access, banner checks)
  discord/     client, commands/, interactions
  services/    colour menus, banner download, gateway-leader, shutdown
  db/          prisma client, connection
  config/      env
prisma/        schema.prisma, migrations/
docs/          SPEC.md, PHASES.md, DECISIONS.md, OPERATIONS.md
```

## Scripts
`dev`, `build`, `start` (runs `prisma migrate deploy` then the bot), `typecheck`, `lint`, `test`, `register-commands`.
