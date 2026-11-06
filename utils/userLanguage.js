// Which language Pingway uses for a user's bot replies.
// Order: 1) the user's own choice (/pingway en|fr|de|jp, or "Bot language" in website My Settings)
//        2) the language of their Discord app (interaction.locale, remembered for DMs and background messages)
//        3) English
// Public messages in a server channel use the server's Discord language (guild.preferredLocale), else English.
// Table user_language is shared with the website (same DDL there): lang NULL = automatic (Discord language).
const { pool } = require('./db');
const i18n = require('./i18n');

const CACHE_MS = 60 * 1000;
const cache = new Map(); // userId -> { time, lang, discordLocale }
let tableReady = null;

function ensureTable() {
    if (!tableReady) {
        tableReady = pool.execute(
            'CREATE TABLE IF NOT EXISTS user_language (' +
            ' user_id VARCHAR(32) NOT NULL PRIMARY KEY,' +
            ' lang VARCHAR(2) NULL,' +
            ' discord_locale VARCHAR(8) NULL,' +
            ' updated_at BIGINT NOT NULL DEFAULT 0' +
            ')'
        ).catch(err => { tableReady = null; throw err; });
    }
    return tableReady;
}

async function readRow(userId) {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.time < CACHE_MS) return hit;
    let row = { lang: null, discordLocale: null };
    try {
        await ensureTable();
        const [rows] = await pool.execute('SELECT lang, discord_locale FROM user_language WHERE user_id = ?', [String(userId)]);
        if (rows.length) row = { lang: i18n.isLang(rows[0].lang) ? rows[0].lang : null, discordLocale: rows[0].discord_locale || null };
    } catch (err) {
        // database trouble: fall back to automatic, never block a reply
    }
    const entry = { time: Date.now(), ...row };
    cache.set(userId, entry);
    return entry;
}

// The user's own choice (null = automatic)
async function getChoice(userId) {
    return (await readRow(userId)).lang;
}

// Save a choice: 'en' | 'fr' | 'de' | 'ja' | null (automatic)
async function setChoice(userId, lang) {
    const value = i18n.isLang(lang) ? lang : null;
    await ensureTable();
    await pool.execute(
        'INSERT INTO user_language (user_id, lang, updated_at) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE lang = VALUES(lang), updated_at = VALUES(updated_at)',
        [String(userId), value, Date.now()]
    );
    cache.delete(String(userId));
    return value;
}

// Remember the Discord app language (only written when it changed), so DMs and background messages can use it
async function noteLocale(userId, locale) {
    const lang = i18n.fromDiscordLocale(locale);
    if (!lang) return;
    const row = await readRow(String(userId));
    if (row.discordLocale === lang) return;
    try {
        await ensureTable();
        await pool.execute(
            'INSERT INTO user_language (user_id, discord_locale, updated_at) VALUES (?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE discord_locale = VALUES(discord_locale)',
            [String(userId), lang, Date.now()]
        );
        cache.set(String(userId), { ...row, time: Date.now(), discordLocale: lang });
    } catch (err) { /* not important */ }
}

// Language for replies to an interaction (slash command, button, menu, modal)
async function forInteraction(interaction) {
    const userId = interaction && interaction.user && interaction.user.id;
    const live = i18n.fromDiscordLocale(interaction && interaction.locale);
    if (!userId) return live || i18n.DEFAULT_LANG;
    if (live) noteLocale(userId, interaction.locale).catch(() => {});
    const choice = await getChoice(userId);
    return choice || live || i18n.DEFAULT_LANG;
}

// Language for a user when there is no interaction (DMs, alerts, reminders)
async function forUser(userId) {
    const row = await readRow(String(userId));
    return row.lang || (i18n.isLang(row.discordLocale) ? row.discordLocale : null) || i18n.DEFAULT_LANG;
}

// Language for public messages in a server channel
function forGuild(guild) {
    return i18n.fromDiscordLocale(guild && guild.preferredLocale) || i18n.DEFAULT_LANG;
}

function clearCache() { cache.clear(); }

module.exports = { ensureTable, getChoice, setChoice, noteLocale, forInteraction, forUser, forGuild, clearCache };
