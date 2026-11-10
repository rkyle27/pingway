// IGN Card v2.2: claimed characters - the same rules as the website (pingway-dashboard lib/ign.js; keep both in step).
// Used by /ignconfig (Link Lodestone -> claim code -> Verify) and /ign (shows the Main).
//
// Claim: the user gets a code "pingway-" + 12 random characters (crypto-random, no look-alike characters such as 0/o, 1/l/i),
// pastes it anywhere in their Lodestone profile text, then Pingway reads the Lodestone character page and looks for it.
//   - a code belongs to one Discord user + one character, is valid for 24 hours and works once;
//   - checks are rate-limited in the database (one check every 15 seconds per code, 30 checks per code, 10 new codes a day),
//     so it works the same on every website instance and in the bot;
//   - one character belongs to one Discord user: a new verified claim moves it (it is removed from the other account).
// Characters: table ign_characters, one row per claimed character (up to 2 free, 20 with Supporter Perks on).
// Exactly one is the Main; user_ign_config (the table /ign and /ignconfig have always used) is kept as a copy of the Main,
// so /ign shows the Main and older bot code keeps working.
// Older data: a user_ign_config row from before v2.2 becomes that user's Main character ("not verified" until they claim it;
// it keeps working exactly as before). Perks ended: every saved character stays and can still be edited, only new claims
// beyond the free 2 are refused.

const crypto = require('crypto');

const PREFIX = 'pingway-';
const CODE_CHARS = '23456789abcdefghjkmnpqrstuvwxyz'; // no 0 o 1 l i
const CODE_LEN = 12;
const CODE_RE = new RegExp('^' + PREFIX + '[' + CODE_CHARS + ']{' + CODE_LEN + '}$');
const CODE_TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_GAP_MS = 15 * 1000;
const CHECKS_MAX = 30;
const CODES_PER_DAY = 10;
const LIMITS = { free: 2, perks: 20 };
const ID_RE = /^\d{1,20}$/;

function newCode() {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    return PREFIX + s;
}
const isCode = s => typeof s === 'string' && CODE_RE.test(s);
const limitsFor = perks => ({ free: LIMITS.free, perks: LIMITS.perks, max: perks ? LIMITS.perks : LIMITS.free });
const lodestoneUrl = id => 'https://na.finalfantasyxiv.com/lodestone/character/' + id + '/';

// ---------- Lodestone character page ----------
function decode(s) {
    return String(s || '')
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } })
        .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch (e) { return ''; } })
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}
const textOf = html => decode(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
const firstMatch = (html, re) => { const m = re.exec(html); return m ? textOf(m[1]) : ''; };

/**
 * Lodestone character page -> { state, name, world, bio }
 * state: 'ok' | 'private' (profile hidden) | 'notfound' (no such character) | 'error' (Lodestone down / unexpected page)
 * Same selectors as /ign (commands/ign.js): .frame__chara__name, .frame__chara__world; the profile text is .character__selfintroduction.
 */
function parseCharacterPage(html, httpStatus) {
    if (httpStatus === 404) return { state: 'notfound', name: '', world: '', bio: '' };
    if (!html || (httpStatus && httpStatus !== 200)) return { state: 'error', name: '', world: '', bio: '' };
    const page = String(html);
    const name = firstMatch(page, /<p class="frame__chara__name">([\s\S]*?)<\/p>/);
    const world = firstMatch(page, /<p class="frame__chara__world">([\s\S]*?)<\/p>/);
    const bioM = /<div class="character__selfintroduction">([\s\S]*?)<\/div>/.exec(page);
    const isPrivate = /profile is private|chosen to make (?:their|this) (?:profile|character)[^<]{0,40}private|this character'?s? (?:profile )?is (?:set to )?private/i.test(page) ||
        /class="[^"]*parts__zero[^"]*"[^>]*>[^<]*private/i.test(page);
    if (!bioM && isPrivate) return { state: 'private', name, world, bio: '' };
    if (!name && !bioM) return { state: /not found|could not be found|404/i.test(page) ? 'notfound' : 'error', name: '', world: '', bio: '' };
    return { state: 'ok', name, world, bio: bioM ? textOf(bioM[1]) : '' };
}

// All pingway-xxxx codes written in a text (lowercase)
const codesIn = text => (String(text || '').match(/pingway-[a-z0-9]{12}/gi) || []).map(c => c.toLowerCase());

/** parsed page + code -> 'verified' | 'missing' | 'wrong' (another/old code) | 'private' | 'notfound' | 'error' */
function checkBio(page, code) {
    if (!page || page.state !== 'ok') return page ? page.state : 'error';
    const found = codesIn(page.bio);
    if (found.includes(String(code).toLowerCase())) return 'verified';
    return found.length ? 'wrong' : 'missing';
}

async function fetchCharacterPage(lodestoneId) {
    const axios = require('axios');
    try {
        const res = await axios.get(lodestoneUrl(lodestoneId), {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache'
            },
            timeout: 10000,
            validateStatus: () => true
        });
        return parseCharacterPage(res.status === 200 ? String(res.data || '') : '', res.status);
    } catch (e) {
        return { state: 'error', name: '', world: '', bio: '' };
    }
}

// ---------- database ----------
let ready = false;
async function addColumn(db, table, column, ddl) {
    const [cols] = await db.execute('SHOW COLUMNS FROM ' + table + " LIKE '" + column + "'");
    if (cols.length) return;
    try { await db.execute('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + ddl); } catch (e) {
        if (!(e && (e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060))) throw e;
    }
}
async function ensureTables(db) {
    if (ready) return;
    await db.execute(`CREATE TABLE IF NOT EXISTS ign_characters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        lodestone_id VARCHAR(20) NOT NULL,
        claim_key VARCHAR(20) NULL DEFAULT NULL,
        is_main TINYINT(1) NOT NULL DEFAULT 0,
        position INT NOT NULL DEFAULT 0,
        character_name VARCHAR(64) NULL DEFAULT NULL,
        world VARCHAR(64) NULL DEFAULT NULL,
        main_job VARCHAR(40) NULL DEFAULT NULL,
        portrait_url TEXT NULL,
        full_photo_url TEXT NULL,
        portrait_toggle TINYINT(1) NOT NULL DEFAULT 1,
        tomestone_url TEXT NULL,
        fflogs_url TEXT NULL,
        show_tomestone TINYINT(1) NOT NULL DEFAULT 1,
        show_fflogs TINYINT(1) NOT NULL DEFAULT 1,
        show_photo TINYINT(1) NOT NULL DEFAULT 1,
        verified_at BIGINT NULL DEFAULT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY uq_ign_user_char (user_id, lodestone_id),
        UNIQUE KEY uq_ign_claim (claim_key),
        KEY idx_ign_lodestone (lodestone_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await db.execute(`CREATE TABLE IF NOT EXISTS ign_claim_codes (
        code VARCHAR(24) NOT NULL PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        lodestone_id VARCHAR(20) NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        used_at BIGINT NULL DEFAULT NULL,
        checks INT NOT NULL DEFAULT 0,
        last_check_at BIGINT NULL DEFAULT NULL,
        KEY idx_ign_code_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // The Main's link toggles, copied to user_ign_config for /ign (NULL = on, like before v2.2)
    for (const c of ['show_tomestone', 'show_fflogs', 'show_photo']) await addColumn(db, 'user_ign_config', c, 'TINYINT(1) NULL DEFAULT NULL');
    ready = true;
}

const CHAR_COLS = 'id, user_id, lodestone_id, claim_key, is_main, position, character_name, world, main_job, portrait_url, full_photo_url, ' +
    'portrait_toggle, tomestone_url, fflogs_url, show_tomestone, show_fflogs, show_photo, verified_at';
async function listCharacters(db, uid) {
    const [rows] = await db.execute('SELECT ' + CHAR_COLS + ' FROM ign_characters WHERE user_id = ? ORDER BY position, id', [String(uid)]);
    return rows;
}

// A pre-v2.2 user_ign_config row becomes the user's Main character (once; not verified)
async function migrateUser(db, uid, now) {
    const [[has]] = await db.execute('SELECT COUNT(*) AS n FROM ign_characters WHERE user_id = ?', [String(uid)]);
    if (Number(has && has.n) > 0) return false;
    const [[old]] = await db.execute('SELECT * FROM user_ign_config WHERE user_id = ?', [String(uid)]);
    if (!old || !old.lodestone_id || !ID_RE.test(String(old.lodestone_id))) return false;
    const on = v => (v === null || v === undefined ? 1 : Number(v) ? 1 : 0);
    await db.execute(
        `INSERT IGNORE INTO ign_characters (user_id, lodestone_id, claim_key, is_main, position, main_job, portrait_url, full_photo_url, portrait_toggle,
             tomestone_url, fflogs_url, show_tomestone, show_fflogs, show_photo, verified_at, created_at)
         VALUES (?, ?, NULL, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [String(uid), String(old.lodestone_id), old.main_job || null, old.portrait_url || null, old.full_photo_url || null,
            old.portrait_toggle === null || old.portrait_toggle === undefined ? 1 : (Number(old.portrait_toggle) ? 1 : 0),
            old.tomestone_url || null, old.fflogs_url || null, on(old.show_tomestone), on(old.show_fflogs), on(old.show_photo), now || Date.now()]
    );
    return true;
}

// Exactly one Main while the user has characters (the first one if none is ticked)
async function fixMain(db, uid) {
    const rows = await listCharacters(db, uid);
    if (!rows.length) return null;
    const mains = rows.filter(r => Number(r.is_main) === 1);
    const keep = mains[0] || rows[0];
    if (mains.length === 1 && mains[0] === keep) return keep;
    await db.execute('UPDATE ign_characters SET is_main = 0 WHERE user_id = ? AND id <> ?', [String(uid), keep.id]);
    await db.execute('UPDATE ign_characters SET is_main = 1 WHERE id = ?', [keep.id]);
    return keep;
}

// user_ign_config = a copy of the Main (what /ign shows); no characters left = no card
async function syncMirror(db, uid) {
    const main = await fixMain(db, uid);
    if (!main) { await db.execute('DELETE FROM user_ign_config WHERE user_id = ?', [String(uid)]); return; }
    await db.execute(
        `INSERT INTO user_ign_config (user_id, lodestone_id, main_job, portrait_url, full_photo_url, portrait_toggle, tomestone_url, fflogs_url, show_tomestone, show_fflogs, show_photo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE lodestone_id = VALUES(lodestone_id), main_job = VALUES(main_job), portrait_url = VALUES(portrait_url),
             full_photo_url = VALUES(full_photo_url), portrait_toggle = VALUES(portrait_toggle), tomestone_url = VALUES(tomestone_url),
             fflogs_url = VALUES(fflogs_url), show_tomestone = VALUES(show_tomestone), show_fflogs = VALUES(show_fflogs), show_photo = VALUES(show_photo)`,
        [String(uid), String(main.lodestone_id), main.main_job || null, main.portrait_url || null, main.full_photo_url || null, Number(main.portrait_toggle) ? 1 : 0,
            main.tomestone_url || null, main.fflogs_url || null, Number(main.show_tomestone) ? 1 : 0, Number(main.show_fflogs) ? 1 : 0, Number(main.show_photo) ? 1 : 0]
    );
}

function publicCharacter(r) {
    return {
        lodestoneId: String(r.lodestone_id), name: r.character_name || '', world: r.world || '',
        verified: !!r.claim_key, main: Number(r.is_main) === 1,
        mainJob: r.main_job || '', portraitUrl: r.portrait_url || '', fullPhotoUrl: r.full_photo_url || '', portraitToggle: Number(r.portrait_toggle) === 1,
        tomestoneUrl: r.tomestone_url || '', fflogsUrl: r.fflogs_url || '',
        showTomestone: Number(r.show_tomestone) === 1, showFflogs: Number(r.show_fflogs) === 1, showPhoto: Number(r.show_photo) === 1
    };
}

async function withTx(pool, fn) {
    const conn = pool.getConnection ? await pool.getConnection() : null;
    const db = conn || pool;
    try {
        if (conn) await conn.beginTransaction();
        const out = await fn(db);
        if (conn) await conn.commit();
        return out;
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

/**
 * New claim code for a character -> { ok: true, code, expiresAt, lodestoneId } or { ok: false, reason, ... }
 * reasons: badId, alreadyYours, limit (free/max), tooManyCodes. An open code for the same character is given again.
 */
async function startClaim(pool, uid, lodestoneId, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const id = String(lodestoneId || '');
    if (!ID_RE.test(id)) return { ok: false, reason: 'badId' };
    await ensureTables(pool);
    await migrateUser(pool, uid, now);
    const rows = await listCharacters(pool, uid);
    const mine = rows.find(r => String(r.lodestone_id) === id);
    if (mine && mine.claim_key) return { ok: false, reason: 'alreadyYours' };
    const L = limitsFor(!!o.perks);
    if (!mine && rows.length >= L.max) return { ok: false, reason: 'limit', free: L.free, max: L.perks, perks: !!o.perks };
    const [[open]] = await pool.execute(
        'SELECT code, expires_at FROM ign_claim_codes WHERE user_id = ? AND lodestone_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
        [String(uid), id, now]
    );
    if (open) return { ok: true, code: String(open.code), expiresAt: Number(open.expires_at), lodestoneId: id, again: true };
    const [[cnt]] = await pool.execute('SELECT COUNT(*) AS n FROM ign_claim_codes WHERE user_id = ? AND created_at > ?', [String(uid), now - 24 * 60 * 60 * 1000]);
    if (Number(cnt && cnt.n) >= CODES_PER_DAY) return { ok: false, reason: 'tooManyCodes' };
    await pool.execute('DELETE FROM ign_claim_codes WHERE expires_at < ?', [now - 7 * 24 * 60 * 60 * 1000]);
    for (let attempt = 0; attempt < 3; attempt++) {
        const code = newCode();
        try {
            await pool.execute('INSERT INTO ign_claim_codes (code, user_id, lodestone_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
                [code, String(uid), id, now, now + CODE_TTL_MS]);
            return { ok: true, code, expiresAt: now + CODE_TTL_MS, lodestoneId: id, again: false };
        } catch (e) {
            if (!(e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062))) throw e;
        }
    }
    throw new Error('could not make a claim code');
}

/**
 * Checks a code on the Lodestone and claims the character -> { ok: true, lodestoneId, name, moved } or { ok: false, reason }
 * code: the code (website), or null = the user's newest open code (Discord). opts: { perks, now, fetchPage(id) }
 * reasons: noCode, used, expired, wait (seconds), tooManyChecks, notfound, private, missing, wrong, error, limit
 */
async function checkClaim(pool, uid, code, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    await ensureTables(pool);
    const [[row]] = code
        ? await pool.execute('SELECT code, user_id, lodestone_id, expires_at, used_at, checks, last_check_at FROM ign_claim_codes WHERE code = ? AND user_id = ?', [String(code), String(uid)])
        : await pool.execute('SELECT code, user_id, lodestone_id, expires_at, used_at, checks, last_check_at FROM ign_claim_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1', [String(uid)]);
    if (!row) return { ok: false, reason: 'noCode' };
    if (row.used_at !== null && row.used_at !== undefined) return { ok: false, reason: 'used' };
    if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' };
    const last = row.last_check_at === null || row.last_check_at === undefined ? null : Number(row.last_check_at);
    if (last !== null && now - last < CHECK_GAP_MS) return { ok: false, reason: 'wait', seconds: Math.ceil((CHECK_GAP_MS - (now - last)) / 1000) };
    if (Number(row.checks) >= CHECKS_MAX) return { ok: false, reason: 'tooManyChecks' };
    // counts the check first; two checks at the same moment: only one goes through
    const [upd] = await pool.execute(
        'UPDATE ign_claim_codes SET checks = checks + 1, last_check_at = ? WHERE code = ? AND used_at IS NULL AND (last_check_at IS NULL OR last_check_at <= ?)',
        [now, String(row.code), now - CHECK_GAP_MS]
    );
    if (upd && upd.affectedRows === 0) return { ok: false, reason: 'wait', seconds: Math.ceil(CHECK_GAP_MS / 1000) };
    const id = String(row.lodestone_id);
    const page = await (o.fetchPage || fetchCharacterPage)(id);
    const state = checkBio(page, row.code);
    if (state !== 'verified') return { ok: false, reason: state, lodestoneId: id, code: String(row.code) };

    const L = limitsFor(!!o.perks);
    return withTx(pool, async db => {
        // the other accounts that had this character lose it (also an older, not verified card)
        const [a] = await db.execute('SELECT DISTINCT user_id FROM ign_characters WHERE lodestone_id = ? AND user_id <> ?', [id, String(uid)]);
        const [b] = await db.execute('SELECT user_id FROM user_ign_config WHERE lodestone_id = ? AND user_id <> ?', [id, String(uid)]);
        const others = [...new Set([...a, ...b].map(x => String(x.user_id)))];
        await migrateUser(db, uid, now);
        const rows = await listCharacters(db, uid);
        const mine = rows.find(r => String(r.lodestone_id) === id);
        if (!mine && rows.length >= L.max) return { ok: false, reason: 'limit', free: L.free, max: L.perks, perks: !!o.perks };
        const [used] = await db.execute('UPDATE ign_claim_codes SET used_at = ? WHERE code = ? AND used_at IS NULL', [now, String(row.code)]);
        if (used && used.affectedRows === 0) return { ok: false, reason: 'used' };
        for (const other of others) {
            await migrateUser(db, other, now);
            await db.execute('DELETE FROM ign_characters WHERE user_id = ? AND lodestone_id = ?', [other, id]);
            await syncMirror(db, other);
        }
        const name = String(page.name || '').slice(0, 64) || null;
        const world = String(page.world || '').slice(0, 64) || null;
        if (mine) {
            await db.execute('UPDATE ign_characters SET claim_key = ?, verified_at = ?, character_name = ?, world = ? WHERE id = ?', [id, now, name, world, mine.id]);
        } else {
            const pos = rows.reduce((m, r) => Math.max(m, Number(r.position) || 0), -1) + 1;
            await db.execute(
                `INSERT INTO ign_characters (user_id, lodestone_id, claim_key, is_main, position, character_name, world, portrait_toggle, show_tomestone, show_fflogs, show_photo, verified_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, ?)`,
                [String(uid), id, id, rows.length ? 0 : 1, pos, name, world, now, now]
            );
        }
        if (o.makeMain) await setMainRow(db, uid, id);
        await syncMirror(db, uid);
        return { ok: true, lodestoneId: id, name: name || '', moved: others.length > 0 };
    });
}

async function setMainRow(db, uid, lodestoneId) {
    await db.execute('UPDATE ign_characters SET is_main = (lodestone_id = ?) WHERE user_id = ?', [String(lodestoneId), String(uid)]);
}

/** Removes one of the user's characters (the next one becomes Main if it was the Main) -> true if it was there */
async function unclaim(pool, uid, lodestoneId) {
    await ensureTables(pool);
    return withTx(pool, async db => {
        await migrateUser(db, uid);
        const [res] = await db.execute('DELETE FROM ign_characters WHERE user_id = ? AND lodestone_id = ?', [String(uid), String(lodestoneId)]);
        await syncMirror(db, uid);
        return !!(res && res.affectedRows);
    });
}

/**
 * After /ignconfig saved user_ign_config: copy its fields to that character (it becomes the Main, since /ignconfig edits
 * the card /ign shows). If that character is no longer the user's (unclaimed or moved meanwhile), the copy is set back
 * from the real Main.
 */
async function syncFromConfig(pool, uid) {
    await ensureTables(pool);
    return withTx(pool, async db => {
        await migrateUser(db, uid);
        const [[cfg]] = await db.execute('SELECT * FROM user_ign_config WHERE user_id = ?', [String(uid)]);
        const rows = await listCharacters(db, uid);
        const row = cfg && rows.find(r => String(r.lodestone_id) === String(cfg.lodestone_id));
        if (row) {
            await db.execute(
                'UPDATE ign_characters SET main_job = ?, portrait_url = ?, full_photo_url = ?, portrait_toggle = ?, tomestone_url = ?, fflogs_url = ? WHERE id = ?',
                [cfg.main_job || null, cfg.portrait_url || null, cfg.full_photo_url || null, Number(cfg.portrait_toggle) ? 1 : 0, cfg.tomestone_url || null, cfg.fflogs_url || null, row.id]
            );
            await setMainRow(db, uid, row.lodestone_id);
        }
        if (rows.length) await syncMirror(db, uid);
        return !!row;
    });
}

/** Makes one of the user's characters the Main (= what /ign shows) */
async function setMain(pool, uid, lodestoneId) {
    await ensureTables(pool);
    return withTx(pool, async db => {
        await setMainRow(db, uid, lodestoneId);
        await syncMirror(db, uid);
    });
}

/** The card /ign draws for a user_ign_config row: links / custom image switched off on the website are left out (NULL = on) */
function cardConfig(row) {
    const off = v => v !== null && v !== undefined && Number(v) === 0;
    const c = Object.assign({}, row);
    if (off(row.show_tomestone)) c.tomestone_url = null;
    if (off(row.show_fflogs)) c.fflogs_url = null;
    if (off(row.show_photo)) c.full_photo_url = null;
    // no custom image and no portrait would leave an empty card: the portrait comes back
    if (!c.full_photo_url && !c.portrait_toggle) c.portrait_toggle = 1;
    return c;
}

module.exports = {
    syncFromConfig, cardConfig, setMain,
    PREFIX, CODE_CHARS, CODE_LEN, CODE_RE, CODE_TTL_MS, CHECK_GAP_MS, CHECKS_MAX, CODES_PER_DAY, LIMITS, ID_RE,
    newCode, isCode, limitsFor, lodestoneUrl, parseCharacterPage, codesIn, checkBio, fetchCharacterPage,
    ensureTables, listCharacters, migrateUser, fixMain, syncMirror, publicCharacter, startClaim, checkClaim, setMainRow, unclaim, withTx,
    _reset() { ready = false; }
};
