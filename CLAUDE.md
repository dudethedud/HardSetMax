# CLAUDE.md: colour menu bot

Discord bot for one server: reppers (members with an unlock role, given by other bots for the server tag or `.gg/femboii` in status) pick one colour role from menus; when they lose their last unlock role, the bot takes it off. It also runs a Ko-fi donation panel (SPEC §7). Full requirements: `docs/SPEC.md`. Record choices in `docs/DECISIONS.md`. Running it: `docs/OPERATIONS.md`.

## How to work in this repo
1. **Read `docs/SPEC.md` before anything else.**
2. **Plan first; don't write code until the owner approves the plan.**
3. **Audit before building:** say what you'll reuse, change or remove.
4. **Actually run things:** typecheck, lint and tests after changes. Don't say something works without running it.
5. If the spec is unclear, **ask** rather than guessing, and note the answer in `docs/DECISIONS.md`.

## Non-negotiable rules
- **Commands are admin-only:** guild-only (`setContexts(Guild)`), `default_member_permissions` Administrator via `defineCommand`, plus a runtime check (`src/core/access.ts`). Members only use the menu dropdowns and the Donate button.
- **The bot never creates, edits or deletes roles.** It only gives and takes the colour roles admins put in menus. Roles with moderator/admin permissions can never be colours.
- **Never store message content.** For donations: never store donor emails or Ko-fi messages, and never handle payments (Ko-fi does).
- **Ko-fi webhooks are verified** with the verification token (constant-time) and saved once per Ko-fi `message_id`.
- **Only one copy of the bot connects to Discord at a time** (`gateway-leader` advisory lock).
- **Dropdowns use fixed IDs and a global handler**, so they work after restarts. Defer before slow work.
- **No state on local disk.** Everything persistent goes in Postgres via Prisma.
- **Migrations must not destroy data.** `prisma migrate dev` locally; in production the bot applies them itself on start (`src/db/migrate.ts`, same table and checksums as `prisma migrate deploy`). Never `migrate reset` or `db push`, and never drop data without a written plan the owner approved.
- **Discord's roles are the record of who wears what;** the database holds the menus and settings.
- **Keep the rules pure** in `src/core/` (no Discord or DB imports) and unit-test them.
- Never commit secrets. Config comes from environment variables validated with zod.

## Stack
TypeScript (strict), Node 22+, discord.js v14, Prisma + PostgreSQL (Supabase), Vitest, pino, zod, esbuild. Bot on Wispbyte, which runs the **`deploy` branch**: GitHub Actions tests and bundles every push to `main` into it. Never build or `npm install` on the host (its CPU limit blocks the server); never edit the `deploy` branch by hand.

## Layout
```
src/
  core/        pure rules + tests (colours, access, banner checks)
  discord/     client, commands/, interactions
  services/    colour menus, donations, Ko-fi webhook server, banner download, gateway-leader, shutdown
  db/          prisma client, connection, migrate (applies migrations without the Prisma CLI)
  deploy.ts    entry of the one-file bundle: migrate, then start
  cli/         register-commands
  config/      env
prisma/        schema.prisma, migrations/
docs/          SPEC.md, PHASES.md, DECISIONS.md, OPERATIONS.md
```

## Scripts
`dev`, `build`, `start` (from source: `prisma migrate deploy` then the bot), `bundle` (builds `deploy/`), `typecheck`, `lint`, `test`, `register-commands`. Local installs need `npm install --include=dev` (the repo `.npmrc` omits dev tools).
