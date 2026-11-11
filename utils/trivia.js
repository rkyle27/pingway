// Pingway Trivia: word bank, database and game steps for /trivia (the screens are in commands/trivia.js).
// - Word bank: built from XIVAPI (jobs, cities, zones, dungeons, trials, raids, mounts, minions, actions, items)
//   and kept in data/trivia_bank.json. Rebuilt in the background when it is missing, older than 30 days or made with
//   an older bank format (BANK_FORMAT: raise it when the hints change, so new daily words get the new hints).
//   If a rebuild fails, the old bank stays in use.
// - Each word has a short "lore" text (XIVAPI descriptions, or an info line for jobs and places), shown only after
//   a solve. It is copied into trivia_words with the word, so it never changes during the day.
// - Word of the day: one per difficulty, the same for everyone. Saved in trivia_words the first time it is
//   needed, so it never changes during the day (even if the bank is rebuilt). A word isn't used again for
//   the same difficulty within 90 days.
// - One solve per person per JST day, in all servers. Giving up or running out of guesses locks that difficulty
//   for the day; another one can still be tried. Games in progress are saved, so /trivia continues them anywhere.
// - Hints: up to 3 per guess (trivia_plays.hint_round = hints used since the last wrong guess; a wrong guess sets it
//   back to 0). A hint shows an unused clue (a clue that shows a letter, like "First letter", comes last and also
//   opens that letter's box); when all clues are used it shows one hidden letter instead.
// - A wrong guess shows the letters in the right place plus one random letter. When every letter is shown, the game
//   is solved the same way as a right guess (bits = base then, see bitsFor in utils/triviaWords.js).
// - Stored per person (trivia_users): display name and avatar for the leaderboards, bits (all time and this
//   month), streak, last solve day and "hide me" (set on the website). trivia_players: who played in which server
//   (a server's leaderboard). trivia_guild: the share channel an admin picked on the website. trivia_shares: the servers a
//   day's solve was shared to (Discord's Share button and the website's Share box, see utils/triviaShare.js).
// - The website (pingway.app → Trivia) plays the same game: its lib/triviaPlay.js has exact copies of the game functions
//   below (a test there checks they stay the same). Change them in both places.
// - Old games (trivia_plays) and old words are deleted after 100 days.
// - Languages (en, fr, de, ja; the player's language from utils/userLanguage.js): the bank has every word's name, clues
//   and lore in all 4 languages (fetched from XIVAPI with ?language=xx). The word of the day is the SAME game thing
//   (same id) for everyone, only words that work in all 4 languages are picked (W.isComplete). trivia_words.i18n
//   keeps the fr/de/ja texts of the day (NULL for old words: those are shown in English to everyone).
// - Progress per language: letters and clues belong to the name in one language. trivia_plays.revealed/hints_used
//   are the English progress (as before), trivia_plays.lang_progress = JSON { fr: { revealed, hintsUsed }, ja: …,
//   en: 1 when English was played too } (NULL = only English played). Wrong guesses, the hint count of this guess
//   (hint_round), the status, the one-solve-per-day lock, bits and streaks are shared by all languages. When a player
//   opens the game in a new language, as many letters (the same share) are opened there as in the language where
//   they had opened the most. Bits use the language with the most letters shown, so switching never gives more bits.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pool } = require('./db');
const W = require('./triviaWords');
const TB = require('./triviaBank');
const { t } = require('./i18n');

const BANK_FILE = process.env.PINGWAY_TRIVIA_BANK_FILE || path.join(__dirname, '..', 'data', 'trivia_bank.json'); // env: tests only
const BANK_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const NO_REPEAT_DAYS = 90;
const KEEP_DAYS = 100;
const BANK_FORMAT = TB.BANK_FORMAT; // see utils/triviaBank.js
const OTHER_LANGS = W.LANGS.filter(l => l !== 'en');

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
        i18n MEDIUMTEXT NULL,
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
        hint_round INT NOT NULL DEFAULT 0,
        lang_progress TEXT NULL,
        PRIMARY KEY (user_id, day, difficulty),
        KEY idx_day (day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // Older tables: add hint_round, i18n, lang_progress (a second bot start doing the same at once only gets "Duplicate column")
    for (const [table, col, ddl] of [['trivia_plays', 'hint_round', 'INT NOT NULL DEFAULT 0'], ['trivia_words', 'i18n', 'MEDIUMTEXT NULL'],
        ['trivia_plays', 'lang_progress', 'TEXT NULL']]) {
        const [has] = await pool.execute('SHOW COLUMNS FROM ' + table + " LIKE '" + col + "'");
        if (has.length) continue;
        await pool.execute('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + ddl).catch(err => {
            if (err.code !== 'ER_DUP_FIELDNAME' && !/Duplicate column/i.test(err.message)) throw err;
        });
    }
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
    // Which servers a solve was shared to (one post per person, day and server; the website's Share box uses it too)
    await pool.execute(`CREATE TABLE IF NOT EXISTS trivia_shares (
        user_id VARCHAR(32) NOT NULL,
        day CHAR(10) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        channel_id VARCHAR(32) DEFAULT NULL,
        shared_at BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day, guild_id),
        KEY idx_day (day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    tablesReady = true;
}

const parseList = v => {
    if (Array.isArray(v)) return v;
    try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch (e) { return []; }
};
const parseObj = v => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (v === null || v === undefined || v === '') return null;
    try { const x = JSON.parse(v); return x && typeof x === 'object' && !Array.isArray(x) ? x : null; } catch (e) { return null; }
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
// incomplete = a language could not be fetched (the bank works in English, it is built again on the next check)
const bankIsOld = b => !b || !Number(b.builtAt) || (Number(b.format) || 1) < BANK_FORMAT || !!b.incomplete || Date.now() - Number(b.builtAt) > BANK_MAX_AGE;

async function getJson(url) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const r = await axios.get(url, { timeout: 20000 });
            return r.data;
        } catch (err) {
            lastErr = err;
            await new Promise(res => setTimeout(res, retryMs * (attempt + 1)));
        }
    }
    throw lastErr;
}
let pauseMs = 150;   // between pages
let retryMs = 1500;  // before a retry (x1, x2, x3)
const pause = ms => new Promise(res => setTimeout(res, ms));

// The fetching and the bank itself are made in utils/triviaBank.js (the same code runs in misc/trivia-builder.html)
async function buildBank() {
    const { bank: b, complete, failed } = await TB.buildBankData({
        getJson, pause: () => pause(pauseMs), warn: text => console.error(text),
        strict: !!getBank() // a language failed: keep the old bank when there is one (it is tried again on the next check)
    });
    fs.mkdirSync(path.dirname(BANK_FILE), { recursive: true });
    const tmp = BANK_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(b));
    fs.renameSync(tmp, BANK_FILE);
    bank = b;
    console.log('🧩 [TRIVIA] Word bank ready: ' + W.DIFFICULTIES.map(d => d.name + ' ' + b.pools[d.key].length + ' (' + complete[d.key] + ' in all languages)').join(', ') + '.' +
        (failed.length ? ' Missing languages (tried again later): ' + failed.join(', ') + '.' : ''));
    return b;
}
// Starts a rebuild when the bank is missing or old (only one at a time). Never throws.
// Pingway does NOT download the word bank by itself any more (the 4-language download ran the bot out of memory):
// the owner builds data/trivia_bank.json once with the Trivia data builder page and uploads it.
// Set TRIVIA_AUTO_BUILD=1 in .env only if a rebuild on the server is really wanted.
let warnedNoBank = false;
function refreshBank() {
    if (building) return building;
    if (process.env.TRIVIA_AUTO_BUILD !== '1') {
        const b = getBank();
        if (!b && !warnedNoBank) { warnedNoBank = true; console.error('⚠️ [TRIVIA] No word bank found: upload data/trivia_bank.json (made with the Trivia data builder).'); }
        return Promise.resolve(b);
    }
    if (!bankIsOld(getBank())) return Promise.resolve(bank);
    building = buildBank().catch(err => {
        console.error('⚠️ [TRIVIA] Word bank rebuild failed' + (getBank() ? ' (keeping the old one)' : '') + ':', err.message);
        return getBank();
    }).finally(() => { building = null; });
    return building;
}

// ---------- words of the day ----------
// The words a difficulty can pick from: only words that work in all 4 languages (all of them with an older bank)
function dayPool(b, key) {
    const all = (b && b.pools && b.pools[key]) || [];
    const complete = all.filter(W.isComplete);
    return complete.length ? complete : all;
}
// What trivia_words.i18n keeps for a bank entry (null when it has no other language)
function i18nJson(e) {
    const langs = OTHER_LANGS.filter(l => e && e.i18n && e.i18n[l] && e.i18n[l].word);
    if (!langs.length) return null;
    const out = { id: e.id || null };
    for (const l of langs) {
        const x = e.i18n[l];
        out[l] = { word: x.word, category: x.category || '', hints: x.hints || [], lore: W.cleanLore(x.lore || '', 600, l) };
    }
    return JSON.stringify(out);
}

// Makes sure all 6 words of `day` are saved, then returns them by difficulty (null when the bank isn't ready).
// Each word: { word, category, hints, lore } in English and .i18n = { id, fr: {...}, de, ja } (null for old words).
// Use W.viewOf(word, lang) for a language.
async function wordsOf(day) {
    await ensureTables();
    const read = async () => {
        const [rows] = await pool.execute('SELECT difficulty, word, category, hints, lore, i18n FROM trivia_words WHERE day = ?', [day]);
        const out = {};
        for (const r of rows) out[r.difficulty] = { word: r.word, category: r.category, hints: parseList(r.hints), lore: r.lore || '', i18n: parseObj(r.i18n) };
        return out;
    };
    let words = await read();
    const b = getBank();
    // Words saved before the bank had languages (e.g. the day this was installed): add the other languages when the
    // new bank has the same word, so everyone gets their language from then on. The English texts stay as they were.
    if (b) {
        for (const d of W.DIFFICULTIES) {
            const w = words[d.key];
            if (!w || w.i18n) continue;
            const e = ((b.pools && b.pools[d.key]) || []).find(x => W.isComplete(x) && W.fold(x.word) === W.fold(w.word));
            const json = e ? i18nJson(e) : null;
            if (!json) continue;
            await pool.execute('UPDATE trivia_words SET i18n = ? WHERE day = ? AND difficulty = ? AND i18n IS NULL', [json, day, d.key]);
            w.i18n = parseObj(json);
        }
    }
    if (W.DIFFICULTIES.every(d => words[d.key])) return words;
    if (!b) return null;
    const [recent] = await pool.execute('SELECT day, difficulty, word FROM trivia_words WHERE day >= ? AND day <> ?', [W.addDays(day, -NO_REPEAT_DAYS), day]);
    const today = new Set(Object.values(words).map(w => W.fold(w.word)));
    for (const d of W.DIFFICULTIES) {
        if (words[d.key]) continue;
        const list = dayPool(b, d.key);
        // Small pools run out before 90 days: then only the most recent words are skipped (the oldest come back first)
        const used = recent.filter(r => r.difficulty === d.key).sort((a, b) => (a.day < b.day ? 1 : -1)).map(r => W.fold(r.word));
        const avoid = new Set([...today, ...used.slice(0, Math.max(0, list.length - 1 - today.size))]);
        const e = W.pickWord(list, day, d.key, avoid);
        if (!e) return null;
        today.add(W.fold(e.word));
        await pool.execute('INSERT IGNORE INTO trivia_words (day, difficulty, word, category, hints, lore, i18n, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [day, d.key, e.word, e.category || '', JSON.stringify(e.hints || []), W.cleanLore(e.lore || ''), i18nJson(e), Date.now()]);
    }
    words = await read();
    return W.DIFFICULTIES.every(d => words[d.key]) ? words : null;
}
// Yesterday's answers (only after the day is over), in a language
async function yesterdayAnswers(today, lang) {
    await ensureTables();
    const [rows] = await pool.execute('SELECT difficulty, word, i18n FROM trivia_words WHERE day = ?', [W.addDays(today, -1)]);
    const out = {};
    for (const r of rows) out[r.difficulty] = W.viewOf({ word: r.word, i18n: parseObj(r.i18n) }, lang).word;
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
// Progress per language (see the top of this file). langMap = the lang_progress JSON (null = only English played).
function langMap(r) {
    if (!r || r.lang_progress === null || r.lang_progress === undefined || r.lang_progress === '') return null;
    return parseObj(r.lang_progress) || {};
}
// Languages this game was played in
function startedLangs(r) {
    const m = langMap(r);
    if (!m) return ['en'];
    return W.LANGS.filter(l => (l === 'en' ? !!m.en : !!(m[l] && typeof m[l] === 'object')));
}
function progressOf(r, lang) {
    if (!lang || lang === 'en') return { revealed: parseList(r.revealed).map(Number), hintsUsed: parseList(r.hints_used).map(Number) };
    const m = (langMap(r) || {})[lang] || {};
    return { revealed: parseList(m.revealed).map(Number), hintsUsed: parseList(m.hintsUsed).map(Number) };
}
// SQL "SET" part that saves one language's progress (English: the old columns)
function progressSet(r, lang, prog) {
    if (!lang || lang === 'en') return { sql: 'hints_used = ?, revealed = ?', args: [JSON.stringify(prog.hintsUsed), JSON.stringify(prog.revealed)] };
    const m = langMap(r) || { en: 1 }; // null = English was played (keep that)
    m[lang] = { revealed: prog.revealed, hintsUsed: prog.hintsUsed };
    return { sql: 'lang_progress = ?', args: [JSON.stringify(m)] };
}

// A game as seen in one language (lang = the language of the word shown; revealed/hintsUsed belong to it).
// all = progress of every language played (for bits), hintsAll = clues used in all languages.
const playView = (r, lang) => {
    if (!r) return null;
    const pl = lang || 'en';
    const cur = progressOf(r, pl);
    const all = {};
    for (const l of startedLangs(r)) all[l] = progressOf(r, l);
    const v = {
        difficulty: r.difficulty, status: r.status, wrong: Number(r.wrong) || 0, hintsUsed: cur.hintsUsed,
        revealed: cur.revealed, bits: Number(r.bits) || 0, shared: Number(r.shared) === 1, guildId: r.guild_id || null,
        hintRound: Number(r.hint_round) || 0, hintsLeft: Math.max(0, W.HINTS_PER_GUESS - (Number(r.hint_round) || 0)),
        lang: pl, started: Object.keys(all), all, hintsAll: Object.values(all).reduce((n, x) => n + x.hintsUsed.length, 0)
    };
    Object.defineProperty(v, 'row', { value: r, enumerable: false });
    return v;
};
// True when every letter of the answer is shown (v = the word in the language of `revealed`)
const allShown = (v, revealed) => W.letterPositions(v.word, v.lang).every(i => revealed.includes(i));

// Today's games of a person: { easy: play|null, ... }, and whether they solved one
async function dayStatus(userId, day, lang) {
    await ensureTables();
    const [rows] = await pool.execute('SELECT * FROM trivia_plays WHERE user_id = ? AND day = ?', [String(userId), day]);
    const plays = {};
    for (const d of W.DIFFICULTIES) plays[d.key] = null;
    for (const r of rows) if (plays[r.difficulty] !== undefined) plays[r.difficulty] = playView(r, lang);
    const solved = W.DIFFICULTIES.map(d => plays[d.key]).find(p => p && p.status === 'solved') || null;
    return { plays, solved };
}

async function getPlay(userId, day, diff, lang) {
    const [[r]] = await pool.execute('SELECT * FROM trivia_plays WHERE user_id = ? AND day = ? AND difficulty = ?', [String(userId), day, diff]);
    return playView(r, lang);
}

// First time in a language for a game already played in another one: open the same share of letters (at random places)
// as in the language with the most letters open, never all of them.
async function seedLanguage(userId, day, diff, p, word, lang) {
    const v = W.viewOf(word, lang);
    const lp = W.letterPositions(v.word, lang);
    let share = 0;
    for (const [l, prog] of Object.entries(p.all)) {
        const vl = W.viewOf(word, l);
        if (vl.lang !== l) continue;
        const pos = W.letterPositions(vl.word, l);
        if (pos.length) share = Math.max(share, pos.filter(i => prog.revealed.includes(i)).length / pos.length);
    }
    const count = Math.max(0, Math.min(lp.length - 1, Math.round(share * lp.length)));
    const pick = lp.slice();
    for (let i = pick.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pick[i], pick[j]] = [pick[j], pick[i]]; }
    const revealed = pick.slice(0, count).sort((a, b) => a - b);
    let set;
    if (lang === 'en') {
        const m = langMap(p.row) || {};
        m.en = 1;
        set = { sql: "revealed = ?, hints_used = '[]', lang_progress = ?", args: [JSON.stringify(revealed), JSON.stringify(m)] };
    } else {
        set = progressSet(p.row, lang, { revealed, hintsUsed: [] });
    }
    await pool.execute('UPDATE trivia_plays SET ' + set.sql + " WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
        [...set.args, String(userId), day, diff]);
}

// Opens (or continues) a difficulty. Returns { ok, play } or { ok: false, reason: 'solved'|'locked' }
// lang = the player's language, word = today's word of that difficulty (from wordsOf; needed for other languages)
async function startPlay(userId, day, diff, guildId, lang, word) {
    const pl = word ? W.viewOf(word, lang).lang : 'en';
    const st = await dayStatus(userId, day, pl);
    if (st.solved) return { ok: false, reason: 'solved', solved: st.solved };
    const p = st.plays[diff];
    if (p && p.status !== 'playing') return { ok: false, reason: 'locked', play: p };
    if (!p) {
        if (pl === 'en') {
            await pool.execute("INSERT IGNORE INTO trivia_plays (user_id, day, difficulty, status, wrong, hints_used, revealed, guild_id, started_at) VALUES (?, ?, ?, 'playing', 0, '[]', '[]', ?, ?)",
                [String(userId), day, diff, guildId ? String(guildId) : null, Date.now()]);
        } else {
            await pool.execute("INSERT IGNORE INTO trivia_plays (user_id, day, difficulty, status, wrong, hints_used, revealed, guild_id, started_at, lang_progress) VALUES (?, ?, ?, 'playing', 0, '[]', '[]', ?, ?, ?)",
                [String(userId), day, diff, guildId ? String(guildId) : null, Date.now(), JSON.stringify({ [pl]: { revealed: [], hintsUsed: [] } })]);
        }
    } else if (word && !p.started.includes(pl)) {
        await seedLanguage(userId, day, diff, p, word, pl);
    }
    return { ok: true, play: await getPlay(userId, day, diff, pl) };
}

// A hint (up to 3 per guess): a random clue that hasn't been shown yet (clues that show a letter, like "First letter", only
// when no other clue is left; they also open that letter's box), or when all clues are used, one hidden letter.
// Returns { ok, play, hint?, letter?, position? } (position = 1-based letter number that was just opened) or
// { ok: false, play, limit|none } — or a solve result ({ result: 'solved'|'already'|'locked', play, award?, allRevealed: true })
// when that letter was the last hidden one. word = today's word (all languages), lang = the player's language.
async function useHint(userId, day, diff, word, lang) {
    const v = W.viewOf(word, lang);
    const pl = v.lang;
    const p = await getPlay(userId, day, diff, pl);
    if (!p || p.status !== 'playing') return { ok: false, play: p };
    if (p.hintsLeft <= 0) return { ok: false, play: p, limit: true };
    const where = " WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing' AND hint_round = ?";
    const key = [String(userId), day, diff, p.hintRound];
    const left = v.hints.map((h, i) => i).filter(i => !p.hintsUsed.includes(i));
    const letterNo = at => W.letterPositions(v.word, pl).indexOf(at) + 1;
    if (left.length) {
        const plain = left.filter(i => W.hintLetter(v.word, v.hints[i], pl) < 0);
        const from = plain.length ? plain : left;
        const pick = from[Math.floor(Math.random() * from.length)];
        const used = [...p.hintsUsed, pick];
        const at = W.hintLetter(v.word, v.hints[pick], pl);
        const opens = at >= 0 && !p.revealed.includes(at);
        const set = progressSet(p.row, pl, { hintsUsed: used, revealed: opens ? [...p.revealed, at] : p.revealed });
        const [r] = await pool.execute('UPDATE trivia_plays SET ' + set.sql + ', hint_round = hint_round + 1' + where, [...set.args, ...key]);
        const play = await getPlay(userId, day, diff, pl);
        if (!(Number(r.affectedRows) > 0)) return { ok: false, play };
        const hint = W.hintText(v.hints[pick]);
        if (opens && allShown(v, play.revealed)) return { ...(await solve(userId, day, diff, play, word, pl)), ok: true, allRevealed: true, hint };
        return opens ? { ok: true, play, hint, position: letterNo(at) } : { ok: true, play, hint };
    }
    const hidden = W.letterPositions(v.word, pl).filter(i => !p.revealed.includes(i));
    if (!hidden.length) return { ok: false, play: p, none: true };
    const at = hidden[Math.floor(Math.random() * hidden.length)];
    const set = progressSet(p.row, pl, { hintsUsed: p.hintsUsed, revealed: [...p.revealed, at] });
    const [r] = await pool.execute('UPDATE trivia_plays SET ' + set.sql + ', hint_round = hint_round + 1' + where, [...set.args, ...key]);
    const play = await getPlay(userId, day, diff, pl);
    if (!(Number(r.affectedRows) > 0)) return { ok: false, play };
    if (allShown(v, play.revealed)) return { ...(await solve(userId, day, diff, play, word, pl)), ok: true, allRevealed: true };
    return { ok: true, play, letter: true, position: letterNo(at) };
}

async function giveUp(userId, day, diff, lang) {
    await pool.execute("UPDATE trivia_plays SET status = 'gaveup', finished_at = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
        [Date.now(), String(userId), day, diff]);
    return getPlay(userId, day, diff, lang);
}

// A guess. Returns { result: 'solved'|'wrong'|'failed'|'locked'|'already', play, award?, shown?, allRevealed? }
// A wrong guess first shows the letters in the right place and one random letter; if that shows every letter, it is
// solved (even on the last allowed wrong guess), otherwise too many wrong guesses = failed.
// The answer is checked against the name in the player's language (see W.sameAnswer).
async function guess(userId, day, diff, word, answer, lang) {
    const v = W.viewOf(word, lang);
    const pl = v.lang;
    const p = await getPlay(userId, day, diff, pl);
    if (!p || p.status !== 'playing') return { result: 'locked', play: p };
    const d = W.DIFF[diff];
    if (W.sameAnswer(answer, v.word, pl)) return solve(userId, day, diff, p, word, pl);
    const wrong = p.wrong + 1;
    const matched = W.matchingLetters(v.word, answer, pl).filter(i => !p.revealed.includes(i));
    const afterMatch = [...p.revealed, ...matched];
    const hidden = W.letterPositions(v.word, pl).filter(i => !afterMatch.includes(i));
    const revealed = hidden.length ? [...afterMatch, hidden[Math.floor(Math.random() * hidden.length)]] : afterMatch;
    const shown = revealed.length - p.revealed.length;
    const set = progressSet(p.row, pl, { hintsUsed: p.hintsUsed, revealed });
    if (allShown(v, revealed)) {
        await pool.execute('UPDATE trivia_plays SET wrong = ?, ' + set.sql + ", hint_round = 0 WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
            [wrong, ...set.args, String(userId), day, diff]);
        return { ...(await solve(userId, day, diff, await getPlay(userId, day, diff, pl), word, pl)), allRevealed: true, shown };
    }
    if (wrong >= d.limit) {
        await pool.execute("UPDATE trivia_plays SET wrong = ?, status = 'failed', finished_at = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
            [wrong, Date.now(), String(userId), day, diff]);
        return { result: 'failed', play: await getPlay(userId, day, diff, pl) };
    }
    await pool.execute('UPDATE trivia_plays SET wrong = ?, ' + set.sql + ", hint_round = 0 WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
        [wrong, ...set.args, String(userId), day, diff]);
    return { result: 'wrong', play: await getPlay(userId, day, diff, pl), newLetter: hidden.length > 0, shown };
}

// Letters still hidden / all letters for the bits: the language with the most letters shown (an English-only game:
// the English name, as before). p.all = progress of every language played.
function bitsBasis(word, p) {
    let best = null;
    for (const [l, prog] of Object.entries((p && p.all) || { en: { revealed: (p && p.revealed) || [] } })) {
        const v = W.viewOf(word, l);
        if (v.lang !== l) continue;
        const lp = W.letterPositions(v.word, l);
        if (!lp.length) continue;
        const hidden = lp.filter(i => !prog.revealed.includes(i)).length;
        if (!best || hidden * best.total < best.hidden * lp.length) best = { hidden, total: lp.length };
    }
    if (best) return best;
    const lp = W.letterPositions(word.word);
    return { hidden: lp.filter(i => !((p && p.revealed) || []).includes(i)).length, total: lp.length };
}

// Solve: one transaction for the game and the person's bits/streak/season (and only one solve per day)
async function solve(userId, day, diff, p, word, lang) {
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
            return { result: done ? 'already' : 'locked', play: await getPlay(userId, day, diff, lang) };
        }
        const basis = bitsBasis(word, p);
        const bits = W.bitsFor(diff, basis.hidden, basis.total);
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
    return { result: 'solved', play: await getPlay(userId, day, diff, lang), award };
}

// Marks a solved game as shared. True only the first time. undo = the post failed, allow sharing again.
async function markShared(userId, day, diff, undo) {
    const [r] = await pool.execute('UPDATE trivia_plays SET shared = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = \'solved\' AND shared = ?',
        [undo ? 0 : 1, String(userId), day, diff, undo ? 1 : 0]);
    return Number(r.affectedRows) > 0;
}

// Saves that today's solve was shared to a server. True only the first time for that server. undo = the post failed.
async function recordShare(userId, day, guildId, channelId, undo) {
    await ensureTables();
    if (undo) {
        await pool.execute('DELETE FROM trivia_shares WHERE user_id = ? AND day = ? AND guild_id = ?', [String(userId), day, String(guildId)]);
        return true;
    }
    const [r] = await pool.execute('INSERT IGNORE INTO trivia_shares (user_id, day, guild_id, channel_id, shared_at) VALUES (?, ?, ?, ?, ?)',
        [String(userId), day, String(guildId), channelId ? String(channelId) : null, Date.now()]);
    return Number(r.affectedRows) > 0;
}

// The spoiler-free line posted in the share channel (no word, no letters), in the server's language
function shareLine(name, diff, play, streak, lang) {
    const L = lang || 'en';
    const safe = cleanName(name).replace(/[\\*_~`|>]/g, '\\$&');
    const guesses = play.wrong + 1;
    const hints = play.hintsAll !== undefined ? play.hintsAll : play.hintsUsed.length;
    const pl = n => W.pluralOf(L, n);
    return t(L, 'trivia.share.line', {
        name: safe, diff: t(L, 'trivia.diff.' + diff), guesses: t(L, 'trivia.share.guesses_' + pl(guesses), { n: guesses }),
        hints: hints ? t(L, 'trivia.share.hints_' + pl(hints), { n: hints }) : t(L, 'trivia.share.noHints'),
        streak: streak > 1 ? t(L, 'trivia.share.streak', { n: streak }) : ''
    }) + '\n' + t(L, 'trivia.share.invite', { command: triviaCommand() });
}

// Clickable </trivia:id> once the command id is known (fetched in start), plain **/trivia** until then
let triviaCmdId = null;
function triviaCommand() {
    return triviaCmdId ? '</trivia:' + triviaCmdId + '>' : '**/trivia**';
}

async function cleanup() {
    await ensureTables();
    const cut = W.addDays(W.dayOf(), -KEEP_DAYS);
    await pool.execute('DELETE FROM trivia_plays WHERE day < ?', [cut]);
    await pool.execute('DELETE FROM trivia_words WHERE day < ?', [cut]);
    await pool.execute('DELETE FROM trivia_shares WHERE day < ?', [cut]);
}

let started = false;
function start(client) {
    if (started) return;
    started = true;
    if (client && client.application) {
        client.application.commands.fetch()
            .then(cmds => { const c = cmds.find(x => x.name === 'trivia'); if (c) triviaCmdId = c.id; })
            .catch(() => { /* keep plain /trivia text */ });
    }
    require('./triviaRewards').start(client); // season end: hidden monthly bits reward (DM) and server top-3 roles
    const run = async () => {
        try {
            await ensureTables();
            await refreshBank();
            await wordsOf(W.dayOf()); // today's words are ready for the website too (it can't pick them itself)
            await cleanup();
        } catch (err) {
            console.error('⚠️ [TRIVIA] Background check failed:', err.message);
        }
    };
    setTimeout(run, 15000);
    setInterval(run, 6 * 60 * 60 * 1000);
    // Just after every 0:00 JST: save the new day's words (website players don't have to wait for a /trivia in Discord)
    const atMidnight = () => {
        const t = setTimeout(() => { wordsOf(W.dayOf()).catch(err => console.error('⚠️ [TRIVIA] New day words failed:', err.message)); atMidnight(); }, W.msToReset() + 5000);
        if (t.unref) t.unref();
    };
    atMidnight();
}

module.exports = {
    BANK_FILE, BANK_FORMAT, ensureTables, getBank, refreshBank, buildBank, bankIsOld, wordsOf, yesterdayAnswers,
    touchPlayer, getUser, shareChannel, dayStatus, getPlay, startPlay, useHint, giveUp, guess, markShared, recordShare, shareLine, cleanup, start,
    dayPool, startedLangs, bitsBasis,
    _reset: () => { bank = null; building = null; tablesReady = false; },
    _setPause: (ms, retry) => { pauseMs = ms; if (retry !== undefined) retryMs = retry; } // tests only
};
