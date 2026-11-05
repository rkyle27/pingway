// /vc database access: per-server settings (read only here; the website will write them) and per-user voice.
// Tables are created on first use (CREATE TABLE IF NOT EXISTS). Message text is never stored.

const { isKnownVoice } = require('./voices');

const SETTINGS_TTL_MS = 60 * 1000;
const PREF_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE = 5000;

let pool = null;
let tablesReady = null;
const settingsCache = new Map(); // guildId -> { value, at }
const prefCache = new Map();     // userId -> { value, at }

function getPool() {
    if (!pool) pool = require('../db').pool;
    return pool;
}

/** Tests inject a fake pool. */
function _setPool(p) {
    pool = p;
    tablesReady = null;
    settingsCache.clear();
    prefCache.clear();
}

function ensureTables() {
    if (!tablesReady) {
        const p = getPool();
        tablesReady = (async () => {
            await p.execute(`CREATE TABLE IF NOT EXISTS voice_settings (
                guild_id VARCHAR(32) PRIMARY KEY,
                default_voice VARCHAR(48) DEFAULT NULL,
                dj_role_id VARCHAR(32) DEFAULT NULL,
                updated_at BIGINT NOT NULL DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
            await p.execute(`CREATE TABLE IF NOT EXISTS voice_user_prefs (
                user_id VARCHAR(32) PRIMARY KEY,
                voice VARCHAR(48) NOT NULL,
                updated_at BIGINT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        })().catch(err => {
            tablesReady = null; // try again next time
            throw err;
        });
    }
    return tablesReady;
}

function cacheSet(map, key, value) {
    if (map.size >= MAX_CACHE) map.delete(map.keys().next().value);
    map.set(key, { value, at: Date.now() });
}

function cacheGet(map, key, ttl) {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit;
    return null;
}

const EMPTY_SETTINGS = Object.freeze({ defaultVoice: null, djRoleId: null });

/** { defaultVoice, djRoleId } - never throws (DB trouble = no DJ role, no default voice). */
async function getGuildSettings(guildId) {
    const hit = cacheGet(settingsCache, guildId, SETTINGS_TTL_MS);
    if (hit) return hit.value;
    try {
        await ensureTables();
        const [rows] = await getPool().execute('SELECT default_voice, dj_role_id FROM voice_settings WHERE guild_id = ?', [String(guildId)]);
        const r = rows && rows[0];
        const value = r ? {
            defaultVoice: r.default_voice && isKnownVoice(r.default_voice) ? r.default_voice : null,
            djRoleId: r.dj_role_id && /^\d{15,25}$/.test(String(r.dj_role_id)) ? String(r.dj_role_id) : null
        } : EMPTY_SETTINGS;
        cacheSet(settingsCache, guildId, value);
        return value;
    } catch (err) {
        console.error('⚠️ [VC] voice_settings read failed:', err.code || err.message);
        return (settingsCache.get(guildId) || {}).value || EMPTY_SETTINGS;
    }
}

/** Cached value only (no DB) - used where we must answer Discord within 3 s (showModal). */
function peekGuildSettings(guildId) {
    const hit = settingsCache.get(guildId);
    return hit ? hit.value : null;
}

async function getUserVoice(userId) {
    const hit = cacheGet(prefCache, userId, PREF_TTL_MS);
    if (hit) return hit.value;
    try {
        await ensureTables();
        const [rows] = await getPool().execute('SELECT voice FROM voice_user_prefs WHERE user_id = ?', [String(userId)]);
        const v = rows && rows[0] && isKnownVoice(rows[0].voice) ? rows[0].voice : null;
        cacheSet(prefCache, userId, v);
        return v;
    } catch (err) {
        console.error('⚠️ [VC] voice_user_prefs read failed:', err.code || err.message);
        return null;
    }
}

/** voice = null -> back to the server default. */
async function setUserVoice(userId, voice) {
    await ensureTables();
    if (voice === null) {
        await getPool().execute('DELETE FROM voice_user_prefs WHERE user_id = ?', [String(userId)]);
    } else {
        if (!isKnownVoice(voice)) throw new Error('unknown voice');
        await getPool().execute(
            'INSERT INTO voice_user_prefs (user_id, voice, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE voice = VALUES(voice), updated_at = VALUES(updated_at)',
            [String(userId), voice, Date.now()]
        );
    }
    cacheSet(prefCache, userId, voice);
}

module.exports = { ensureTables, getGuildSettings, peekGuildSettings, getUserVoice, setUserVoice, _setPool };
