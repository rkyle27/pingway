# Privacy Policy for Pingway

**Effective date: November 1, 2026** (replaces the version of July 26, 2026)

This policy explains what the Pingway Discord bot and the Pingway website (https://pingway.vercel.app) collect, why, who it is shared with, and how to delete it. Pingway is a personal fan project run by one developer (River Zola) in Japan.

## 1. What we collect

**Discord identifiers** — your Discord user ID, and the IDs of servers, channels and roles where you use Pingway. We do not collect your email address, password or payment details.

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

**Command usage** — the bot's console log records which command was used, by which user ID, and in which server, to fix bugs. These logs are not shared.

## 2. Why we use it
Only to run Pingway's features (reminders, alerts, settings, games), to keep it working, and to prevent abuse. We do not sell, rent or trade your data, we do not show ads, and we do not build profiles of you.

## 3. Who we share it with (service providers)
Pingway needs these services to work. They only receive what the feature needs:
- **Cybrancee** — hosts the bot and its database.
- **Vercel** — hosts the website.
- **OpenRouter → Google (Gemini AI model)** — **only** used for the AI assistant, see section 3a below.
- **Google Sheets** — only if a server admin sets up `/logger`: who used which command and when is written to **that server's own Google Sheet**. `/raid` only reads the sheet the admins chose.
- **Universalis, XIVAPI, xivup, The Lodestone** — Pingway looks up item prices, item names, world status and Lodestone character pages. Only item names/IDs, Data Centers or your Lodestone character ID are sent — never your Discord data.

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
- AI chat memory: memory only, cleared on restart or "release recollection".
- If Pingway is removed from a server, that server's settings may be deleted. Personal settings are kept until you ask for deletion, because they are used in every server.

## 6. Your choices and deleting your data
- Change or turn off most settings yourself with the slash commands or at https://pingway.vercel.app.
- AI: say "release recollection", "clear all my reminders", or ask Pingway to forget a note.
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
