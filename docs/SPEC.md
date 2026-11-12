# Colour menu bot: spec

A Discord bot for one server. Colour menus for reppers (§1–6) and a donation panel (§7).

Members who **rep the server** (wear its server tag or put `.gg/femboii` in their status) can pick a colour role from menus in a channel such as #colour-yourself. When someone stops repping, the bot takes their colour off.

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
| `/colours log-channel [channel]` | Where removals and donations are logged; empty turns it off |
| `/donations setup\|goal\|donor-role\|add\|remove\|list\|reset` | The donation panel (§7) |

The `menu` option autocompletes menu titles (for admins only).

## 5. Data
Postgres via Prisma. Tables: `Settings` (log channel), `UnlockRole`, `ColourMenu` (title, emoji, banner bytes, position, posted message), `MenuColour` (role, menu, position). Member colour choices are **not** stored: Discord's roles are the record of who wears what. No message content is stored.

## 6. Running
- Only one copy connects to Discord at a time (`gateway-leader` Postgres advisory lock).
- Intents: Guilds and **Server Members** (privileged). The bot needs **Manage Roles** and its role above every colour role.
- Dropdowns use fixed custom IDs (`colours:menu:<id>`) handled by one global handler, so they work after restarts.
- Commands are registered to `GUILD_ID` on startup. Config comes from environment variables validated with zod (`.env.example`).

## 7. Donations (Ko-fi)
The bot never takes payments: donors pay on the server's Ko-fi page, and Ko-fi tells the bot.

- **Panel** (`/donations setup channel kofi-url`): a box with the fund name (default "Giveaway fund"), the total raised this round, or "raised of goal" with a progress bar when a goal is set, the top 5 donors, the 5 most recent donations, and a **💖 Donate** button. It updates after every donation.
- **Look:** soft blue box in the server's style (lowercase, ✧˚₊ sparkles), using the server's own emojis by name: `animBlueHeart` (title, button, thank-you), `topbracket`/`bottombracket` (total), `sparkle1`, `blue_bow` (top donors), `blue_1`–`blue_5` (places), `blueAnimButterfly` (recent), `blue_arrow`, `animBlueStar`. If one is renamed or deleted, a standard emoji is shown instead (`{name|fallback}` in `core/emojiText.ts`).
- **Donate button:** privately gives the member their **donation code** (like `SH-7K2F`, the same one every time) and a link to the Ko-fi page. Pasting the code into the Ko-fi message links the donation to their Discord account.
- **Ko-fi webhook:** Ko-fi POSTs form data (`data` = JSON) to `POST /kofi` on the bot's port. The request must carry the server's **verification token** (`KOFI_VERIFICATION_TOKEN`), checked in constant time; otherwise 401 and nothing is saved. Only `Donation` and `Subscription` notifications count (shop orders and commissions are ignored with 200). Each donation is saved once, keyed by Ko-fi's `message_id`, so a resend is a no-op. If saving fails the bot answers 500 so Ko-fi retries.
- **After a donation:** a thank-you in the panel's channel ("💖 @member donated **$5.00** to the **Giveaway fund**!"), pinging only the donor; the **Donor role** (`/donations donor-role`) for donations linked to a member; the panel updates; an embed goes to the log channel (source, Ko-fi name, donor role result).
- **Privacy:** a donation marked private on Ko-fi shows as "Someone"/"Anonymous", isn't linked to a member, and its Ko-fi name isn't shown. Donor emails and Ko-fi messages are never stored or shown.
- **Rounds:** `/donations reset` starts a new round: the panel's total and top donors start from $0, and older donations stay in the database.
- **Staff fixes:** `/donations add user amount` (e.g. a donation made outside Ko-fi), `/donations remove number`, `/donations list` (this round, with numbers), `/donations goal [name] [amount]` (amount 0 = no goal).
- The endpoint only opens when `KOFI_VERIFICATION_TOKEN` and a port (`WEBHOOK_PORT`, or the host's `SERVER_PORT`) are set. It serves only `POST /kofi` and a `GET /` health check, caps bodies at 64 KB and times out slow requests.
