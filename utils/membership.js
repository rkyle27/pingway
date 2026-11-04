// Supporter Perks check for server features with limits (reaction roles).
// A server is unlocked when its OWNER has Supporter Perks on (bought with points on the website, 10 points a month).
// Same rule as the website (lib/credits.js perksOn): 'active' counts until the end date + the 48-hour renewal grace,
// 'canceled' counts until the end date.

const { pool } = require('./db');

const GRACE_MS = 48 * 60 * 60 * 1000;
const CACHE_MS = 5 * 60 * 1000;

const cache = new Map(); // ownerId -> { time, active }

async function ownerHasMembership(ownerId) {
    if (!ownerId) return false;
    const hit = cache.get(ownerId);
    if (hit && Date.now() - hit.time < CACHE_MS) return hit.active;
    let active = false;
    try {
        const [[row]] = await pool.execute('SELECT state, cycle_end FROM supporter_perks WHERE user_id = ?', [String(ownerId)]);
        if (row && row.cycle_end !== null) {
            const end = Number(row.cycle_end);
            active = row.state === 'active' ? end + GRACE_MS > Date.now() : row.state === 'canceled' ? end > Date.now() : false;
        }
    } catch (err) {
        // Table missing (no one has used Supporter Perks yet) = no perks
        if (!/doesn't exist/i.test(err.message)) console.error('❌ [PERKS] Check failed:', err.message);
    }
    cache.set(ownerId, { time: Date.now(), active });
    return active;
}

// ---- Perks that run extra reaction role messages (rr_messages.perk_owner) ----
// A sponsor's perks count until 48 hours after they end (the grace before the messages move or pause).
const sponsorOk = row => !!row && row.cycle_end !== null && Number(row.cycle_end) + GRACE_MS > Date.now();
let perksUsersCache = { time: 0, rows: new Map() };

// Everyone whose perks are on (or still inside the 48-hour grace), cached for 5 minutes
async function perksUsers() {
    if (Date.now() - perksUsersCache.time < CACHE_MS) return perksUsersCache.rows;
    let rows = new Map();
    try {
        const [list] = await pool.execute('SELECT user_id, state, cycle_end FROM supporter_perks WHERE cycle_end IS NOT NULL AND cycle_end > ?', [Date.now() - GRACE_MS]);
        rows = new Map(list.filter(sponsorOk).map(r => [String(r.user_id), r]));
    } catch (err) {
        if (!/doesn't exist|no such table/i.test(err.message)) console.error('❌ [PERKS] Check failed:', err.message);
    }
    perksUsersCache = { time: Date.now(), rows };
    return rows;
}

async function sponsorHasPerks(userId) {
    if (!userId) return false;
    return (await perksUsers()).has(String(userId));
}

// Another admin of this server (Manage Server or Administrator, or the owner) with perks, or null
// (checked at most every 5 minutes per server, so paused messages don't ask Discord every minute)
const adminCache = new Map(); // guildId|exclude -> { time, userId }
async function findPerksAdmin(guild, exclude) {
    const key = guild.id + '|' + String(exclude || '');
    const hit = adminCache.get(key);
    if (hit && Date.now() - hit.time < CACHE_MS) return hit.userId;
    const { PermissionFlagsBits } = require('discord.js');
    let found = null;
    for (const userId of (await perksUsers()).keys()) {
        if (userId === String(exclude || '')) continue;
        if (userId === String(guild.ownerId)) { found = userId; break; }
        const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
        if (member && member.permissions.has(PermissionFlagsBits.ManageGuild)) { found = userId; break; }
    }
    adminCache.set(key, { time: Date.now(), userId: found });
    return found;
}

module.exports = { ownerHasMembership, sponsorHasPerks, findPerksAdmin };
