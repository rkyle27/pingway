// Console: Google voice credits and console memberships (mybot.js "kofi ..." commands). Amounts are in CREDITS:
//   $1 = 100 credits, 1 credit = 2,000 characters (about 50 messages). The database keeps exact characters
//   (tts_char_lots); credits shown = floor(characters / 2,000).
//
//   kofi <id>                      read only: credits left, each batch, member status, Google switch, nickname, max chars
//   kofi give <id> <credits>       new batch (kofi_tx 'console-<ms>-<random>'), expires CREDIT_VALIDITY_DAYS (default 180, 0 = never)
//   kofi remove <id> <credits>     takes characters off, oldest-expiring batch first (expired ones skipped), never below 0
//   kofi member <id> <days|off>    voice_user_settings.member_until = now + days (1-3650) / NULL
//
// The website (lib/voice.js) counts a user as an active member with a Ko-fi membership payment in the last 35 days
// OR member_until > now. Tables: same DDL as the website (./ddl.js, identical to the website's lib/voiceDdl.js).
// The bot caches balances for up to a minute (members.js), so a change reaches running calls within a minute.

const crypto = require('crypto');
const { createVoiceTables } = require('./ddl');

const CHARS_PER_CREDIT = 2000;
const MAX_CREDITS = 1000000;
const MAX_DAYS = 3650;
const MEMBER_ACTIVE_DAYS = 35;
const DAY_MS = 864e5;
const ID_RE = /^\d{15,22}$/;
const USAGE = '[CONSOLE] Usage: kofi <id> | kofi give <id> <credits> | kofi remove <id> <credits> | kofi member <id> <days|off>' +
    '   (credits 1-1000000, days 1-3650; $1 = 100 credits, 1 credit = 2,000 characters)';

/** Same setting and meaning as the website (lib/credits.js): days credits last, 0 = never expire, default 180. */
function validityDays() {
    const n = Number(process.env.CREDIT_VALIDITY_DAYS);
    return Number.isFinite(n) && n >= 0 ? n : 180;
}

const creditsOf = chars => Math.floor(Math.max(0, Number(chars) || 0) / CHARS_PER_CREDIT);
const fmt = n => Number(n || 0).toLocaleString('en-US');
const creditText = chars => {
    const c = creditsOf(chars);
    return fmt(c) + ' credit' + (c === 1 ? '' : 's') + ' (' + fmt(chars) + ' characters)';
};
const jst = ms => new Date(Number(ms) + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' JST';
const consoleTxId = (now, hex) => 'console-' + now + '-' + hex;
const isConsoleTx = tx => /^console-/.test(String(tx || ''));
const missingTable = err => !!err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist|no such table/i.test(String(err.message)));
const posInt = (s, max) => /^\d{1,7}$/.test(String(s)) && Number(s) >= 1 && Number(s) <= max ? Number(s) : null;

/** args (lowercase words after "kofi") -> { cmd, id, credits?, days?, off? } or null (bad input). */
function parseArgs(args = []) {
    const a = args.filter(Boolean).map(s => String(s).toLowerCase());
    if (a.length === 1 && ID_RE.test(a[0])) return { cmd: 'read', id: a[0] };
    if (a.length !== 3 || !ID_RE.test(a[1])) return null;
    if (a[0] === 'give' || a[0] === 'remove') {
        const credits = posInt(a[2], MAX_CREDITS);
        return credits ? { cmd: a[0], id: a[1], credits } : null;
    }
    if (a[0] === 'member') {
        if (a[2] === 'off') return { cmd: 'member', id: a[1], off: true };
        const days = posInt(a[2], MAX_DAYS);
        return days ? { cmd: 'member', id: a[1], days } : null;
    }
    return null;
}

let tablesReady = false;
async function ensureTables(pool) {
    if (tablesReady) return;
    await createVoiceTables(pool);
    tablesReady = true;
}

async function label(client, id) {
    let name = null;
    try {
        const u = client && client.users ? await client.users.fetch(id) : null;
        name = u && u.username ? u.username : null;
    } catch { /* unknown user / no access: just the id */ }
    return name ? id + ' (' + name + ')' : id;
}

async function balance(db, id, now) {
    const [rows] = await db.execute(
        'SELECT COALESCE(SUM(chars_left), 0) AS left_ FROM tts_char_lots WHERE user_id = ? AND chars_left > 0 AND (expires_at = 0 OR expires_at > ?)',
        [id, now]
    );
    return Number(rows && rows[0] && rows[0].left_) || 0;
}

/** Latest credited Ko-fi membership payment in the last 35 days (ms) or null. */
async function kofiMemberSince(db, id, now) {
    try {
        const [rows] = await db.execute(
            "SELECT created_at FROM kofi_payments WHERE user_id = ? AND status = 'credited' AND LOWER(type) = 'subscription' AND created_at > ? ORDER BY created_at DESC LIMIT 1",
            [id, now - MEMBER_ACTIVE_DAYS * DAY_MS]
        );
        return rows && rows[0] ? Number(rows[0].created_at) : null;
    } catch (err) {
        if (missingTable(err)) return null;
        throw err;
    }
}

async function readUser(db, id, who, now, out) {
    const [lots] = await db.execute(
        'SELECT chars_left, kofi_tx, expires_at FROM tts_char_lots WHERE user_id = ? AND chars_left > 0 AND (expires_at = 0 OR expires_at > ?) ORDER BY (expires_at = 0), expires_at, id',
        [id, now]
    );
    const [[row]] = await db.execute('SELECT google_on, nickname, max_chars, member_until FROM voice_user_settings WHERE user_id = ?', [id]);
    const kofiAt = await kofiMemberSince(db, id, now);
    const total = lots.reduce((s, l) => s + Number(l.chars_left), 0);
    out.push('🔊 [KOFI] ' + who);
    out.push('  Google voice credits left: ' + creditText(total));
    if (lots.length) {
        out.push('  Batches (used oldest-expiring first):');
        lots.forEach((l, i) => out.push('    ' + (i + 1) + '. ' + creditText(l.chars_left) + ' | ' +
            (isConsoleTx(l.kofi_tx) ? 'console' : l.kofi_tx ? 'Ko-fi payment' : 'unknown source') + ' | ' +
            (Number(l.expires_at) > 0 ? 'expires ' + jst(l.expires_at) : 'never expires')));
    } else {
        out.push('  Batches: none');
    }
    const until = row && row.member_until !== null && row.member_until !== undefined ? Number(row.member_until) : null;
    const member = [];
    if (kofiAt) member.push('Ko-fi membership payment on ' + jst(kofiAt) + ' (counts until ' + jst(kofiAt + MEMBER_ACTIVE_DAYS * DAY_MS) + ')');
    if (until && until > now) member.push('console member until ' + jst(until));
    out.push('  Member: ' + (member.length ? 'YES - ' + member.join(' + ') : 'no' + (until ? ' (console membership ended ' + jst(until) + ')' : '')));
    const googleOn = !(row && row.google_on !== null && row.google_on !== undefined && Number(row.google_on) === 0);
    out.push('  Google switch (My Settings): ' + (googleOn ? 'ON' : 'OFF') + (row ? '' : ' (default, nothing saved)'));
    out.push('  Nickname: ' + (row && row.nickname ? row.nickname : 'not set (their Discord name)'));
    const max = row && row.max_chars !== null && row.max_chars !== undefined ? Number(row.max_chars) : null;
    out.push('  Max characters per message: ' + (max && Number.isInteger(max) && max >= 20 && max <= 200 ? max : '200 (default)'));
}

async function give(db, id, who, credits, now, hex, out) {
    const chars = credits * CHARS_PER_CREDIT;
    const days = validityDays();
    const expires = days > 0 ? now + days * DAY_MS : 0;
    const tx = consoleTxId(now, hex);
    await db.execute(
        'INSERT INTO tts_char_lots (user_id, chars_total, chars_left, kofi_tx, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, chars, chars, tx, now, expires]
    );
    const left = await balance(db, id, now);
    out.push('🔊 [KOFI] Gave ' + creditText(chars) + ' to ' + who + ', ' + (expires ? 'expires ' + jst(expires) : 'never expires') +
        ' (' + tx + '). Balance now: ' + creditText(left) + '.');
}

// Oldest-expiring batch first, expired ones skipped, never below zero, one transaction with row locks.
async function remove(pool, id, who, credits, now, out) {
    const want = credits * CHARS_PER_CREDIT;
    const conn = await pool.getConnection();
    let removed = 0;
    try {
        await conn.beginTransaction();
        const [lots] = await conn.execute(
            'SELECT id, chars_left FROM tts_char_lots WHERE user_id = ? AND chars_left > 0 AND (expires_at = 0 OR expires_at > ?) ORDER BY (expires_at = 0), expires_at, id FOR UPDATE',
            [id, now]
        );
        for (const lot of lots) {
            if (removed >= want) break;
            const take = Math.min(want - removed, Number(lot.chars_left));
            if (take <= 0) continue;
            await conn.execute('UPDATE tts_char_lots SET chars_left = chars_left - ? WHERE id = ? AND chars_left >= ?', [take, lot.id, take]);
            removed += take;
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
    const left = await balance(pool, id, now);
    out.push('🔊 [KOFI] Removed ' + creditText(removed) + ' from ' + who +
        (removed < want ? ' (asked for ' + fmt(credits) + ' credits, only ' + fmt(removed) + ' characters were left)' : '') +
        '. Balance now: ' + creditText(left) + '.');
}

async function member(db, id, who, p, now, out) {
    if (p.off) {
        const [[row]] = await db.execute('SELECT member_until FROM voice_user_settings WHERE user_id = ?', [id]);
        const was = row && row.member_until !== null && row.member_until !== undefined ? Number(row.member_until) : null;
        await db.execute('UPDATE voice_user_settings SET member_until = NULL WHERE user_id = ?', [id]);
        const kofiAt = await kofiMemberSince(db, id, now);
        out.push('🔊 [KOFI] Console membership OFF for ' + who +
            (was && was > now ? ' (it was until ' + jst(was) + ')' : ' (they had none)') + '.' +
            (kofiAt ? ' They still count as a member through their Ko-fi membership payment until ' + jst(kofiAt + MEMBER_ACTIVE_DAYS * DAY_MS) + '.' : ''));
        return;
    }
    const until = now + p.days * DAY_MS;
    await db.execute(
        'INSERT INTO voice_user_settings (user_id, google_on, nickname, max_chars, updated_at, member_until) VALUES (?, 1, NULL, NULL, ?, ?) ON DUPLICATE KEY UPDATE member_until = VALUES(member_until)',
        [id, now, until]
    );
    out.push('🔊 [KOFI] Console membership ON for ' + who + ': ' + p.days + ' day' + (p.days === 1 ? '' : 's') + ', until ' + jst(until) + '.');
}

/**
 * Console "kofi ..." (mybot.js). Prints and returns the lines.
 * deps: { client (Discord, for the username), getPool, now, randomHex, log, error } (tests pass fakes)
 */
async function kofiConsole(args = [], deps = {}) {
    const out = [];
    const log = deps.log || (l => console.log(l));
    const p = parseArgs(args);
    if (!p) {
        out.push(USAGE);
        out.forEach(l => log(l));
        return out;
    }
    const now = deps.now !== undefined ? deps.now : Date.now();
    const getPool = deps.getPool || (() => require('../db').pool);
    try {
        const pool = getPool();
        await ensureTables(pool);
        const who = await label(deps.client, p.id);
        if (p.cmd === 'read') await readUser(pool, p.id, who, now, out);
        else if (p.cmd === 'give') await give(pool, p.id, who, p.credits, now, deps.randomHex ? deps.randomHex() : crypto.randomBytes(4).toString('hex'), out);
        else if (p.cmd === 'remove') await remove(pool, p.id, who, p.credits, now, out);
        else await member(pool, p.id, who, p, now, out);
    } catch (err) {
        const line = '❌ [KOFI] Failed: ' + (err.code ? err.code + ' ' : '') + err.message;
        (deps.error || (l => console.error(l)))(line);
        out.push(line);
        return out;
    }
    out.forEach(l => log(l));
    return out;
}

/** Tests: run the table check again. */
function _reset() {
    tablesReady = false;
}

module.exports = {
    CHARS_PER_CREDIT, MAX_CREDITS, MAX_DAYS, USAGE,
    validityDays, creditsOf, consoleTxId, isConsoleTx, parseArgs, ensureTables, kofiConsole, _reset
};
