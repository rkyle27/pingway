// Pingway Trivia: word bank, database and game steps for /trivia (the screens are in commands/trivia.js).
// - Word bank: built from XIVAPI (jobs, cities, zones, dungeons, trials, raids, mounts, minions, actions, items)
//   and kept in data/trivia_bank.json. Rebuilt in the background when it is missing or older than 30 days.
//   If a rebuild fails, the old bank stays in use.
// - Each word has a short "lore" text (XIVAPI descriptions, or an info line for jobs and places), shown only after
//   a solve. It is copied into trivia_words with the word, so it never changes during the day.
// - Word of the day: one per difficulty, the same for everyone. Saved in trivia_words the first time it is
//   needed, so it never changes during the day (even if the bank is rebuilt). A word isn't used again for
//   the same difficulty within 90 days.
// - One solve per person per JST day, in all servers. Giving up or running out of guesses locks that difficulty
//   for the day; another one can still be tried. Games in progress are saved, so /trivia continues them anywhere.
// - Stored per person (trivia_users): display name and avatar for the leaderboards, bits (all time and this
//   month), streak, last solve day and "hide me" (set on the website). trivia_players: who played in which server
//   (a server's leaderboard). trivia_guild: the share channel an admin picked on the website.
// - Old games (trivia_plays) and old words are deleted after 100 days.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pool } = require('./db');
const W = require('./triviaWords');

const XIV = 'https://v2.xivapi.com/api';
const BANK_FILE = path.join(__dirname, '..', 'data', 'trivia_bank.json');
const BANK_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const NO_REPEAT_DAYS = 90;
const KEEP_DAYS = 100;
const MIN_POOL = 15;

let tablesReady = false;
let bank = null;          // { builtAt, pools }
let building = null;      // Promise while a rebuild runs

async function ensureTables() {
    if (tablesReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS trivia_words (
        day CHAR(10) NOT NULL,
        difficulty VARCHAR(10) NOT NULL,
        word VARCHAR(64) NOT NULL,
        category VARCHAR(32) NOT NULL DEFAULT '',
        hints TEXT,
        lore TEXT,
        created_at BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (day, difficulty)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS trivia_plays (
        user_id VARCHAR(32) NOT NULL,
        day CHAR(10) NOT NULL,
        difficulty VARCHAR(10) NOT NULL,
        status VARCHAR(8) NOT NULL DEFAULT 'playing',
        wrong INT NOT NULL DEFAULT 0,
        hints_used TEXT,
        revealed TEXT,
        bits INT NOT NULL DEFAULT 0,
        guild_id VARCHAR(32) DEFAULT NULL,
        started_at BIGINT NOT NULL DEFAULT 0,
        finished_at BIGINT DEFAULT NULL,
        shared TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day, difficulty),
        KEY idx_day (day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS trivia_users (
        user_id VARCHAR(32) PRIMARY KEY,
        display_name VARCHAR(64) DEFAULT NULL,
        avatar VARCHAR(64) DEFAULT NULL,
        bits_total INT NOT NULL DEFAULT 0,
        season_key CHAR(7) DEFAULT NULL,
        season_bits INT NOT NULL DEFAULT 0,
        streak INT NOT NULL DEFAULT 0,
        last_solve_day CHAR(10) DEFAULT NULL,
        hidden TINYINT(1) NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS trivia_players (
        guild_id VARCHAR(32) NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        last_played BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS trivia_guild (
        guild_id VARCHAR(32) PRIMARY KEY,
        share_channel_id VARCHAR(32) DEFAULT NULL,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    tablesReady = true;
}

const parseList = v => {
    if (Array.isArray(v)) return v;
    try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch (e) { return []; }
};

// ---------- word bank ----------
function loadBankFile() {
    try {
        const b = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
        if (b && b.pools && W.DIFFICULTIES.every(d => Array.isArray(b.pools[d.key]) && b.pools[d.key].length)) return b;
    } catch (e) { /* missing or broken */ }
    return null;
}
function getBank() {
    if (!bank) bank = loadBankFile();
    return bank;
}
const bankIsOld = b => !b || !Number(b.builtAt) || Date.now() - Number(b.builtAt) > BANK_MAX_AGE;

async function getJson(url) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const r = await axios.get(url, { timeout: 20000 });
            return r.data;
        } catch (err) {
            lastErr = err;
            await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
        }
    }
    throw lastErr;
}
const pause = ms => new Promise(res => setTimeout(res, ms));

// Every row of a sheet, 500 at a time
async function sheetRows(sheet, fields, maxPages = 200) {
    const out = [];
    let after = null;
    for (let page = 0; page < maxPages; page++) {
        const url = XIV + '/sheet/' + sheet + '?limit=500&fields=' + encodeURIComponent(fields) + (after !== null ? '&after=' + after : '');
        const data = await getJson(url);
        const rows = (data && Array.isArray(data.rows)) ? data.rows : [];
        if (!rows.length) break;
        out.push(...rows);
        after = rows[rows.length - 1].row_id;
        await pause(150);
    }
    return out;
}
// Every result of a search
async function searchRows(sheet, query, fields, maxPages = 40) {
    const out = [];
    let url = XIV + '/search?sheets=' + sheet + '&query=' + encodeURIComponent(query) + '&fields=' + encodeURIComponent(fields) + '&limit=500';
    for (let page = 0; page < maxPages && url; page++) {
        const data = await getJson(url);
        const rows = (data && Array.isArray(data.results)) ? data.results : [];
        out.push(...rows);
        if (!rows.length || !data.next) break;
        url = XIV + '/search?cursor=' + encodeURIComponent(data.next) + '&limit=500';
        await pause(150);
    }
    return out;
}

async function buildBank() {
    const raw = {
        classJobs: await sheetRows('ClassJob', 'Name,Abbreviation,Role,ClassJobParent.Name,JobIndex'),
        territories: await sheetRows('TerritoryType', 'PlaceName.Name,PlaceNameRegion.Name,ExVersion.Name,TerritoryIntendedUse'),
        content: await sheetRows('ContentFinderCondition', 'Name,ContentType.Name,ClassJobLevelRequired,TerritoryType.PlaceName.Name,TerritoryType.ExVersion.Name'),
        contentLore: await sheetRows('ContentFinderConditionTransient', 'Description'),
        mounts: await sheetRows('Mount', 'Singular'),
        mountLore: await sheetRows('MountTransient', 'Description,DescriptionEnhanced,Tooltip'),
        minions: await sheetRows('Companion', 'Singular'),
        minionLore: await sheetRows('CompanionTransient', 'Description,DescriptionEnhanced,Tooltip'),
        actions: await searchRows('Action', '+IsPlayerAction=true +IsPvP=false', 'Name,ClassJob.Name,ClassJobLevel,IsPvP,IsPlayerAction'),
        items: await sheetRows('Item', 'Name,Description,ItemSearchCategory,LevelItem,ItemUICategory.Name')
    };
    // Lore of actions: only the rows of the actions found above (ActionTransient has the same row_id)
    const actionIds = new Set(raw.actions.map(r => Number(r.row_id)));
    raw.actionLore = (await sheetRows('ActionTransient', 'Description', 400)).filter(r => actionIds.has(Number(r.row_id)));
    const pools = W.buildPools(raw);
    const small = W.DIFFICULTIES.filter(d => pools[d.key].length < MIN_POOL).map(d => d.name);
    if (small.length) throw new Error('too few words for ' + small.join(', '));
    const b = { builtAt: Date.now(), pools };
    fs.mkdirSync(path.dirname(BANK_FILE), { recursive: true });
    const tmp = BANK_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(b));
    fs.renameSync(tmp, BANK_FILE);
    bank = b;
    console.log('🧩 [TRIVIA] Word bank ready: ' + W.DIFFICULTIES.map(d => d.name + ' ' + pools[d.key].length).join(', ') + '.');
    return b;
}
// Starts a rebuild when the bank is missing or old (only one at a time). Never throws.
function refreshBank() {
    if (building) return building;
    if (!bankIsOld(getBank())) return Promise.resolve(bank);
    building = buildBank().catch(err => {
        console.error('⚠️ [TRIVIA] Word bank rebuild failed' + (getBank() ? ' (keeping the old one)' : '') + ':', err.message);
        return getBank();
    }).finally(() => { building = null; });
    return building;
}

// ---------- words of the day ----------
// Makes sure all 6 words of `day` are saved, then returns them by difficulty (null when the bank isn't ready)
async function wordsOf(day) {
    await ensureTables();
    const read = async () => {
        const [rows] = await pool.execute('SELECT difficulty, word, category, hints, lore FROM trivia_words WHERE day = ?', [day]);
        const out = {};
        for (const r of rows) out[r.difficulty] = { word: r.word, category: r.category, hints: parseList(r.hints), lore: r.lore || '' };
        return out;
    };
    let words = await read();
    if (W.DIFFICULTIES.every(d => words[d.key])) return words;
    const b = getBank();
    if (!b) return null;
    const [recent] = await pool.execute('SELECT day, difficulty, word FROM trivia_words WHERE day >= ? AND day <> ?', [W.addDays(day, -NO_REPEAT_DAYS), day]);
    const today = new Set(Object.values(words).map(w => W.fold(w.word)));
    for (const d of W.DIFFICULTIES) {
        if (words[d.key]) continue;
        // Small pools run out before 90 days: then only the most recent words are skipped (the oldest come back first)
        const used = recent.filter(r => r.difficulty === d.key).sort((a, b) => (a.day < b.day ? 1 : -1)).map(r => W.fold(r.word));
        const avoid = new Set([...today, ...used.slice(0, Math.max(0, b.pools[d.key].length - 1 - today.size))]);
        const e = W.pickWord(b.pools[d.key], day, d.key, avoid);
        if (!e) return null;
        today.add(W.fold(e.word));
        await pool.execute('INSERT IGNORE INTO trivia_words (day, difficulty, word, category, hints, lore, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [day, d.key, e.word, e.category || '', JSON.stringify(e.hints || []), W.cleanLore(e.lore || ''), Date.now()]);
    }
    words = await read();
    return W.DIFFICULTIES.every(d => words[d.key]) ? words : null;
}
// Yesterday's answers (only after the day is over)
async function yesterdayAnswers(today) {
    await ensureTables();
    const [rows] = await pool.execute('SELECT difficulty, word FROM trivia_words WHERE day = ?', [W.addDays(today, -1)]);
    const out = {};
    for (const r of rows) out[r.difficulty] = r.word;
    return out;
}

// ---------- people ----------
const cleanName = s => String(s || '').replace(/[\u0000-\u001f​-‏‪-‮]/g, '').trim().slice(0, 64) || 'Player';
const cleanAvatar = a => (typeof a === 'string' && /^(a_)?[a-f0-9]{32}$/.test(a)) ? a : null;

// Saves name/avatar (for leaderboards) and, in a server, that this person plays there
async function touchPlayer({ userId, guildId, displayName, avatar }) {
    await ensureTables();
    const now = Date.now();
    await pool.execute(
        'INSERT INTO trivia_users (user_id, display_name, avatar, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), avatar = VALUES(avatar)',
        [String(userId), cleanName(displayName), cleanAvatar(avatar), now]
    );
    if (guildId) {
        await pool.execute('INSERT INTO trivia_players (guild_id, user_id, last_played) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_played = VALUES(last_played)',
            [String(guildId), String(userId), now]);
    }
}
async function getUser(userId) {
    await ensureTables();
    const [[u]] = await pool.execute('SELECT * FROM trivia_users WHERE user_id = ?', [String(userId)]);
    return u || null;
}
async function shareChannel(guildId) {
    if (!guildId) return null;
    await ensureTables();
    const [[g]] = await pool.execute('SELECT share_channel_id FROM trivia_guild WHERE guild_id = ?', [String(guildId)]);
    return g && g.share_channel_id ? String(g.share_channel_id) : null;
}

// ---------- games ----------
const playView = r => r ? {
    difficulty: r.difficulty, status: r.status, wrong: Number(r.wrong) || 0, hintsUsed: parseList(r.hints_used).map(Number),
    revealed: parseList(r.revealed).map(Number), bits: Number(r.bits) || 0, shared: Number(r.shared) === 1, guildId: r.guild_id || null
} : null;

// Today's games of a person: { easy: play|null, ... }, and whether they solved one
async function dayStatus(userId, day) {
    await ensureTables();
    const [rows] = await pool.execute('SELECT * FROM trivia_plays WHERE user_id = ? AND day = ?', [String(userId), day]);
    const plays = {};
    for (const d of W.DIFFICULTIES) plays[d.key] = null;
    for (const r of rows) if (plays[r.difficulty] !== undefined) plays[r.difficulty] = playView(r);
    const solved = W.DIFFICULTIES.map(d => plays[d.key]).find(p => p && p.status === 'solved') || null;
    return { plays, solved };
}

async function getPlay(userId, day, diff) {
    const [[r]] = await pool.execute('SELECT * FROM trivia_plays WHERE user_id = ? AND day = ? AND difficulty = ?', [String(userId), day, diff]);
    return playView(r);
}

// Opens (or continues) a difficulty. Returns { ok, play } or { ok: false, reason: 'solved'|'locked' }
async function startPlay(userId, day, diff, guildId) {
    const st = await dayStatus(userId, day);
    if (st.solved) return { ok: false, reason: 'solved', solved: st.solved };
    const p = st.plays[diff];
    if (p && p.status !== 'playing') return { ok: false, reason: 'locked', play: p };
    if (!p) {
        await pool.execute("INSERT IGNORE INTO trivia_plays (user_id, day, difficulty, status, wrong, hints_used, revealed, guild_id, started_at) VALUES (?, ?, ?, 'playing', 0, '[]', '[]', ?, ?)",
            [String(userId), day, diff, guildId ? String(guildId) : null, Date.now()]);
    }
    return { ok: true, play: await getPlay(userId, day, diff) };
}

// A random hint that hasn't been shown yet
async function useHint(userId, day, diff, word) {
    const p = await getPlay(userId, day, diff);
    if (!p || p.status !== 'playing') return { ok: false, play: p };
    const left = word.hints.map((h, i) => i).filter(i => !p.hintsUsed.includes(i));
    if (!left.length) return { ok: false, play: p, none: true };
    const pick = left[Math.floor(Math.random() * left.length)];
    const used = [...p.hintsUsed, pick];
    await pool.execute("UPDATE trivia_plays SET hints_used = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
        [JSON.stringify(used), String(userId), day, diff]);
    return { ok: true, play: await getPlay(userId, day, diff), hint: word.hints[pick] };
}

async function giveUp(userId, day, diff) {
    await pool.execute("UPDATE trivia_plays SET status = 'gaveup', finished_at = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
        [Date.now(), String(userId), day, diff]);
    return getPlay(userId, day, diff);
}

// A guess. Returns { result: 'solved'|'wrong'|'failed'|'locked'|'already', play, award? }
async function guess(userId, day, diff, word, answer) {
    const p = await getPlay(userId, day, diff);
    if (!p || p.status !== 'playing') return { result: 'locked', play: p };
    const d = W.DIFF[diff];
    if (W.sameAnswer(answer, word.word)) return solve(userId, day, diff, p);
    const wrong = p.wrong + 1;
    if (wrong >= d.limit) {
        await pool.execute("UPDATE trivia_plays SET wrong = ?, status = 'failed', finished_at = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
            [wrong, Date.now(), String(userId), day, diff]);
        return { result: 'failed', play: await getPlay(userId, day, diff) };
    }
    const hidden = W.letterPositions(word.word).filter(i => !p.revealed.includes(i));
    const revealed = hidden.length ? [...p.revealed, hidden[Math.floor(Math.random() * hidden.length)]] : p.revealed;
    await pool.execute("UPDATE trivia_plays SET wrong = ?, revealed = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
        [wrong, JSON.stringify(revealed), String(userId), day, diff]);
    return { result: 'wrong', play: await getPlay(userId, day, diff), newLetter: hidden.length > 0 };
}

// Solve: one transaction for the game and the person's bits/streak/season (and only one solve per day)
async function solve(userId, day, diff, p) {
    const conn = await pool.getConnection();
    let award = null;
    try {
        await conn.beginTransaction();
        await conn.execute('INSERT IGNORE INTO trivia_users (user_id, display_name, updated_at) VALUES (?, ?, ?)', [String(userId), 'Player', Date.now()]);
        const [[u]] = await conn.execute('SELECT * FROM trivia_users WHERE user_id = ? FOR UPDATE', [String(userId)]);
        const [[done]] = await conn.execute("SELECT difficulty FROM trivia_plays WHERE user_id = ? AND day = ? AND status = 'solved'", [String(userId), day]);
        const [[cur]] = await conn.execute('SELECT status FROM trivia_plays WHERE user_id = ? AND day = ? AND difficulty = ?', [String(userId), day, diff]);
        if (done || !cur || cur.status !== 'playing') {
            await conn.rollback();
            return { result: done ? 'already' : 'locked', play: await getPlay(userId, day, diff) };
        }
        const bits = W.bitsFor(diff, p.hintsUsed.length, p.wrong);
        const { streak, bonus } = W.nextStreak(u, day);
        const season = W.seasonOf(day);
        const seasonBits = (u.season_key === season ? Number(u.season_bits) || 0 : 0) + bits + bonus;
        const total = (Number(u.bits_total) || 0) + bits + bonus;
        await conn.execute("UPDATE trivia_plays SET status = 'solved', bits = ?, finished_at = ? WHERE user_id = ? AND day = ? AND difficulty = ?",
            [bits + bonus, Date.now(), String(userId), day, diff]);
        await conn.execute('UPDATE trivia_users SET bits_total = ?, season_key = ?, season_bits = ?, streak = ?, last_solve_day = ?, updated_at = ? WHERE user_id = ?',
            [total, season, seasonBits, streak, day, Date.now(), String(userId)]);
        await conn.commit();
        award = { bits, base: W.DIFF[diff].base, bonus: bits - W.DIFF[diff].base, streak, milestone: bonus, seasonBits, total };
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
    return { result: 'solved', play: await getPlay(userId, day, diff), award };
}

// Marks a solved game as shared. True only the first time. undo = the post failed, allow sharing again.
async function markShared(userId, day, diff, undo) {
    const [r] = await pool.execute('UPDATE trivia_plays SET shared = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = \'solved\' AND shared = ?',
        [undo ? 0 : 1, String(userId), day, diff, undo ? 1 : 0]);
    return Number(r.affectedRows) > 0;
}

// The spoiler-free line posted in the share channel (no word, no letters)
function shareLine(name, diff, play, streak) {
    const safe = cleanName(name).replace(/[\\*_~`|>]/g, '\\$&');
    const guesses = play.wrong + 1;
    const hints = play.hintsUsed.length;
    return '🧩 **' + safe + '** solved today\'s **' + W.DIFF[diff].name + '** Pingway Trivia in ' + guesses + ' guess' + (guesses === 1 ? '' : 'es') +
        (hints ? ' with ' + hints + ' hint' + (hints === 1 ? '' : 's') : ' with no hints') + '!' + (streak > 1 ? ' 🔥 Streak ' + streak : '');
}

async function cleanup() {
    await ensureTables();
    const cut = W.addDays(W.dayOf(), -KEEP_DAYS);
    await pool.execute('DELETE FROM trivia_plays WHERE day < ?', [cut]);
    await pool.execute('DELETE FROM trivia_words WHERE day < ?', [cut]);
}

let started = false;
function start() {
    if (started) return;
    started = true;
    const run = async () => {
        try {
            await ensureTables();
            await refreshBank();
            await cleanup();
        } catch (err) {
            console.error('⚠️ [TRIVIA] Background check failed:', err.message);
        }
    };
    setTimeout(run, 15000);
    setInterval(run, 6 * 60 * 60 * 1000);
}

module.exports = {
    BANK_FILE, ensureTables, getBank, refreshBank, buildBank, bankIsOld, wordsOf, yesterdayAnswers,
    touchPlayer, getUser, shareChannel, dayStatus, getPlay, startPlay, useHint, giveUp, guess, markShared, shareLine, cleanup, start,
    _reset: () => { bank = null; building = null; tablesReady = false; }
};
