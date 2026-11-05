// Google voice rules for a call, plus the personal voice settings people set on the website (My Settings).
//
// Free period (until TTS_FREE_UNTIL, default 2027-02-01 00:00 Japan time): everyone gets Google as before
// (the global daily safety cap GOOGLE_TTS_DAILY_CHARS still applies), no character lots are used.
// After it: a call uses Google only while the "caller" (the person whose /vc brought Pingway into the call)
// is in the call, has Google switched on in My Settings and has characters left (tts_char_lots, written by the
// website). Their characters are the limit, not the daily cap. Otherwise the eSpeak backup voice.
// Always: max CALL_HOURLY_MAX Google characters per rolling hour per call, and the console kill switch (settings.js).
//
// Tables (created by the website; missing tables = no characters / default settings). Read here:
//   tts_char_lots       (user_id, chars_left, expires_at)
//   voice_user_settings (user_id, google_on, nickname, max_chars)
// Notes and the panel only ever say "Google voice" / "backup voice", never whose characters are used.

const killSwitch = require('./settings');

const FREE_UNTIL_DEFAULT = Date.parse('2027-02-01T00:00:00+09:00'); // 2027-01-31 15:00 UTC
const CALL_HOURLY_MAX = 20000;
const HOUR_MS = 60 * 60 * 1000;
const SETTINGS_TTL_MS = 60 * 1000; // a switch flipped on the website works within a minute
const BALANCE_TTL_MS = 60 * 1000;
const MAX_CACHE = 5000;
const MAX_CHARS_DEFAULT = 200;
const MAX_CHARS_MIN = 20;
const NICK_MAX = 32;
const OUT_OF_CHARS_NOTE = '🔊 Google voice ended for this call, using the backup voice.';

/** End of the free period (ms). TTS_FREE_UNTIL = ISO date ("2027-02-01T00:00:00+09:00") or ms; bad value = default. */
function freeUntil() {
    const raw = process.env.TTS_FREE_UNTIL;
    if (raw === undefined || String(raw).trim() === '') return FREE_UNTIL_DEFAULT;
    const s = String(raw).trim();
    const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    return Number.isFinite(n) ? n : FREE_UNTIL_DEFAULT;
}

function isFreePeriod(now = Date.now()) {
    return now < freeUntil();
}

/** Same cleaning as the website: no links, mentions, markdown or control characters; max 32; '' -> null. */
function cleanNickname(raw) {
    if (raw === undefined || raw === null) return null;
    let s = String(raw).normalize('NFC');
    s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ');
    s = s.replace(/\[([^\]]{0,100})\]\([^)]*\)/g, '$1');
    s = s.replace(/<?\b(?:https?:\/\/|www\.)[^\s>]*>?/gi, ' ');
    s = s.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|gg|io|app|me|xyz|ly|co|tv|link|site|info|dev)\b\S*/gi, ' ');
    s = s.replace(/<(?:@[!&]?|#)\d+>/g, ' ');
    s = s.replace(/<a?:(\w{1,32}):\d+>/g, '$1');
    s = s.replace(/<\/?[^>]{0,40}>/g, ' ');
    s = s.replace(/@(everyone|here)\b/gi, '$1');
    s = s.replace(/[*_~`|<>@#\\[\]()]/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    const chars = Array.from(s);
    if (chars.length > NICK_MAX) s = chars.slice(0, NICK_MAX).join('').trim();
    return s && /[\p{L}\p{N}]/u.test(s) ? s : null;
}

/** 20..200, anything else = 200. */
function clampMaxChars(v) {
    const n = Number(v);
    if (v === null || v === undefined || !Number.isInteger(n) || n < MAX_CHARS_MIN || n > MAX_CHARS_DEFAULT) return MAX_CHARS_DEFAULT;
    return n;
}

const DEFAULT_SETTINGS = Object.freeze({ googleOn: true, nickname: null, maxChars: MAX_CHARS_DEFAULT });
const missingTable = err => !!err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist|no such table/i.test(String(err.message)));

function createMembers({ getPool = () => require('../db').pool, clock = { now: () => Date.now() } } = {}) {
    const settingsCache = new Map(); // userId -> { value, at }
    const balances = new Map();      // userId -> { left, at }
    const chains = new Map();        // userId -> Promise (DB deductions, one after another)

    const cacheSet = (map, key, value) => {
        if (map.size >= MAX_CACHE) map.delete(map.keys().next().value);
        map.set(key, value);
    };

    async function getUserSettings(userId) {
        if (!userId) return DEFAULT_SETTINGS;
        const now = clock.now();
        const hit = settingsCache.get(userId);
        if (hit && now - hit.at < SETTINGS_TTL_MS) return hit.value;
        let value = DEFAULT_SETTINGS;
        try {
            const [rows] = await getPool().execute('SELECT google_on, nickname, max_chars FROM voice_user_settings WHERE user_id = ?', [String(userId)]);
            const r = rows && rows[0];
            if (r) {
                value = Object.freeze({
                    googleOn: !(r.google_on !== null && r.google_on !== undefined && Number(r.google_on) === 0),
                    nickname: cleanNickname(r.nickname),
                    maxChars: clampMaxChars(r.max_chars === null ? null : Number(r.max_chars))
                });
            }
        } catch (err) {
            if (!missingTable(err)) console.error('⚠️ [VC] voice_user_settings read failed:', err.code || err.message);
            if (hit) return hit.value;
        }
        cacheSet(settingsCache, userId, { value, at: now });
        return value;
    }

    async function loadBalance(userId, now) {
        try {
            const [rows] = await getPool().execute(
                'SELECT COALESCE(SUM(chars_left), 0) AS left_ FROM tts_char_lots WHERE user_id = ? AND chars_left > 0 AND (expires_at = 0 OR expires_at > ?)',
                [String(userId), now]
            );
            return Number(rows && rows[0] && rows[0].left_) || 0;
        } catch (err) {
            if (!missingTable(err)) console.error('⚠️ [VC] tts_char_lots read failed:', err.code || err.message);
            return 0;
        }
    }

    /** Characters left (cached up to a minute; our own spending is subtracted right away). */
    async function charsLeft(userId, now = clock.now()) {
        if (!userId) return 0;
        const hit = balances.get(userId);
        if (hit && now - hit.at < BALANCE_TTL_MS) return hit.left;
        await (chains.get(userId) || Promise.resolve()); // pending deductions first, so the DB value is current
        const left = await loadBalance(userId, now);
        cacheSet(balances, userId, { left, at: now });
        return left;
    }

    // Oldest-expiring lots first, in one transaction with row locks (never below zero).
    async function deduct(userId, n, now) {
        const pool = getPool();
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [lots] = await conn.execute(
                'SELECT id, chars_left FROM tts_char_lots WHERE user_id = ? AND chars_left > 0 AND (expires_at = 0 OR expires_at > ?) ORDER BY (expires_at = 0), expires_at, id FOR UPDATE',
                [String(userId), now]
            );
            let left = n;
            for (const lot of lots) {
                if (left <= 0) break;
                const take = Math.min(left, Number(lot.chars_left));
                if (take <= 0) continue;
                await conn.execute('UPDATE tts_char_lots SET chars_left = chars_left - ? WHERE id = ? AND chars_left >= ?', [take, lot.id, take]);
                left -= take;
            }
            await conn.commit();
            return n - Math.max(0, left);
        } catch (err) {
            await conn.rollback().catch(() => {});
            throw err;
        } finally {
            conn.release();
        }
    }

    /** Takes n characters Google accepted. Memory first (next message sees it), then the DB in order. */
    function spend(userId, n, now = clock.now()) {
        n = Math.max(0, Math.floor(n));
        const hit = balances.get(userId);
        if (hit) hit.left = Math.max(0, hit.left - n);
        const prev = chains.get(userId) || Promise.resolve();
        const next = prev.then(() => deduct(userId, n, now)).catch(err => {
            if (!missingTable(err)) console.error('⚠️ [VC] tts_char_lots update failed:', err.code || err.message);
            return 0;
        });
        chains.set(userId, next);
        next.then(() => { if (chains.get(userId) === next) chains.delete(userId); });
        return next;
    }

    function _reset() {
        settingsCache.clear();
        balances.clear();
        chains.clear();
    }

    return { getUserSettings, charsLeft, spend, _reset };
}

// ---------------- per-call rules ----------------
function windowUsed(session, now) {
    const w = session.googleWindow || (session.googleWindow = []);
    while (w.length && now - w[0].at >= HOUR_MS) w.shift();
    return w.reduce((sum, x) => sum + x.n, 0);
}

function recordWindow(session, n, now) {
    (session.googleWindow || (session.googleWindow = [])).push({ at: now, n });
}

/**
 * May this call's next message (chars long) use Google?
 * @returns {Promise<{ google: boolean, reason: string, dailyCap?: boolean, onAccepted?: (n) => Promise }>}
 *   reason: 'switch' | 'hourly' | 'free' | 'member' | 'no_caller' | 'caller_away' | 'switched_off' | 'no_chars'
 *   dailyCap = the global daily safety cap applies (free period only). onAccepted(n) = call after Google accepted n chars.
 * dryRun (panel) never posts the note.
 */
async function planGoogle(session, chars, opts = {}) {
    const now = opts.now !== undefined ? opts.now : (session.clock ? session.clock.now() : Date.now());
    const sw = opts.killSwitch || killSwitch;
    const members = opts.members || getMembers();
    if (!sw.isGoogleOn()) return { google: false, reason: 'switch' };
    if (windowUsed(session, now) + chars > CALL_HOURLY_MAX) return { google: false, reason: 'hourly' };

    if (isFreePeriod(now)) {
        return { google: true, reason: 'free', dailyCap: true, onAccepted: async n => recordWindow(session, n, now) };
    }

    const caller = session.callerId;
    if (!caller) return { google: false, reason: 'no_caller' };
    if (!session.callerPresent()) return { google: false, reason: 'caller_away' };
    const st = await members.getUserSettings(caller);
    if (!st.googleOn) return { google: false, reason: 'switched_off' };
    const left = await members.charsLeft(caller, now);
    if (left <= 0) {
        // characters ran out during this call: one short note in the voice channel's chat (names nobody)
        if (!opts.dryRun && session.memberGoogleUsed && !session.charsNoteSent) {
            session.charsNoteSent = true;
            session.sendNote(OUT_OF_CHARS_NOTE);
        }
        return { google: false, reason: 'no_chars' };
    }
    return {
        google: true,
        reason: 'member',
        dailyCap: false,
        onAccepted: async n => {
            recordWindow(session, n, now);
            session.memberGoogleUsed = true;
            members.spend(caller, n, now); // memory now, DB in the background (no wait before speaking)
        }
    };
}

let shared = null;
function getMembers() {
    if (!shared) shared = createMembers();
    return shared;
}

module.exports = {
    FREE_UNTIL_DEFAULT, CALL_HOURLY_MAX, HOUR_MS, SETTINGS_TTL_MS, MAX_CHARS_DEFAULT, MAX_CHARS_MIN, NICK_MAX, OUT_OF_CHARS_NOTE,
    freeUntil, isFreePeriod, cleanNickname, clampMaxChars, createMembers, getMembers, planGoogle, windowUsed
};
