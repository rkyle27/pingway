# Privacy Policy for Pingway

**Effective date: November 4, 2026** (replaces the version of November 1, 2026)

This policy explains what the Pingway Discord bot and the Pingway website (https://pingway.app) collect, why, who it is shared with, and how to delete it. Pingway is a personal fan project run by one developer (River Zola) in Japan.

## 1. What we collect

**Discord identifiers** — your Discord user ID, and the IDs of servers, channels and roles where you use Pingway. We do not collect your password or payment card details. We do not store your email address; for Ko-fi supporters only a hashed (scrambled) form of it is used to match payments (see *Points & Supporter Perks* in section 1a).

**Settings and data you create with Pingway**, only when you use the feature:
| Feature | What is stored |
|---|---|
| `/datacenter`, `/marketalert` | Your chosen Data Centers; whether price alert DMs are on |
| `/status` | The world you track; whether status DMs are on |
| `/ignconfig`, `/ign` | Your Lodestone character ID, main job, image links, Tomestone and FFLogs links |
| `/firmament` | Your Skyrise Celebration timer and DM setting |
| `/todo`, reminders | Task names, reminder text and times |
| AI assistant | Notes/facts you ask Pingway to remember (see section 3) |
| `/pf`, `/poll` | Listings, poll questions, answers and votes |
| `/sciondex` | Your game progress (party, shards, stars) |
| Server settings (admins) | Channel and role choices, release event, Google Sheet IDs for `/raid` and `/logger` |

Newer features (Retainer Watch, Supporter Perks, Pingway Trivia, Honeypot, Tickets and more) are explained one by one in section 1a.

**Command usage** — the bot's console log records which command was used, by which user ID, and in which server, to fix bugs. These logs are not shared.

## 1a. Features in detail

### Retainer Watch (website → Retainers)
- **What is stored:** your Discord user ID, the retainers you add (world, retainer name, and one item it sells), the listing prices Pingway tracks for them, and the alert state (what you were already told about).
- **Why:** to DM you when someone undercuts your retainer's listing.
- **Your choice:** remove a retainer at any time on the Retainers page; its data goes with it.

### Points & Supporter Perks
- **Ko-fi payments** are matched to your Discord account by a **hashed email** (a scrambled form that can't be turned back into your email) or by a **claim code**.
- **What is stored:** your point lots (amount, where they came from — Ko-fi, top.gg, discordbotlist.com, discordlist.gg or other Pingway rewards — and their expiry, 180 days), and your Supporter Perks state and dates.
- **Payments are handled by Ko-fi.** Pingway never sees your card or payment details.

### Vote rewards (top.gg, discordbotlist.com and discordlist.gg)
- **What is stored:** the vote ID, your Discord user ID, the points you got, the time of the vote, and whether the thank-you DM was sent.
- For discordbotlist.com and discordlist.gg votes, Pingway also keeps the time of your last vote there, so a vote is only counted once per 12 hours.

### Market tools (Supporter Perk: `/bestsellers`, `/buysell`, website market tools)
- **What is stored:** your market tool settings (world, filters, sort), saved to your account so they are the same on the website and in Discord.
- Market data comes from **Universalis**; item data comes from **XIVAPI**.
- Pingway also keeps a **shared table of popular items per region**. It contains no personal data.

### Market alerts in a server channel
- **What is stored:** which servers and channels you picked to receive your market alerts.

### DM status
- If Pingway can't DM you (DMs closed, or no shared server), it remembers your user ID, the reason and when to try again, so your alerts pause instead of failing over and over. The website shows a warning and an "I fixed it" button that clears it.

### Honeypot (server admins)
- A "do not chat here" channel that removes hacked accounts posting spam.
- **For each caught account, Pingway stores:** user ID, username, display name, server nickname, the channel, the result, whether a DM was sent to them, and the time.
- This log is **visible to that server's staff** on the website, and the **server owner gets a DM report**.
- Caught-account entries are **deleted automatically after 90 days**.

### Tickets (server admins)
- Pingway stores the server's ticket channels and settings.
- **For each ticket, Pingway stores:** the ticket number and channel, who opened, claimed and closed it (user IDs), the request text (up to 500 characters) and the times. Closed tickets are **deleted automatically 180 days after closing**.
- **Transcripts:** if the server turns them on, the transcript is posted as a file in the **server's own ticket-logs channel** on Discord when the ticket is closed. **Pingway does not keep a copy.** It stays in that channel for as long as the server keeps it, and the server's admins can delete it at any time.

### Reaction Roles (server admins)
- **What is stored per server:** the message, channel and emoji → role settings.
- For extra messages above the free limit: which admin's Supporter Perks keep them running (that admin's user ID).

### FFXIV News (server admins)
- **What is stored per server:** the news channel, language/region and topics chosen. No personal data.

### Raid & Logger sheets (server admins)
- **What is stored per server:** sheet names, Google Sheet IDs, the role that can see each sheet, whether it is on or off, which admin created a sheet, and whose Supporter Perks keep it on.
- **Sheets Pingway creates** are owned by a Google account run by Pingway and are shared as **"anyone with the link can edit"**. Pingway's own service account is added as an editor so it can read raid schedules and write logs.
- **Logger sheets record** who used which command, when and where: user tag, user ID, server, channel, command and options.
- **Removing a sheet Pingway made deletes it.**

### AI Assistant (server admins)
- One AI channel per server. Only that setting is stored (see section 3a for how AI is used).

### Bot status
- The bot saves a heartbeat (the time, and whether maintenance is on) so the website can show its status pill. No personal data.

### Pingway Trivia (`/trivia`)
- **About you:** your Discord user ID, display name and avatar (updated each time you play, used only for leaderboards); your bits (all time and this month), streak, last solve day, and whether you chose to hide from leaderboards.
- **Each day's games** (status, number of wrong guesses, hints used, letters shown, bits, the server where you started, whether you shared) are **deleted after 100 days**.
- **Per server**, Pingway remembers who played there (to build that server's leaderboard) and the share channel an admin picked.
- **Your typed guesses are never stored.**
- **Leaderboards** show only name, avatar, bits and streak, and only to logged-in members of that server. Hide yourself in **My Settings → Pingway Trivia**.
- Word data comes from **XIVAPI**.

## 2. Why we use it
Only to run Pingway's features (reminders, alerts, settings, games), to keep it working, and to prevent abuse. We do not sell, rent or trade your data, we do not show ads, and we do not build profiles of you.

## 3. Who we share it with (service providers)
Pingway needs these services to work. They only receive what the feature needs:
- **Cybrancee** — hosts the bot and its database.
- **Vercel** — hosts the website.
- **OpenRouter → Google (Gemini AI model)** — **only** used for the AI assistant, see section 3a below.
- **Google Sheets / Google Drive** — only if a server admin sets up Raid or Logger sheets: who used which command and when is written to **that server's Logger sheet**, and `/raid` reads the server's Raid sheets. Sheets Pingway creates are kept in a Google account run by Pingway (see section 1a).
- **Ko-fi** — handles Supporter Perks payments. Pingway only receives what is needed to give you your points and perks (see section 1a), never card details.
- **top.gg** — tells Pingway when you vote, so you get your vote reward points.
- **discordbotlist.com** — tells Pingway when you vote (your Discord user ID and username), so you get your vote reward points.
- **discordlist.gg** — tells Pingway when you vote (in a signed message with your Discord user ID), so you get your vote reward points.
- **Universalis, XIVAPI, xivup, The Lodestone, Lodestone News API (lodestonenews.com)** — Pingway looks up item prices, item and trivia word data, world status, Lodestone character pages and FFXIV news. Only item names/IDs, Data Centers or your Lodestone character ID are sent — never your Discord data.

We may also disclose data if required by law.

## 3a. When AI is used (and when it is not)
- AI is used **only** for normal chat messages in a channel where a server admin turned on the AI assistant with **`/ailistenhere`**.
- AI is **never** used for slash commands (`/price`, `/status`, `/todo`, `/pf`, `/ign` and all others), buttons, menus, DMs, the website, market alerts, or messages in any other channel.
- In an AI channel, only what is needed for **your own** reply is sent to OpenRouter, which passes it to Google's Gemini model: your message, your display name, and **your own** AI notes and active reminders (so the AI can answer questions like "what are my reminders?").
- **Pingway's database is never shared with any AI company.** No other users' data, server settings or anything else from the database is ever sent to the AI.
- The short conversation memory (your last 15 messages) is kept **only in memory**, never in the database, and is cleared when the bot restarts or when you say "release recollection".
- Please don't share sensitive personal information with the AI.

## 4. The website
- **Login with Discord** asks Discord for your username, avatar, and the list of servers you are in (with your permissions), so it can show the servers you can manage. **Your server list is not saved.**
- After login, the site keeps one **encrypted, secure cookie** for up to 7 days so you stay logged in. Logging out deletes it and cancels the login with Discord.
- Your **light/dark theme choice** is saved only in your own browser.
- No analytics, tracking or advertising cookies are used.

## 5. How long we keep it
- Settings and game data: until you delete them or ask us to.
- Reminders: deleted after they are sent (repeating reminders stay until removed).
- Pingway Trivia daily games: deleted after 100 days.
- Points: each point lot expires 180 days after it was given.
- Honeypot catches: deleted after 90 days.
- Tickets: closed tickets are deleted 180 days after closing. Transcripts are not kept by Pingway (they are only in the server's own ticket-logs channel).
- AI chat memory: memory only, cleared on restart or "release recollection".
- If Pingway is removed from a server, that server's settings may be deleted. Personal settings are kept until you ask for deletion, because they are used in every server.

## 6. Your choices and deleting your data
- Change or turn off most settings yourself with the slash commands or at https://pingway.app.
- AI: say "release recollection", "clear all my reminders", or ask Pingway to forget a note.
- Retainer Watch: remove a retainer at any time on the website's Retainers page.
- Pingway Trivia: hide yourself from leaderboards in **My Settings → Pingway Trivia**.
- Server admins: removing a Raid or Logger sheet that Pingway made deletes the sheet.
- To delete **all** your data, contact the developer in the [support server](https://discord.gg/DDdV48X4G2). We will delete it within 30 days.

## 7. Security
- Secrets (bot token, database password, API keys) are kept out of the code and stored only in private settings on the hosts.
- **Website:** "Login with Discord" uses Discord's official login with forgery protection; your login is kept in an encrypted, secure cookie that the page itself cannot read; every change is re-checked with Discord against your real permissions (Manage Server, and Manage Roles for the release role); protection against cross-site attacks, script injection and framing; rate limits; only safe roles can be handed out by the bot; and a logged-out or stolen login stops working.
- **Database:** every query is protected against injection; users can only ever read or change their own personal settings.
- The source code is public so anyone can check it. No system is perfectly secure; if you find a problem, see SECURITY.md.

## 8. Where data is processed
The developer is in Japan. Data is processed by the services above, which may store it outside your country (for example in Japan or the United States).

## 9. Children
Pingway is for Discord users only. Discord requires users to be at least 13 (or older where local law requires).

## 10. Changes
We may update this policy. Important changes will be announced in the support server and on GitHub. The effective date above shows the latest version.

## 11. Contact
River Zola — through the [Pingway support server](https://discord.gg/DDdV48X4G2) on Discord.
