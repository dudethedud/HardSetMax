# Colour menu bot

Colour role menus for server reppers. Members who wear the server tag or have `.gg/femboii` in their status (other bots give them a role for it) pick **one** colour from menus in #tag-donor-colours. When they stop repping, the bot takes the colour off.

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

**Donations:** a 💖 Donate panel backed by Ko-fi: public thank-yous, a total (and optional goal), top donors, and a Donor role. Admin commands: `/donations setup|goal|donor-role|add|remove|list|reset`.

**Christmas invite event:** every verified invite (the friend has the level 3 role) is a raffle entry, and invites count the moment someone joins. Members use `/invites`, `/leaderboard` and `/invite-link` (their own permanent link); staff with Manage Server use `/invite-event review|disqualify|reinstate|set-status|raffle-export|freeze`. One live leaderboard message in the leaderboard channel updates itself as invites count. Rules: [`docs/SPEC.md` §8](docs/SPEC.md).

### Setting up the invite event
1. **Developer Portal → your app → Bot → Privileged Gateway Intents:** turn on **Server Members Intent** (already needed for colours). The bot also uses the **Guild Invites** intent, which isn't privileged, so there's nothing to switch on for it.
2. **Permissions:** give the bot's role **Manage Server** (Discord only shows invite use counts to it) and **Create Invite** in the channel for personal links. Without Manage Server the event turns itself off and says so in the staff log.
3. **Config** (Wispbyte → Startup / the `.env` file):

   | Name | What | Default |
   |---|---|---|
   | `LEADERBOARD_CHANNEL_ID` | Where the live leaderboard message goes; the bot posts it once and keeps editing it (required to turn the event on) | – |
   | `LEVEL3_ROLE_ID` | The level 3 role an invitee needs (required to turn the event on) | – |
   | `INVITE_EVENT_END` | End time, Edmonton | `2026-12-25T12:00` |
   | `STAFF_LOG_CHANNEL_ID` | Alt flags and staff changes | the `/colours` log channel |
   | `INVITE_LINK_CHANNEL_ID` | Channel personal invite links point to | the leaderboard channel |
   | `EMBED_COLOR` | Embed colour | `#a8d8f0` |

   Copy a channel or role ID with Developer Mode on (User Settings → Advanced), then right-click → Copy ID.
4. Restart the bot. The event **starts at that moment**: it saves who's already in the server (they can't count as invites) and the start date. Invites from before can't be tracked.

**Check-in DMs:** once a day, members who've been quiet for a week get a friendly DM about the server's next scheduled event (at most 20 a day, 5–10 minutes apart, once per 14 days, and only one until they talk again). They can stop them with the DM's button or `/checkins off`. Needs a scheduled event in the server to send anything; `CHECKIN_DMS=off` turns it off. Rules: [`docs/SPEC.md` §9](docs/SPEC.md).

Setup and running: [`docs/OPERATIONS.md`](docs/OPERATIONS.md). The host runs the **`deploy` branch**, which GitHub builds from `main` on every merge (no install or build on the host). Full rules: [`docs/SPEC.md`](docs/SPEC.md).

## Development
`npm install --include=dev` (plain `npm install` skips the dev tools, to keep the server install small), then `npm run dev`. Checks: `npm run typecheck`, `npm run lint`, `npm test` (database tests need `TEST_DATABASE_URL`).
