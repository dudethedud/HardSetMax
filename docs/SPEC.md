# Colour menu bot: spec

A Discord bot for one server. Members who **rep the server** (wear its server tag or put `.gg/femboii` in their status) can pick a colour role from menus in a channel such as #colour-yourself. When someone stops repping, the bot takes their colour off.

Other bots already give reppers a role. This bot never looks at tags or statuses itself: it watches those **unlock roles**.

## 1. Menus
- A menu is one message, laid out like this:
  - a **banner image** (optional), then a box with
  - a heading: emoji (optional) + underlined title, e.g. "🫐 __Pinks/Magentas__"
  - the colour roles, listed as role mentions (shown in their colours; nobody is pinged)
  - "╰ Max Selection: **1**"
  - a **Make a selection** dropdown with one option per colour and **Remove colour**.
- Colours are **existing roles**. The bot never creates, renames or recolours roles.
- A role can be in only one menu. A menu holds at most 24 colours (a dropdown holds 25 options, one is Remove colour).
- Refused as colours: @everyone, bot-managed roles, roles above the bot's highest role, roles with moderator/admin permissions (a menu would hand them to anyone), and unlock roles.
- Menus have a position (order in the channel). Banners are stored in the database (Discord's attachment links expire); PNG, JPG, GIF or WebP up to 8 MB, downloaded only from Discord's CDN and checked by their first bytes.

## 2. Picking
- Only **reppers** (members with at least one unlock role) can pick. Others get a private note: rep the server to unlock colours.
- **One colour across all menus:** picking removes every menu colour the member has and gives the new one, in one Discord request.
- **Remove colour** takes the member's menu colours off.
- Replies are private. The dropdown resets after each pick.

## 3. Losing repper
- When a member loses their **last** unlock role, the bot removes their menu colours immediately (member update event).
- At startup and every hour, the bot checks every member (in case an event was missed, e.g. while offline).
- Removing an unlock role from the config runs the same check.
- If no unlock roles are configured, nobody is stripped.
- Each removal is posted to the log channel, if one is set, as an embed: member, colour removed, reason, and whether the DM got through (no pings).
- The member gets a DM: which colour was removed, that it's because they stopped repping the server (server tag or `.gg/femboii` in status), and where to pick again (the channel the menus are posted in). Closed DMs are skipped quietly. In a sweep, removals that send a DM are 3 seconds apart, so a catch-up after downtime isn't a burst of DMs.
- Taking a role out of a menu, or deleting a menu, does **not** remove it from people wearing it.

## 4. Commands
All under `/colours`, guild-only, hidden from everyone without Administrator (`default_member_permissions`), and re-checked at runtime (Administrator or the owner).

| Command | What it does |
|---|---|
| `/colours menu create title [emoji] [banner]` | New menu, added last |
| `/colours menu edit menu [title] [emoji] [banner] [remove-banner] [position]` | Change a menu; its posted message updates. `emoji:none` removes the emoji |
| `/colours menu delete menu` | Delete a menu and its message |
| `/colours menu add-role menu role` | Add an existing colour role |
| `/colours menu remove-role role` | Take a role out of its menu |
| `/colours menu list` | Menus, their colours and where they're posted |
| `/colours unlock-role add\|remove\|list [role]` | Roles that make someone a repper |
| `/colours post channel [fresh]` | Post or update every menu in order; `fresh` deletes and reposts them |
| `/colours log-channel [channel]` | Where removals are logged; empty turns it off |

The `menu` option autocompletes menu titles (for admins only).

## 5. Data
Postgres via Prisma. Tables: `Settings` (log channel), `UnlockRole`, `ColourMenu` (title, emoji, banner bytes, position, posted message), `MenuColour` (role, menu, position). Member colour choices are **not** stored: Discord's roles are the record of who wears what. No message content is stored.

## 6. Running
- Only one copy connects to Discord at a time (`gateway-leader` Postgres advisory lock).
- Intents: Guilds and **Server Members** (privileged). The bot needs **Manage Roles** and its role above every colour role.
- Dropdowns use fixed custom IDs (`colours:menu:<id>`) handled by one global handler, so they work after restarts.
- Commands are registered to `GUILD_ID` on startup. Config comes from environment variables validated with zod (`.env.example`).
