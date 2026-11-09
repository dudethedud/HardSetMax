# Colour menu bot

Colour role menus for server reppers. Members who wear the server tag or have `.gg/femboii` in their status (other bots give them a role for it) pick **one** colour from menus in #colour-yourself. When they stop repping, the bot takes the colour off.

- Menus look like: banner image → emoji + underlined heading → the colour roles → "╰ Max Selection: **1**" → a **Make a selection** dropdown.
- One colour across all menus: picking a new one swaps it. "Remove colour" takes it off.
- Non-reppers get a private note telling them how to unlock colours.
- Colours come off as soon as someone loses their last repper role, and the bot double-checks everyone at startup and every hour.

## Admin commands
| Command | What it does |
|---|---|
| `/colours unlock-role add role` | A role that counts as repping (add each one your other bots give) |
| `/colours menu create title [emoji] [banner]` | Make a menu, e.g. Pinks/Magentas |
| `/colours menu add-role menu role` | Put an existing colour role in a menu |
| `/colours menu edit` · `delete` · `remove-role` · `list` | Change menus |
| `/colours post channel [fresh]` | Post or update all menus, in order |
| `/colours log-channel [channel]` | Log colours the bot takes off |

Setup and running: [`docs/OPERATIONS.md`](docs/OPERATIONS.md). Full rules: [`docs/SPEC.md`](docs/SPEC.md).

## Development
`npm install --include=dev` (plain `npm install` skips the dev tools, to keep the server install small), then `npm run dev`. Checks: `npm run typecheck`, `npm run lint`, `npm test` (database tests need `TEST_DATABASE_URL`).
