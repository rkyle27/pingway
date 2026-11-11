# Pingway

**Your FFXIV companion, right inside Discord.**
Pingway tracks reset timers, server status, market board deals, Party Finder listings and more — so your Free Company never misses a thing.

[**➕ Invite Pingway**](https://discord.com/oauth2/authorize?client_id=1530586586524418048) · [**🌐 Website & Dashboard**](https://pingway.app) · [**💬 Support Server**](https://discord.gg/DDdV48X4G2) · [**☕ Ko-fi**](https://ko-fi.com/riverzola)

---

## 🌐 New: manage Pingway in your browser!

Go to **[pingway.app](https://pingway.app)** and log in with Discord.

- **Server settings** (for anyone with *Manage Server*): notification channel, release event countdown, AI assistant channel, ScionDex channel, Raid & Logger sheets, Reaction Roles, Tickets, FFXIV News channels and the Honeypot.
- **Personal settings** (used in every server): your Data Centers, market price alerts, Retainer Watch, server status alerts, IGN character card, Firmament reminders and Pingway Trivia.
- **Supporter Perks & points:** see your points, vote rewards and perks.
- Invite Pingway to your servers in one click.
- Light and dark mode, works on phones too.

**Speaks your language:** Pingway answers in English, Français, Deutsch or 日本語 — your Discord app language by default, or the one you pick with `/pingway`. Messages everyone in a server sees use the server's language.

Everything you change on the website works right away in Discord — and you can still use the slash commands as before.

**Built secure:** official Discord login, encrypted logins, every change re-checked against your real Discord permissions, only safe roles can be handed out, and no secrets ever reach your browser.

---

## ✨ Features

### 💰 Market Board
- **`/price <item>`** — Cross-world market prices for any FFXIV item across your chosen Data Centers (top 5 NQ and HQ listings per Data Center, with world names).
- **`/datacenter`** — Choose your Data Centers once; used by `/price` and market alerts in every server.
- **`/marketalert`** — Turn on price drop DMs. Pingway watches the Universalis live feed and sends you a grouped DM (every minute by default — change the DM interval on the website) with listings that are **at least 80% below the usual price**:
  - Compared against the **median of the last 7 days of real sales** on that Data Center (troll sales can't fake the price).
  - Double-checked against the **next 3 cheapest listings from other sellers**, so it only alerts on real mistakes (a missing zero, a pasted wrong price) — not on items whose market just dropped.
  - NQ and HQ are checked separately. Results are sorted lowest price first and grouped by Data Center in an aligned table.

### 💜 Supporter Perks & Points
- **Supporter Perks** unlock extra market tools and higher limits (for example more Reaction Role messages and Raid & Logger sheets). Perks cost points; get points by supporting on [Ko-fi](https://ko-fi.com/riverzola) or by **voting for Pingway on [top.gg](https://top.gg/bot/1530586586524418048/vote) or [discordbotlist.com](https://discordbotlist.com/bots/pingway/upvote)** (vote rewards come with a thank-you DM).
- **`/bestsellers`** — Top selling items on your world or Data Center.
- **`/buysell`** — Popular items that are cheaper on another world than on yours.
- **`/retainers`** — Your watched retainers and their undercut items. Add retainers on the website (**Retainer Watch**) and Pingway DMs you when someone undercuts them.

### 🌍 Server Status
- **`/status`** — Live status of every world in a Data Center. Pick a world to track and get a **DM when it goes down for maintenance or comes back up**. New users start with alerts off.

### ⏰ Timers, Reminders & To-Do
- **`/timer`** — Countdowns for daily and weekly resets and the housing lottery, plus a **release event countdown** (patches/expansions) that pings a role when the time comes.
- **`/todo`** — Your personal daily and weekly FFXIV checklist that resets on its own.
- **`/firmament`** — Track your personal Skyrise Celebration timer and get a DM when it's time.
- **AI reminders** — In AI channels, just say *"remind me to do roulettes in 2 hours"* or *"set a daily reminder for cactpot"*.

### 🎯 Party Finder & Raids
- **`/pf`** — Create Party Finder listings (4 or 8 players) with a date, time and your time zone. Members join by picking their role and job; hosts can edit or delete their listing.
- **`/raid`** — Shows your static's raid schedule for the next 7 days, read from a Google Sheet.
- **Raid & Logger sheets** — Admins create raid planner and command-log Google Sheets for the server in one click on the website (several per server, each can be limited to a role).
- **`/poll`** — Interactive polls with multiple answers, role-limited voting, single or multiple choice, and results. Creators and admins can see who voted for what.

### 🪪 Character Cards
- **`/ignconfig`** — Link your Lodestone character, main job, portrait or full photo, and your Tomestone and FFLogs pages.
- **`/ign`** — Generates a character card image with your Lodestone info and a QR code to your Lodestone page.

### 🃏 Games & Practice
- **`/trivia`** — **Pingway Trivia:** guess the FFXIV word of the day in 6 difficulties, earn bits, keep your streak and climb your server's leaderboard.
- **`/sciondex`** — A collecting game: recruit FFXIV NPCs, build a party of 4, fight bosses in Duty Finder, level up and earn stars. Played in a channel the server admins choose.
- **`/nissi`** — A quiz to practise TEA Nissi mechanics.

### 🤖 AI Assistant
- **Opt-in per channel:** AI only runs in channels where an admin turned it on with **`/ailistenhere`**. Slash commands, buttons, DMs, alerts and the website never use AI, and Pingway's database is never shared with any AI company.
- Chat naturally, ask FFXIV questions, set/edit/delete reminders, save notes and to-do tasks.
- Say **"release recollection"** to wipe the short chat memory instantly.

### 🛠️ Server Admin Tools
- **`/clean`** — Bulk-delete messages (including ones older than 14 days).
- **`/logger`** — Log who used which command and when, to your own Google Sheet.
- **`/honeypot`** — A "do not chat here" channel that removes hacked accounts posting spam (the server owner gets a DM report).
- **Reaction Roles** (website) — Members react with an emoji to get a role.
- **Tickets** (website) — A help desk with private ticket channels and optional transcripts.
- **FFXIV News** (website) — Post Lodestone news (topics, notices, maintenance, updates) to your channels, in your language.
- **`/notifhere`** — Choose the channel Pingway uses for notifications.
- **`/clearbotdms`** — Clean up Pingway's messages in your DMs.
- **`/pingway`** — Choose Pingway's language for you with the `language` option: English, Français, Deutsch, 日本語 or Auto (your Discord app language), e.g. `/pingway language: English`. Also in **My Settings** on the website.
- **`/help`** — The full command list.

---

## 🔒 Why is the code public?

So anyone can **check that Pingway is safe**: what it stores, what it sends, and how it protects your data. If you find a problem, please read [SECURITY.md](SECURITY.md) and report it privately.

This repository contains the **Pingway Discord bot** only. Secrets (bot token, database password, API keys) are never part of the code.

---

## 📄 Legal & Policies
- [Terms of Service](terms.md)
- [Privacy Policy](privacy.md)

## 🙏 Credits
- Market data: [Universalis](https://universalis.app)
- Item data: [XIVAPI](https://xivapi.com)
- Server status: [xivup](https://is.xivup.com)
- FFXIV news: [Lodestone News API](https://lodestonenews.com)
- Built with [discord.js](https://discord.js.org)

FINAL FANTASY is a registered trademark of Square Enix Holdings Co., Ltd. FINAL FANTASY XIV © SQUARE ENIX. Pingway is a fan project and is not affiliated with or endorsed by Square Enix or Discord.

## 📜 License
Pingway is open source under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. You may view, study and modify the code. If you run a modified version for other people (for example as a bot or website), you must make your modified source code available under the same license. See [LICENSE](LICENSE).

If Pingway helps you, you can support development on [Ko-fi](https://ko-fi.com/riverzola) 💜
