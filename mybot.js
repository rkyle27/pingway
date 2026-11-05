require('dotenv').config();
require('./utils/welcomeCards'); // welcome card fonts: must load before any other canvas use
const { Client, GatewayIntentBits, Collection, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Import Maintenance State Manager
const { toggleMaintenance, isMaintenance } = require('./maintenance');

// Import the Party Finder Scheduler utility
const { startPfScheduler } = require('./utils/pfScheduler');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions // reaction roles
    ]
});

// --- Global Config ---
global.pfSessions = new Map();
global.botConfig = {
    guildSettings: {}
};

// --- Command Loading with Detailed Debugging ---
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');

console.log(`\n🔍 [BOOT DEBUG] Scanning commands directory: ${commandsPath}`);
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
    console.log(`📂 [BOOT DEBUG] Found ${commandFiles.length} command file(s): [${commandFiles.join(', ')}]`);

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        try {
            const cmd = require(filePath);
            if (cmd?.data?.name) {
                client.commands.set(cmd.data.name, cmd);
                console.log(`  ✅ Successfully loaded command: /${cmd.data.name} from file '${file}'`);
            } else {
                console.warn(`  ⚠️ Warning: File '${file}' was read but lacks a valid 'data.name' property.`);
            }
        } catch (err) {
            console.error(`  ❌ CRITICAL: Failed to require/load command file '${file}':`, err);
        }
    }
} else {
    console.error(`❌ [BOOT DEBUG] Commands directory not found at: ${commandsPath}`);
}

// --- Event Loading with Detailed Debugging ---
const eventsPath = path.join(__dirname, 'events');

console.log(`\n🔍 [BOOT DEBUG] Scanning events directory: ${eventsPath}`);
if (fs.existsSync(eventsPath)) {
    const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));
    console.log(`📂 [BOOT DEBUG] Found ${eventFiles.length} event file(s): [${eventFiles.join(', ')}]`);

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        try {
            const event = require(filePath);
            if (!event.name || typeof event.execute !== 'function') {
                console.warn(`  ⚠️ Warning: Event file '${file}' is missing a 'name' or 'execute' function.`);
                continue;
            }

            if (event.once) {
                client.once(event.name, (...args) => event.execute(...args, client));
                console.log(`  ✅ Successfully bound ONE-TIME event '${event.name}' from '${file}'`);
            } else {
                client.on(event.name, (...args) => event.execute(...args, client));
                console.log(`  ✅ Successfully bound EVENT listener '${event.name}' from '${file}'`);
            }
        } catch (err) {
            console.error(`  ❌ CRITICAL: Failed to load event file '${file}':`, err);
        }
    }
} else {
    console.error(`❌ [BOOT DEBUG] Events directory not found at: ${eventsPath}`);
}
console.log(''); // Spacing for clean terminal output

// --- PF Wizard Input Listener ---
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const session = global.pfSessions.get(message.author.id);
    if (session?.step === 'name') {
        session.data.name = message.content;
        session.step = 'size';

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pf_size_4').setLabel('4 People').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('pf_size_8').setLabel('8 People').setStyle(ButtonStyle.Primary)
        );
        return message.reply({ content: "Step 2/4: Is this a 4-person or 8-person party?", components: [row] });
    }
});

// --- Background Services ---
client.once(Events.ClientReady, () => {
    console.log(`🚀 [SCHEDULER] Starting background clock services...`);
    startPfScheduler(client);
    require('./utils/honeypot').start(client); // "do not chat here" channels
    require('./utils/reactionRoles').start(client); // emoji -> role messages (website)
    require('./utils/tickets').start(client); // help desk tickets (website)
    require('./utils/lodestoneNews').start(client); // FFXIV news channels (website)
    require('./utils/voteRewards').start(client); // top.gg vote thank-you DMs (points added by the website)
    require('./utils/heartbeat').start(); // Online / Maintenance / Offline status on the website
    require('./utils/guildSheets').start(client); // Raid & Logger sheets: website requests, sharing, Supporter Perks limits
    require('./utils/trivia').start(client); // Pingway Trivia: word bank from XIVAPI (data/trivia_bank.json), tables, cleanup
    require('./utils/welcome').start(client); // Welcome cards for new members (/welcomehere + website)

    // Startup check for leftover data from servers Pingway is no longer in (read-only)
    setTimeout(async () => {
        try {
            await ensurePointsMigration(require('./utils/db').pool).catch(err => console.error('⚠️ [POINTS] Conversion check failed:', err.message));
            const leftovers = await findLeftoverServerData();
            if (leftovers.size > 0) {
                console.log('🧹 [PURGE CHECK] ' + leftovers.size + ' server(s) Pingway is no longer in still have data. Type "purge" to review.');
            }
        } catch (err) {
            console.error('⚠️ [PURGE CHECK] Failed:', err.message);
        }
    }, 15000);
    console.log(`\n💡 [CONSOLE CONTROL] Available commands: "maintenance" (or "maint"), "status", "announce" (preview) / "announce confirm", "whois <id>", "server list", "purge", "points <id>" / "points add <id> <amount>" / "points remove <id> <amount>", "retainers <id>", "trivia <id>" / "trivia reset <id> today|purge" / "trivia reset confirm", "tts" / "tts google on|off", "kofi <id>" / "kofi give|remove <id> <credits>" / "kofi member <id> <days|off>"\n`);
});

// --- Leftover Server Data (servers Pingway is no longer in) ---
// Only server-level tables. Personal data (reminders, facts, /datacenter, market alerts,
// ScionDex, IGN, /status, firmament) is never touched.
const SERVER_TABLES = ['server_settings', 'ai_active_channels', 'server_releases', 'guild_polls', 'party_finders', 'honeypot_settings', 'honeypot_log', 'rr_messages', 'ticket_settings', 'tickets', 'news_channels', 'welcome_settings', 'welcome_requests'];
let pendingPurge = null; // { expires, guildIds }

async function findLeftoverServerData() {
    const { pool } = require('./utils/db');
    const current = new Set(client.guilds.cache.keys());
    const leftovers = new Map(); // guildId -> { table: rowCount }
    for (const table of SERVER_TABLES) {
        try {
            const [rows] = await pool.query('SELECT guild_id, COUNT(*) AS n FROM ' + table + ' GROUP BY guild_id');
            for (const row of rows) {
                if (!row.guild_id) continue;
                const id = String(row.guild_id);
                if (current.has(id)) continue;
                if (!leftovers.has(id)) leftovers.set(id, {});
                leftovers.get(id)[table] = Number(row.n);
            }
        } catch (err) {
            console.error('⚠️ [PURGE] Could not check table ' + table + ': ' + err.message);
        }
    }
    return leftovers;
}

async function purgePreview() {
    if (!client.isReady() || client.guilds.cache.size === 0) {
        console.log('[PURGE] Bot is not fully ready yet. Try again in a moment.');
        return;
    }
    const leftovers = await findLeftoverServerData();
    if (leftovers.size === 0) {
        pendingPurge = null;
        console.log('\n🧹 [PURGE] No leftover server data found. Nothing to delete.\n');
        return;
    }
    console.log('\n🧹 [PURGE] Leftover data from ' + leftovers.size + ' server(s) Pingway is no longer in:');
    for (const [id, tables] of leftovers) {
        console.log('  ' + id + ': ' + Object.entries(tables).map(([table, n]) => table + ' (' + n + ')').join(', '));
    }
    console.log('  Personal data (reminders, facts, /datacenter, market alerts, ScionDex, IGN, /status, firmament) will NOT be touched.');
    console.log('  Type "purge confirm" within 60 seconds to delete the data listed above.\n');
    pendingPurge = { expires: Date.now() + 60000, guildIds: Array.from(leftovers.keys()) };
}

async function purgeConfirm() {
    if (!pendingPurge || Date.now() > pendingPurge.expires) {
        pendingPurge = null;
        console.log('[PURGE] Nothing to confirm. Type "purge" first to review what would be deleted.');
        return;
    }
    const { pool } = require('./utils/db');
    // Re-check: never delete data for a server Pingway is currently in
    const ids = pendingPurge.guildIds.filter(id => !client.guilds.cache.has(id));
    pendingPurge = null;
    if (ids.length === 0) {
        console.log('[PURGE] Nothing to delete (Pingway is back in those servers).');
        return;
    }
    const placeholders = ids.map(() => '?').join(', ');
    let total = 0;
    console.log('\n🧹 [PURGE] Deleting leftover data for ' + ids.length + ' server(s)...');
    try {
        const [votes] = await pool.query('DELETE pv FROM poll_votes pv JOIN guild_polls gp ON gp.poll_id = pv.poll_id WHERE gp.guild_id IN (' + placeholders + ')', ids);
        console.log('  poll_votes: ' + votes.affectedRows + ' row(s) deleted');
        total += votes.affectedRows;
    } catch (err) {
        console.error('  ⚠️ poll_votes: ' + err.message);
    }
    for (const table of SERVER_TABLES) {
        try {
            const [result] = await pool.query('DELETE FROM ' + table + ' WHERE guild_id IN (' + placeholders + ')', ids);
            console.log('  ' + table + ': ' + result.affectedRows + ' row(s) deleted');
            total += result.affectedRows;
        } catch (err) {
            console.error('  ⚠️ ' + table + ': ' + err.message);
        }
    }
    console.log('✅ [PURGE] Done. ' + total + ' row(s) deleted.\n');
}

// --- Announcements (console: "announce" to preview, "announce confirm" to send) ---
// Per server: Community "updates for moderators" channel -> a moderators/mods/staff channel -> /notifhere channel.
// Servers with none of these: the owner gets ONE DM, and only if none of their servers got it in a channel.
const MOD_CHANNEL_RE = /^(moderators?|mods?|mod-chat|mod-only|staff)$/i;
let pendingAnnounce = null; // { expires, text }

function readAnnouncement() {
    try {
        const annPath = path.join(process.cwd(), 'announcement.txt');
        if (fs.existsSync(annPath)) return fs.readFileSync(annPath, 'utf8').trim();
    } catch (e) {
        console.error('Failed to read announcement.txt:', e.message);
    }
    return '';
}

function canPost(channel, guild) {
    try {
        if (!channel || !channel.isTextBased() || channel.isThread()) return false;
        const me = guild.members.me;
        const perms = me ? channel.permissionsFor(me) : null;
        return Boolean(perms && perms.has(['ViewChannel', 'SendMessages']));
    } catch (e) {
        return false;
    }
}

async function findAnnounceTarget(guild) {
    if (!guild.members.me) await guild.members.fetchMe().catch(() => null);
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return null;

    // 1. Community "updates for moderators" channel
    const community = guild.publicUpdatesChannelId ? channels.get(guild.publicUpdatesChannelId) : null;
    if (canPost(community, guild)) return { channel: community, how: 'community updates channel' };

    // 2. A channel named like moderators / mods / staff
    const modChannel = channels.find(c => c && MOD_CHANNEL_RE.test(c.name || '') && canPost(c, guild));
    if (modChannel) return { channel: modChannel, how: 'moderator channel' };

    // 3. The /notifhere channel
    try {
        const { pool } = require('./utils/db');
        const [rows] = await pool.execute('SELECT startup_channel_id FROM server_settings WHERE guild_id = ?', [guild.id]);
        const notif = rows.length && rows[0].startup_channel_id ? channels.get(String(rows[0].startup_channel_id)) : null;
        if (canPost(notif, guild)) return { channel: notif, how: '/notifhere channel' };
    } catch (e) {
        console.error('[Announce] Could not read /notifhere for ' + guild.id + ':', e.message);
    }
    return null;
}

async function announcePreview() {
    if (!client.isReady()) { console.log('[ANNOUNCE] Bot is not ready yet.'); return; }
    const text = readAnnouncement();
    if (!text) { console.log('[ANNOUNCE] announcement.txt is empty or missing. Nothing to send.'); return; }

    console.log('\n📢 [ANNOUNCE PREVIEW] Text (first 200 characters):\n' + text.slice(0, 200) + (text.length > 200 ? '…' : ''));
    const deliveredOwners = new Set();
    const fallback = new Map(); // ownerId -> [guild names]
    for (const [, guild] of client.guilds.cache) {
        const target = await findAnnounceTarget(guild);
        if (target) {
            deliveredOwners.add(guild.ownerId);
            console.log('  ✅ ' + guild.name + ' → #' + target.channel.name + ' (' + target.how + ')');
        } else {
            if (!fallback.has(guild.ownerId)) fallback.set(guild.ownerId, []);
            fallback.get(guild.ownerId).push(guild.name);
            console.log('  ⚠️ ' + guild.name + ' → no channel found');
        }
    }
    for (const [ownerId, names] of fallback) {
        console.log(deliveredOwners.has(ownerId)
            ? '  ⏭️ Owner ' + ownerId + ' gets NO DM (already sees it in another server) for: ' + names.join(', ')
            : '  ✉️ Owner ' + ownerId + ' gets ONE DM for: ' + names.join(', '));
    }
    console.log('  Type "announce confirm" within 2 minutes to send.\n');
    pendingAnnounce = { expires: Date.now() + 120000, text };
}

async function announceConfirm() {
    if (!pendingAnnounce || Date.now() > pendingAnnounce.expires) {
        pendingAnnounce = null;
        console.log('[ANNOUNCE] Nothing to confirm. Type "announce" first to preview.');
        return;
    }
    const text = pendingAnnounce.text;
    pendingAnnounce = null;
    const noPings = { parse: [] }; // never ping @everyone, roles or users

    console.log('\n📢 [ANNOUNCE] Sending...');
    const deliveredOwners = new Set();
    const fallback = new Map();
    let sentChannels = 0;
    for (const [, guild] of client.guilds.cache) {
        let delivered = false;
        try {
            const target = await findAnnounceTarget(guild);
            if (target) {
                await target.channel.send({ content: '📢 **Announcement:**\n\n' + text, allowedMentions: noPings });
                delivered = true;
                sentChannels++;
                console.log('  ✅ ' + guild.name + ' → #' + target.channel.name);
            }
        } catch (err) {
            console.error('  ❌ ' + guild.name + ': ' + err.message);
        }
        if (delivered) {
            deliveredOwners.add(guild.ownerId);
        } else {
            if (!fallback.has(guild.ownerId)) fallback.set(guild.ownerId, []);
            fallback.get(guild.ownerId).push(guild.name);
        }
        await new Promise(r => setTimeout(r, 1000)); // gentle on Discord rate limits
    }

    let dms = 0;
    for (const [ownerId, names] of fallback) {
        if (deliveredOwners.has(ownerId)) {
            console.log('  ⏭️ Skipped DM to owner ' + ownerId + ' (already got it in another server)');
            continue;
        }
        try {
            const owner = await client.users.fetch(ownerId);
            await owner.send({
                content: '📢 **Announcement for your server' + (names.length > 1 ? 's' : '') + ' (' + names.join(', ') + '):**\n\n' + text +
                    '\n\n*Tip: create a moderators channel or use /notifhere so future announcements go there instead of your DMs.*',
                allowedMentions: noPings
            });
            dms++;
            console.log('  ✉️ DM sent to owner ' + ownerId + ' (' + names.join(', ') + ')');
        } catch (err) {
            console.error('  ❌ Could not DM owner ' + ownerId + ': ' + err.message);
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log('📢 Done. ' + sentChannels + ' server channel(s), ' + dms + ' owner DM(s).\n');
}

// --- Points (console only; called "credits" in the database) ---
// "points <id>" shows a user's points; "points add <id> <amount>" gives points (expire like payments, used
// only when the user switches retainers ON or enables Supporter Perks on the website);
// "points remove <id> <amount>" takes points off after a refund or chargeback. "credits ..." still works too.
const POINTS_MIGRATION = 'credits_to_points_x10_2026_11';

// Nov 2026: credits became points worth 10x. The website runs the same one-time step; whichever runs first wins
// (the bot_migrations insert can only succeed once), so balances are never multiplied twice.
async function ensurePointsMigration(pool) {
    await pool.execute('CREATE TABLE IF NOT EXISTS bot_migrations (name VARCHAR(100) PRIMARY KEY, ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    const [done] = await pool.execute('SELECT name FROM bot_migrations WHERE name = ?', [POINTS_MIGRATION]);
    if (done.length) return;
    const [tables] = await pool.query("SHOW TABLES LIKE 'credit_lots'");
    if (!tables.length) return; // Retainer Watch never used: the website sets everything up later
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        try {
            await conn.execute('INSERT INTO bot_migrations (name) VALUES (?)', [POINTS_MIGRATION]);
        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') { await conn.rollback(); return; }
            throw e;
        }
        await conn.execute('UPDATE credit_lots SET credits_total = credits_total * 10, credits_left = credits_left * 10');
        const [kp] = await conn.query("SHOW TABLES LIKE 'kofi_payments'");
        if (kp.length) await conn.execute('UPDATE kofi_payments SET credits = credits * 10');
        await conn.commit();
        console.log('🔄 One-time migration done: credits are now points (x10).');
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}
const FREE_RETAINERS = 2;
const CREDIT_VALIDITY_DAYS = 180;

function newClaimCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'PW-';
    for (const b of require('crypto').randomBytes(6)) code += alphabet[b % alphabet.length];
    return code;
}

async function creditsAdd(conn, userId, amount, now) {
    let [[acct]] = await conn.execute('SELECT * FROM supporter_account WHERE user_id = ? FOR UPDATE', [userId]);
    if (!acct) {
        for (let i = 0; i < 5 && !acct; i++) {
            try {
                await conn.execute('INSERT INTO supporter_account (user_id, claim_code, created_at) VALUES (?, ?, ?)', [userId, newClaimCode(), now]);
            } catch (e) {
                if (e.code !== 'ER_DUP_ENTRY') throw e;
            }
            [[acct]] = await conn.execute('SELECT * FROM supporter_account WHERE user_id = ? FOR UPDATE', [userId]);
        }
        if (!acct) throw new Error('could not create supporter account');
    }
    await conn.execute(
        'INSERT INTO credit_lots (user_id, credits_total, credits_left, source, ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, amount, amount, 'manual', 'console', now, now + CREDIT_VALIDITY_DAYS * 864e5]
    );

    // Like a Ko-fi payment: points only wait in the balance. They are used when the user switches retainers ON or enables perks.
}
async function creditsCommand(args) {
    const { pool } = require('./utils/db');
    const remove = args[0] === 'remove';
    const add = args[0] === 'add';
    const userId = remove || add ? args[1] : args[0];
    const amount = remove || add ? Number(args[2]) : 0;
    if (!userId || !/^\d{15,22}$/.test(userId) ||
        (remove && (!Number.isInteger(amount) || amount <= 0 || amount > 1000000)) ||
        (add && (!Number.isInteger(amount) || amount <= 0 || amount > 100000))) {
        console.log('[CONSOLE] Usage: points <discord user id>  |  points add <discord user id> <1-100000>  |  points remove <discord user id> <amount>');
        return;
    }
    try {
        await ensurePointsMigration(pool);
    } catch (err) {
        console.error('[POINTS] Could not convert credits to points:', err.message);
        return;
    }
    const now = Date.now();
    const fmt = ts => ts ? new Date(Number(ts)).toISOString().slice(0, 10) : 'never';
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        if (add) {
            await creditsAdd(conn, userId, amount, now);
            await conn.commit();
            const [[b]] = await pool.execute('SELECT COALESCE(SUM(credits_left), 0) AS bal FROM credit_lots WHERE user_id = ? AND credits_left > 0 AND (expires_at = 0 OR expires_at > ?)', [userId, now]);
            console.log('\n💎 [POINTS] Added ' + amount + ' point(s) to ' + userId + ' (expire ' + fmt(now + CREDIT_VALIDITY_DAYS * 864e5) + '). Balance now: ' + Number(b.bal) + '.');
            console.log('  Points are used when they switch retainers ON, enable Supporter Perks, or at renewal. Paused retainers are not resumed automatically.\n');
            return;
        }
        const [[acct]] = await conn.execute('SELECT * FROM supporter_account WHERE user_id = ? FOR UPDATE', [userId]);
        const [lots] = await conn.execute(
            'SELECT id, credits_left, created_at, expires_at FROM credit_lots WHERE user_id = ? AND credits_left > 0 AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC, id DESC FOR UPDATE',
            [userId, now]
        );
        const balance = lots.reduce((sum, l) => sum + Number(l.credits_left), 0);

        if (!remove) {
            await conn.commit();
            const [rows] = await pool.execute('SELECT world_name, retainer_name, enabled FROM retainer_watch WHERE user_id = ? ORDER BY created_at, id', [userId]);
            let perks = 'off';
            try {
                const [[pk]] = await pool.execute('SELECT state, cycle_end FROM supporter_perks WHERE user_id = ?', [userId]);
                if (pk && pk.state !== 'off' && pk.cycle_end) perks = pk.state + (pk.state === 'active' ? ', renews ' : ', ends ') + fmt(pk.cycle_end);
            } catch (e) { /* table not created yet */ }
            console.log('\n💎 [POINTS] ' + userId);
            console.log('  Supporter Perks: ' + perks);
            console.log('  Balance: ' + balance + ' point(s)' + (lots.length ? ' (' + lots.map(l => l.credits_left + ' expires ' + fmt(l.expires_at)).join(', ') + ')' : ''));
            console.log('  Month: ' + (acct && acct.cycle_end ? fmt(acct.cycle_start) + ' -> ' + fmt(acct.cycle_end) : 'not started') +
                ' | Paid slots: ' + (acct ? acct.paid_slots : 0));
            console.log('  Retainers: ' + (rows.length ? rows.map(r => r.retainer_name + ' (' + r.world_name + ')' + ({ 0: ' [off]', 2: ' [paused]' }[Number(r.enabled)] || '')).join(', ') : 'none') + '\n');
            return;
        }

        // Take from the newest points first (the refunded payment is usually the latest)
        let left = amount;
        for (const lot of lots) {
            if (left <= 0) break;
            const take = Math.min(left, Number(lot.credits_left));
            await conn.execute('UPDATE credit_lots SET credits_left = credits_left - ? WHERE id = ?', [take, lot.id]);
            left -= take;
        }
        const removed = amount - left;

        // Points that were already spent on this month: take those paid slots away too
        let paidSlots = acct ? Number(acct.paid_slots) || 0 : 0;
        if (acct && left > 0) {
            paidSlots = Math.max(0, paidSlots - left);
            await conn.execute('UPDATE supporter_account SET paid_slots = ?, paused = 1 WHERE user_id = ?', [paidSlots, userId]);
        }
        // Retainers switched ON beyond the free + paid slots become PAUSED (newest first)
        const [rows] = await conn.execute('SELECT id FROM retainer_watch WHERE user_id = ? AND enabled = 1 ORDER BY created_at, id', [userId]);
        let pausedNow = 0;
        for (let i = FREE_RETAINERS + paidSlots; i < rows.length; i++) {
            await conn.execute('UPDATE retainer_watch SET enabled = 2, active = 0 WHERE id = ?', [rows[i].id]);
            pausedNow++;
        }
        await conn.commit();
        console.log('\n💎 [POINTS] Removed ' + removed + ' unused point(s) from ' + userId + '. Balance now: ' + (balance - removed) + '.');
        if (left > 0 && acct) console.log('  ' + left + ' point(s) were already used this month: paid slots reduced to ' + paidSlots + (pausedNow ? ', ' + pausedNow + ' retainer(s) paused' : '') + '.');
        else if (left > 0) console.log('  This user has no supporter account, so nothing else was changed.');
        console.log('');
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        if (err && err.code === 'ER_NO_SUCH_TABLE') console.log('[POINTS] Retainer Watch tables do not exist yet (no one has used the Retainers page).');
        else if (err && err.code === 'ER_BAD_FIELD_ERROR') console.log('[POINTS] The database needs the new switch column: open the Retainers page on the website once, then try again.');
        else console.error('❌ [POINTS] Failed:', err.message);
    } finally {
        if (conn) conn.release();
    }
}

// --- Centralized Terminal Console Listener ---
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line) => {
    const input = line.trim().toLowerCase();

    if (input === 'maintenance' || input === 'maint') {
        const currentStatus = toggleMaintenance();
        if (currentStatus) {
            console.log('\x1b[33m\n🔧 [CONSOLE] MAINTENANCE MODE ACTIVATED. All commands and AI auto-replies are now blocked.\x1b[0m\n');
        } else {
            console.log('\x1b[32m\n🟢 [CONSOLE] MAINTENANCE MODE DEACTIVATED. Bot operations have resumed normally.\x1b[0m\n');
        }
    } else if (input === 'status') {
        console.log(`\n[CONSOLE] Maintenance mode status: ${isMaintenance() ? 'ON 🔴' : 'OFF 🟢'}\n`);
    } else if (input === 'announce') {
        await announcePreview();
    } else if (input === 'announce confirm') {
        await announceConfirm();
    } else if (input === 'server list' || input === 'servers') {
        console.log('\n🗂️ [SERVER LIST] Pingway is in ' + client.guilds.cache.size + ' server(s):');
        for (const [, guild] of client.guilds.cache) {
            console.log('  • ' + guild.name + ' (' + guild.id + ') | Members: ' + guild.memberCount + ' | Owner ID: ' + guild.ownerId);
        }
        console.log('');
    } else if (input === 'purge') {
        await purgePreview();
    } else if (input === 'purge confirm') {
        await purgeConfirm();
    } else if (input.startsWith('whois')) {
        // Read-only lookup: Discord name + saved bot data for a user ID
        const targetId = input.split(/\s+/)[1];
        if (!targetId || !/^\d{15,22}$/.test(targetId)) {
            console.log('[CONSOLE] Usage: whois <discord user id>');
            return;
        }
        const { pool } = require('./utils/db');
        const parseList = (v) => { try { const p = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(p) ? p : []; } catch (e) { return []; } };
        console.log('\n🔎 [WHOIS] Looking up ' + targetId + '...');
        try {
            const user = await client.users.fetch(targetId).catch(() => null);
            console.log(user
                ? '  Discord: ' + user.username + ' (display name: ' + (user.globalName || user.username) + ')'
                : '  Discord: not found (deleted account or no shared server)');

            const [ma] = await pool.execute('SELECT dm_enabled FROM market_alerts WHERE user_id = ?', [targetId]);
            if (ma.length) {
                console.log('  Market Alert: DMs ' + (ma[0].dm_enabled ? 'ON' : 'OFF') + ' (uses their /datacenter Data Centers)');
            } else {
                console.log('  Market Alert: no settings');
            }

            const [ud] = await pool.execute('SELECT guild_id, datacenters FROM user_datacenters WHERE user_id = ?', [targetId]);
            if (ud.length) {
                for (const row of ud) {
                    const guild = client.guilds.cache.get(row.guild_id);
                    const label = row.guild_id === 'personal'
                        ? 'personal (used everywhere)'
                        : 'old per-server row from ' + (guild ? guild.name : 'unknown server') + ' (' + row.guild_id + ')';
                    console.log('  /datacenter ' + label + ': ' + (parseList(row.datacenters).join(', ') || 'none'));
                }
            } else {
                console.log('  /datacenter: nothing saved');
            }

            // Read whatever columns the live table has (skip images/links/timestamps)
            const [ign] = await pool.execute('SELECT * FROM user_ign_config WHERE user_id = ?', [targetId]);
            if (ign.length) {
                const skip = ['user_id', 'lodestone_portrait', 'custom_photo', 'custom_links', 'updated_at', 'created_at'];
                const info = Object.entries(ign[0]).filter(([k, v]) => !skip.includes(k) && v !== null && v !== '').map(([k, v]) => k + ': ' + v);
                console.log('  FFXIV (/ignconfig): ' + (info.join(' | ') || 'saved, but empty'));
            } else {
                console.log('  FFXIV: no /ignconfig saved');
            }
            console.log('');
        } catch (err) {
            console.error('❌ [WHOIS] Lookup failed:', err.message);
        }
    } else if (input === 'retainers' || input.startsWith('retainers ')) {
        // Read-only: what Retainer Watch tracks for a user, with live Universalis prices
        const targetId = input.split(/\s+/)[1];
        if (!targetId || !/^\d{15,22}$/.test(targetId)) {
            console.log('[CONSOLE] Usage: retainers <discord user id>');
            return;
        }
        try {
            await require('./utils/retainerWatch').describeUser(targetId);
        } catch (err) {
            console.error('❌ [RETAINERS] Lookup failed:', err.message);
        }
    } else if (input === 'points' || input.startsWith('points ') || input === 'credits' || input.startsWith('credits ')) {
        await creditsCommand(input.split(/\s+/).slice(1));
    } else if (input === 'trivia' || input.startsWith('trivia ')) {
        // Pingway Trivia: "trivia <id>" (read only), "trivia reset <id> today|purge" (preview) / "trivia reset confirm"
        try {
            await require('./utils/trivia').adminTrivia(input.split(/\s+/).slice(1));
        } catch (err) {
            console.error('❌ [TRIVIA] Console command failed:', err.message);
        }
    } else if (input === 'tts' || input.startsWith('tts ')) {
        // /vc voices: "tts" (Google on/off, free period, today's free characters, calls) / "tts google on|off" (kill switch)
        try {
            await require('./utils/voice/settings').ttsConsole(input.split(/\s+/).slice(1));
        } catch (err) {
            console.error('❌ [TTS] Console command failed:', err.message);
        }
    } else if (input === 'kofi' || input.startsWith('kofi ')) {
        // Google voice credits ($1 = 100 credits, 1 credit = 2,000 characters): "kofi <id>" (read only),
        // "kofi give|remove <id> <credits>", "kofi member <id> <days|off>"
        try {
            await require('./utils/voice/kofiAdmin').kofiConsole(input.split(/\s+/).slice(1), { client });
        } catch (err) {
            console.error('❌ [KOFI] Console command failed:', err.message);
        }
    } else if (input.length > 0) {
        console.log(`[CONSOLE] Unknown console command: "${input}".`);
    }
});

// --- Crash Safety Net (log errors instead of crashing the bot) ---
process.on('unhandledRejection', (reason) => {
    const { isDiscordApiError, isSlowError, apiWhere, redactApiError } = require('./utils/discordErrors');
    if (isSlowError(reason)) {
        // Interaction expired / already answered (slow host) - one short line, no dump
        console.error(`⏱️ [SLOW] [UNHANDLED REJECTION] ${reason.message} (${reason.code}) | ${apiWhere(reason)}`);
        return;
    }
    if (isDiscordApiError(reason)) {
        // Never dump reason itself: its url holds the interaction token
        console.error(`❌ [UNHANDLED REJECTION] DiscordAPIError ${reason.code} | ${apiWhere(reason)}`, redactApiError(reason));
        return;
    }
    console.error('❌ [UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ [UNCAUGHT EXCEPTION]', err);
});
client.on(Events.Error, (err) => {
    console.error('❌ [DISCORD CLIENT ERROR]', err);
});

// --- Client Login ---
client.login(process.env.DISCORD_TOKEN);