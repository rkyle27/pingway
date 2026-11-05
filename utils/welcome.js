// Welcome cards: when a member joins, Pingway posts a welcome card image in the server's chosen channel.
// - Turned on with /welcomehere (in the channel to use) or on the website (server settings -> Welcome).
// - Default: a random design (pw01..pw20) for every join.
// - Custom (Supporter Perks): one fixed design picked on the website. Same rule as reaction roles / sheets: it's on
//   when the server OWNER has Supporter Perks; otherwise it runs on the perks of the admin who picked it (perk_owner).
//   When those perks end (48-hour grace included), it moves to another admin of the server with perks, or Pingway
//   uses the random default until perks are back (the saved design is never erased).
// - Raids / mass joins: at most 3 cards per server per 30 seconds; the rest of that window get one combined text
//   message at the end of it ("Welcome @a, @b and N more! 🎉"), no images.
// - Website "Send test": the website writes welcome_requests rows; this module DMs the preview card to that admin.
// Settings are read with a 60-second cache per server (the website writes welcome_settings directly).

const axios = require('axios');
const { AttachmentBuilder, ChannelType, PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { pool } = require('./db');
const { ownerHasMembership, sponsorHasPerks, findPerksAdmin } = require('./membership');
const W = require('./welcomeCards');

const DEFAULT_MESSAGE = 'Thank you for joining the server! Have fun and feel at home.';
const MAX_MESSAGE = 300;
const SETTINGS_CACHE_MS = 60 * 1000;
const POLL_MS = 10 * 1000;
const REQUEST_KEEP_MS = 24 * 60 * 60 * 1000;      // request rows are deleted after 1 day
const REQUEST_STALE_MS = 10 * 60 * 1000;          // tests not handled within 10 minutes (bot was offline) are dropped
const AVATAR_TIMEOUT_MS = 5000;
const MAX_MENTIONS = 10;
const LIMITS = { cards: 3, windowMs: 30 * 1000 }; // per server

const NEEDED = [
    ['ViewChannel', 'View Channel'],
    ['SendMessages', 'Send Messages'],
    ['AttachFiles', 'Attach Files']
];
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

let tableReady = false;
let started = false;
let polling = false;
let lastCleanup = 0;
const cache = new Map();     // guildId -> { time, row }
const windows = new Map();   // guildId -> { start, cards, extra: [userId], channel, timer }
const logged = new Map();    // key -> time (one console line per key per hour)

async function ensureTables() {
    if (tableReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS welcome_settings (
        guild_id VARCHAR(32) PRIMARY KEY,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        channel_id VARCHAR(32) DEFAULT NULL,
        message VARCHAR(400) DEFAULT NULL,
        mode VARCHAR(8) NOT NULL DEFAULT 'default',
        design VARCHAR(8) DEFAULT NULL,
        perk_owner VARCHAR(32) DEFAULT NULL,
        updated_by VARCHAR(32) DEFAULT NULL,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS welcome_requests (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        kind VARCHAR(8) NOT NULL DEFAULT 'test',
        design VARCHAR(8) DEFAULT NULL,
        message VARCHAR(400) DEFAULT NULL,
        state VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at BIGINT NOT NULL,
        KEY idx_state (state, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    tableReady = true;
}

function logOnce(key, text) {
    const last = logged.get(key) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    logged.set(key, Date.now());
    console.log(text);
}

// ---------- settings ----------
async function getSettings(guildId) {
    const hit = cache.get(guildId);
    if (hit && Date.now() - hit.time < SETTINGS_CACHE_MS) return hit.row;
    let row = null;
    try {
        await ensureTables();
        const [rows] = await pool.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [String(guildId)]);
        row = rows[0] || null;
    } catch (err) {
        logOnce('db', '❌ [WELCOME] Could not read settings: ' + err.message);
        return hit ? hit.row : null;
    }
    cache.set(guildId, { time: Date.now(), row });
    return row;
}

function invalidate(guildId) {
    cache.delete(guildId);
}

// /welcomehere set: this channel, ON (mode / design / message are kept)
async function enableHere(guildId, channelId, userId) {
    await ensureTables();
    await pool.execute(
        `INSERT INTO welcome_settings (guild_id, enabled, channel_id, updated_by, updated_at) VALUES (?, 1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = 1, channel_id = VALUES(channel_id), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
        [String(guildId), String(channelId), String(userId), Date.now()]
    );
    invalidate(guildId);
}

// /welcomehere off
async function disable(guildId, userId) {
    await ensureTables();
    await pool.execute(
        `INSERT INTO welcome_settings (guild_id, enabled, updated_by, updated_at) VALUES (?, 0, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = 0, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
        [String(guildId), String(userId), Date.now()]
    );
    invalidate(guildId);
}

// ---------- design (Supporter Perks) ----------
// -> { design, custom } . Custom only while covered by perks; otherwise a random default (saved design kept).
async function resolveDesign(guild, settings) {
    const saved = settings && settings.mode === 'custom' && settings.design ? String(settings.design) : null;
    if (!saved || !W.ALL_DESIGNS.includes(saved)) return { design: W.randomDefault(), custom: false };
    if (await ownerHasMembership(guild.ownerId)) return { design: saved, custom: true };
    if (settings.perk_owner && await sponsorHasPerks(settings.perk_owner)) return { design: saved, custom: true };
    // perk_owner's perks ended (48 h grace over) or there was none: move it to another admin with perks
    const next = await findPerksAdmin(guild, settings.perk_owner);
    if (next) {
        await pool.execute('UPDATE welcome_settings SET perk_owner = ? WHERE guild_id = ?', [String(next), String(guild.id)]).catch(() => {});
        settings.perk_owner = String(next); // the cached row follows too
        console.log('💜 [WELCOME] Custom welcome card in ' + guild.name + ' moved to another admin\'s Supporter Perks.');
        return { design: saved, custom: true };
    }
    logOnce('noperks:' + guild.id, '💜 [WELCOME] ' + guild.name + ': custom welcome card not covered by Supporter Perks, using the random default.');
    return { design: W.randomDefault(), custom: false };
}

// ---------- helpers ----------
// One pass, so a name like "{server}" is not filled in again
function fillMessage(template, { user, server, count }) {
    const text = template && String(template).trim() ? String(template) : DEFAULT_MESSAGE;
    const values = { user: String(user || ''), server: String(server || ''), count: Number(count || 0).toLocaleString('en-US') };
    return text.replace(/\{(user|server|count)\}/g, (_, k) => values[k]);
}

// Names of the permissions Pingway is missing in the channel ([] = OK), or null if it's not a text/announcement channel
function missingPerms(guild, channel) {
    if (!channel || !TEXT_TYPES.has(channel.type)) return null;
    const me = guild.members.me || (guild.client && guild.client.user);
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms) return NEEDED.map(([, label]) => label);
    return NEEDED.filter(([flag]) => !perms.has(PermissionFlagsBits[flag])).map(([, label]) => label);
}

// Only Discord's CDN, 5 s max; null on any problem (the card is drawn without the picture)
async function fetchAvatar(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol !== 'https:' || u.hostname !== 'cdn.discordapp.com') return null;
        const r = await axios.get(u.toString(), {
            responseType: 'arraybuffer', timeout: AVATAR_TIMEOUT_MS, signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
            maxContentLength: 4 * 1024 * 1024, maxRedirects: 0
        });
        return Buffer.from(r.data);
    } catch (e) {
        return null;
    }
}

async function renderFor(member, guild, settings, override) {
    const design = override && override.design ? override.design : (await resolveDesign(guild, settings)).design;
    const template = override && 'message' in override ? override.message : (settings && settings.message);
    const name = member.displayName || (member.user && (member.user.globalName || member.user.username)) || 'Member';
    const count = guild.memberCount;
    const avatar = await fetchAvatar(member.displayAvatarURL({ extension: 'png', size: 256 }));
    const message = fillMessage(template, { user: name, server: guild.name, count });
    const png = await W.renderWelcomeCard({ design, avatar, name, message, count });
    return { png, design };
}

function mentionList(ids) {
    const shown = ids.slice(0, MAX_MENTIONS).map(id => '<@' + id + '>');
    const more = ids.length - shown.length;
    if (more > 0) return shown.join(', ') + ' and ' + more + ' more';
    if (shown.length === 1) return shown[0];
    return shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1];
}

// ---------- joins ----------
// true = post a card now; false = counted in this window's combined message
function takeSlot(guildId, userId, channel) {
    const now = Date.now();
    let w = windows.get(guildId);
    if (!w || now - w.start >= LIMITS.windowMs) {
        if (w && w.timer) { clearTimeout(w.timer); flush(guildId, w); }
        w = { start: now, cards: 0, extra: [], channel, timer: null };
        windows.set(guildId, w);
    }
    w.channel = channel;
    if (w.cards < LIMITS.cards) { w.cards++; return true; }
    if (!w.extra.includes(userId)) w.extra.push(userId);
    if (!w.timer) {
        w.timer = setTimeout(() => flush(guildId, w), Math.max(0, w.start + LIMITS.windowMs - now));
        if (w.timer.unref) w.timer.unref();
    }
    return false;
}

async function flush(guildId, w) {
    w.timer = null;
    if (windows.get(guildId) === w) windows.delete(guildId);
    const ids = w.extra.splice(0);
    if (!ids.length || !w.channel) return;
    try {
        const missing = missingPerms(w.channel.guild, w.channel);
        if (!missing || missing.includes('View Channel') || missing.includes('Send Messages')) return;
        await w.channel.send({ content: 'Welcome ' + mentionList(ids) + '! 🎉', allowedMentions: { users: ids.slice(0, MAX_MENTIONS) } });
        console.log('👋 [WELCOME] ' + w.channel.guild.name + ': ' + ids.length + ' more join(s) welcomed in one message (mass join).');
    } catch (err) {
        logOnce('send:' + guildId, '⚠️ [WELCOME] Could not post the combined welcome in ' + guildId + ': ' + err.message);
    }
}

async function handleJoin(member) {
    if (!member || !member.user || member.user.bot) return;
    const guild = member.guild;
    const settings = await getSettings(guild.id);
    if (!settings || Number(settings.enabled) !== 1 || !settings.channel_id) return;
    const channel = guild.channels.cache.get(String(settings.channel_id));
    const missing = missingPerms(guild, channel);
    if (!missing) {
        logOnce('perm:' + guild.id, '👋 [WELCOME] ' + guild.name + ': welcome channel is missing or not a text channel, skipped.');
        return;
    }
    if (missing.length) {
        logOnce('perm:' + guild.id, '👋 [WELCOME] ' + guild.name + ': missing ' + missing.join(', ') + ' in #' + channel.name + ', skipped.');
        return;
    }
    if (!takeSlot(guild.id, member.id, channel)) return;
    try {
        const { png } = await renderFor(member, guild, settings);
        await channel.send({
            content: '<@' + member.id + '>',
            files: [new AttachmentBuilder(png, { name: 'welcome.png' })],
            allowedMentions: { users: [member.id] }
        });
    } catch (err) {
        logOnce('send:' + guild.id, '⚠️ [WELCOME] Could not post a welcome card in ' + guild.name + ': ' + err.message);
    }
}

// Preview for /welcomehere (the person who ran it, current settings)
async function previewFor(member, guild) {
    const settings = await getSettings(guild.id);
    return renderFor(member, guild, settings || {});
}

// ---------- website "Send test" requests ----------
async function setState(id, state) {
    await pool.execute('UPDATE welcome_requests SET state = ? WHERE id = ?', [state, id]).catch(() => {});
}

// Names shown on the website's Custom picker (keep in sync with WELCOME_DESIGNS in the website's app.js)
const DESIGN_NAMES = {
    c20: 'Starfield', c22: 'Cozy Café', c28: 'Picnic Gingham', c30: 'Notebook', c31: 'Neon Cyber',
    c36: 'Concert Ticket', c37: 'Arcade', c39: 'Glitch', c41: 'Halloween', c42: 'Winter Snow',
    c50: 'Sumi Ink', f2: 'Lava Flow', w3: 'Bubble Pop', e4: 'Desert Dunes', a1: 'Meadow Breeze',
    i1: 'Glacier Blue', l5: 'Purple Plasma', s3: 'Pool Tiles', k1: 'Yozakura Night', k2: 'Petals on Water',
    k4: 'Falling Petals', k5: 'Sakura Mochi'
};
// pw01..pw20 (random default) -> "default"; custom designs -> their website name
function designLabel(id) {
    if (W.DEFAULT_POOL.includes(id)) return 'default';
    return DESIGN_NAMES[id] || id;
}

async function handleRequest(client, row) {
    const guild = client.guilds.cache.get(String(row.guild_id));
    const design = row.design ? String(row.design) : null;
    const message = row.message === null || row.message === undefined ? null : String(row.message);
    if (!guild || (design && !W.ALL_DESIGNS.includes(design)) || (message && message.length > MAX_MESSAGE)) {
        await setState(row.id, 'failed');
        return 'failed';
    }
    let state = 'sent';
    try {
        const member = guild.members.cache.get(String(row.user_id)) || await guild.members.fetch(String(row.user_id)).catch(() => null);
        if (!member) { await setState(row.id, 'failed'); return 'failed'; }
        const { png, design: used } = await renderFor(member, guild, {}, { design: design || W.randomDefault(), message });
        await member.send({
            content: 'Here\'s a test of your welcome card for **' + escapeMarkdown(guild.name) + '** (design ' + designLabel(used) + ').',
            files: [new AttachmentBuilder(png, { name: 'welcome-test.png' })]
        });
    } catch (err) {
        state = err && err.code === 50007 ? 'dm_closed' : 'failed';
        if (state === 'failed') logOnce('test', '⚠️ [WELCOME] Test card failed: ' + (err && err.message));
    }
    await setState(row.id, state);
    return state;
}

async function poll(client) {
    if (polling) return;
    polling = true;
    try {
        await ensureTables();
        const now = Date.now();
        // Too old to still be wanted (bot was offline), or stuck after a crash
        await pool.execute("UPDATE welcome_requests SET state = 'failed' WHERE state IN ('pending', 'working') AND created_at < ?", [now - REQUEST_STALE_MS]);
        const [rows] = await pool.execute("SELECT * FROM welcome_requests WHERE state = 'pending' ORDER BY id LIMIT 10");
        for (const row of rows) {
            // Claim it: only one bot process / loop handles a row
            const [res] = await pool.execute("UPDATE welcome_requests SET state = 'working' WHERE id = ? AND state = 'pending'", [row.id]);
            if (!res || res.affectedRows !== 1) continue;
            await handleRequest(client, row);
        }
        if (now - lastCleanup > 60 * 60 * 1000) {
            lastCleanup = now;
            await pool.execute('DELETE FROM welcome_requests WHERE created_at < ?', [now - REQUEST_KEEP_MS]);
        }
    } catch (err) {
        logOnce('poll', '❌ [WELCOME] Request check failed: ' + err.message);
    } finally {
        polling = false;
    }
}

function start(client) {
    if (started) return;
    started = true;
    const first = setTimeout(() => poll(client), 5000);
    if (first.unref) first.unref();
    const timer = setInterval(() => poll(client), POLL_MS);
    if (timer.unref) timer.unref();
}

module.exports = {
    start, poll, handleJoin, handleRequest, getSettings, invalidate, enableHere, disable, resolveDesign,
    fillMessage, missingPerms, fetchAvatar, previewFor, ensureTables,
    DEFAULT_MESSAGE, MAX_MESSAGE, LIMITS, _windows: windows
};
