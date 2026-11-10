// Server language override (website: server settings -> Server language card, admins only), v2.2.
// Table guild_language is shared with the website (same DDL there): lang NULL / no row = the server's Discord language.
// userLanguage.forGuild() must stay synchronous (it is used everywhere), so every override is kept in memory and
// re-read every minute. The database is only loaded when the overrides are read (no database needed to use get()).
const i18n = require('./i18n');

const GUILD_DDL = 'CREATE TABLE IF NOT EXISTS guild_language (' +
    ' guild_id VARCHAR(32) NOT NULL PRIMARY KEY,' +
    ' lang VARCHAR(2) NULL,' +
    ' updated_by VARCHAR(32) NULL,' +
    ' updated_at BIGINT NOT NULL DEFAULT 0' +
    ' )'; // exactly the website's DDL (api/language.js GUILD_DDL)
const REFRESH_MS = 60 * 1000;
let overrides = new Map(); // guildId -> 'en' | 'fr' | 'de' | 'ja'
let timer = null;

async function load() {
    try {
        const { pool } = require('./db');
        await pool.execute(GUILD_DDL);
        const [rows] = await pool.execute('SELECT guild_id, lang FROM guild_language WHERE lang IS NOT NULL');
        const next = new Map();
        for (const r of rows) if (i18n.isLang(r.lang)) next.set(String(r.guild_id), r.lang);
        overrides = next;
    } catch (err) {
        // database trouble: keep the last known overrides (or none), never block a post
    }
    return overrides.size;
}

function start() {
    if (timer) return;
    load().catch(() => {});
    timer = setInterval(() => load().catch(() => {}), REFRESH_MS);
    if (timer.unref) timer.unref();
}

// The server's override, or null (= its Discord language)
function get(guildId) {
    return guildId ? overrides.get(String(guildId)) || null : null;
}

module.exports = { GUILD_DDL, load, start, get };
