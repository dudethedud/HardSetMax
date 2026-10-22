# CLAUDE.md — VIP Bot

Discord bot that tracks activity and runs a rotating VIP system. Full requirements: `docs/SPEC.md`. Build order: `docs/PHASES.md`. Record choices in `docs/DECISIONS.md`.

## How to work in this repo
1. **Read `docs/SPEC.md` and `docs/PHASES.md` before anything else.**
2. **Work one phase at a time.** Start each session by planning the current phase only. **Don't write code until Carson approves the plan.**
3. **Audit before building.** Before changing anything, look at what already exists in the repo and say what you'll reuse, change or remove.
4. **Actually run things.** Run typecheck, lint and tests yourself after changes. Don't say something works without running it.
5. If the spec is unclear or two parts conflict, **ask** rather than guessing. Note the answer in `docs/DECISIONS.md`.

## Non-negotiable rules
- **No public slash commands.** Every command: guild-only, `default_member_permissions = Administrator`, `dm_permission = false`, plus a runtime admin check in the handler. Members only use buttons, dropdowns and modals.
- **Never store message content.** Counts and timestamps only.
- **No state on local disk.** Everything persistent goes in Postgres via Prisma. The bot must survive a Railway redeploy with zero data loss (SPEC §11).
- **Migrations must not destroy data.** Use `prisma migrate dev` locally and `prisma migrate deploy` in production. Never use `migrate reset`, `db push`, or drop/rename columns holding data without a written data-preserving plan approved by Carson.
- **DB is the source of truth;** Discord roles are reconciled to match it.
- **Scheduled jobs are idempotent:** unique `(job, period)` in `job_runs` + Postgres advisory lock + catch-up on startup.
- **Keep the business logic pure** (scoring, reshuffle, pairing, crown, badges) in `src/core/` with no Discord or DB imports, and unit-test it.
- **Log every role change** to the mod-log with a reason.
- Never commit secrets. Config comes from environment variables validated with zod.

## Stack
TypeScript (strict), Node LTS, discord.js v14, Prisma + PostgreSQL, Vitest, pino, zod. Deployed on Railway (push to `main` deploys).

## Suggested layout
```
src/
  core/        pure logic + tests (scoring, reshuffle, pairing, crown, badges)
  discord/     client, commands/, interactions/ (buttons, selects, modals), panels
  services/    activity buffer, scheduler, role queue, reconciliation
  db/          prisma client, repositories
  config/      env + guild config
prisma/        schema.prisma, migrations/
docs/          SPEC.md, PHASES.md, DECISIONS.md, OPERATIONS.md
```

## Scripts (create in Phase 1)
`dev`, `build`, `start` (runs `prisma migrate deploy` then the bot), `typecheck`, `lint`, `test`, `register-commands`.
