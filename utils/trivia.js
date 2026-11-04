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
const BANK_FORMAT = 3; // 2 = more hints per word, no word-count hint, First letter as { text, letter }; 3 = no "Nowheresville" starting city

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
        hint_round INT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day, difficulty),
        KEY idx_day (day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // Older tables: add hint_round (a second bot start doing the same at once only gets "Duplicate column")
    const [hintCol] = await pool.execute("SHOW COLUMNS FROM trivia_plays LIKE 'hint_round'");
    if (!hintCol.length) {
        await pool.execute('ALTER TABLE trivia_plays ADD COLUMN hint_round INT NOT NULL DEFAULT 0').catch(err => {
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
const bankIsOld = b => !b || !Number(b.builtAt) || (Number(b.format) || 1) < BANK_FORMAT || Date.now() - Number(b.builtAt) > BANK_MAX_AGE;

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
        classJobs: await sheetRows('ClassJob', 'Name,Abbreviation,Role,ClassJobParent.Name,JobIndex,ClassJobCategory.Name,StartingTown.Name,StartingLevel,PrimaryStat,IsLimitedJob'),
        territories: await sheetRows('TerritoryType', 'PlaceName.Name,PlaceNameRegion.Name,PlaceNameZone.Name,ExVersion.Name,TerritoryIntendedUse'),
        content: await sheetRows('ContentFinderCondition', 'Name,ContentType.Name,ClassJobLevelRequired,ClassJobLevelSync,ItemLevelRequired,ItemLevelSync,HighEndDuty,' +
            'LevelingRoulette,HighLevelRoulette,ExpertRoulette,TrialRoulette,AllianceRoulette,NormalRaidRoulette,MSQRoulette,' +
            'TerritoryType.PlaceName.Name,TerritoryType.PlaceNameRegion.Name,TerritoryType.ExVersion.Name'),
        contentLore: await sheetRows('ContentFinderConditionTransient', 'Description'),
        mounts: await sheetRows('Mount', 'Singular,ExtraSeats'),
        mountLore: await sheetRows('MountTransient', 'Description,DescriptionEnhanced,Tooltip'),
        minions: await sheetRows('Companion', 'Singular,MinionRace.Name,Behavior.Name'),
        minionLore: await sheetRows('CompanionTransient', 'Description,DescriptionEnhanced,Tooltip,SpecialActionName,MinionSkillType.Name,Attack,Defense,Speed'),
        actions: await searchRows('Action', '+IsPlayerAction=true +IsPvP=false', 'Name,ClassJob.Name,ClassJobLevel,IsPvP,IsPlayerAction,ActionCategory.Name,ClassJobCategory.Name,' +
            'Cast100ms,Recast100ms,Range,EffectRange,MaxCharges,IsRoleAction,CanTargetHostile,CanTargetParty,CanTargetSelf,TargetArea'),
        items: await sheetRows('Item', 'Name,Description,ItemSearchCategory.Name,LevelItem,ItemUICategory.Name,LevelEquip,ClassJobCategory.Name,Rarity,' +
            'GrandCompany.Name,ItemSeries.Name,MateriaSlotCount,DyeCount,StackSize,CanBeHq,IsUnique,IsCollectable'),
        // Who crafts what (joined to the items in memory)
        recipes: await sheetRows('Recipe', 'ItemResult.Name,CraftType.Name,IsExpert')
    };
    // Lore of actions: only the rows of the actions found above (ActionTransient has the same row_id)
    const actionIds = new Set(raw.actions.map(r => Number(r.row_id)));
    raw.actionLore = (await sheetRows('ActionTransient', 'Description', 400)).filter(r => actionIds.has(Number(r.row_id)));
    const pools = W.buildPools(raw);
    const small = W.DIFFICULTIES.filter(d => pools[d.key].length < MIN_POOL).map(d => d.name);
    if (small.length) throw new Error('too few words for ' + small.join(', '));
    const b = { builtAt: Date.now(), format: BANK_FORMAT, pools };
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
    revealed: parseList(r.revealed).map(Number), bits: Number(r.bits) || 0, shared: Number(r.shared) === 1, guildId: r.guild_id || null,
    hintRound: Number(r.hint_round) || 0, hintsLeft: Math.max(0, W.HINTS_PER_GUESS - (Number(r.hint_round) || 0))
} : null;
// True when every letter of the answer is shown
const allShown = (word, revealed) => W.letterPositions(word.word).every(i => revealed.includes(i));

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

// A hint (up to 3 per guess): a random clue that hasn't been shown yet (clues that show a letter, like "First letter", only
// when no other clue is left; they also open that letter's box), or when all clues are used, one hidden letter.
// Returns { ok, play, hint?, letter?, position? } (position = 1-based letter number that was just opened) or
// { ok: false, play, limit|none } — or a solve result ({ result: 'solved'|'already'|'locked', play, award?, allRevealed: true })
// when that letter was the last hidden one.
async function useHint(userId, day, diff, word) {
    const p = await getPlay(userId, day, diff);
    if (!p || p.status !== 'playing') return { ok: false, play: p };
    if (p.hintsLeft <= 0) return { ok: false, play: p, limit: true };
    const where = " WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing' AND hint_round = ?";
    const key = [String(userId), day, diff, p.hintRound];
    const left = word.hints.map((h, i) => i).filter(i => !p.hintsUsed.includes(i));
    const letterNo = at => W.letterPositions(word.word).indexOf(at) + 1;
    if (left.length) {
        const plain = left.filter(i => W.hintLetter(word.word, word.hints[i]) < 0);
        const from = plain.length ? plain : left;
        const pick = from[Math.floor(Math.random() * from.length)];
        const used = [...p.hintsUsed, pick];
        const at = W.hintLetter(word.word, word.hints[pick]);
        const opens = at >= 0 && !p.revealed.includes(at);
        const [r] = opens
            ? await pool.execute('UPDATE trivia_plays SET hints_used = ?, revealed = ?, hint_round = hint_round + 1' + where, [JSON.stringify(used), JSON.stringify([...p.revealed, at]), ...key])
            : await pool.execute('UPDATE trivia_plays SET hints_used = ?, hint_round = hint_round + 1' + where, [JSON.stringify(used), ...key]);
        const play = await getPlay(userId, day, diff);
        if (!(Number(r.affectedRows) > 0)) return { ok: false, play };
        const hint = W.hintText(word.hints[pick]);
        if (opens && allShown(word, play.revealed)) return { ...(await solve(userId, day, diff, play, word)), ok: true, allRevealed: true, hint };
        return opens ? { ok: true, play, hint, position: letterNo(at) } : { ok: true, play, hint };
    }
    const hidden = W.letterPositions(word.word).filter(i => !p.revealed.includes(i));
    if (!hidden.length) return { ok: false, play: p, none: true };
    const at = hidden[Math.floor(Math.random() * hidden.length)];
    const revealed = [...p.revealed, at];
    const [r] = await pool.execute('UPDATE trivia_plays SET revealed = ?, hint_round = hint_round + 1' + where, [JSON.stringify(revealed), ...key]);
    const play = await getPlay(userId, day, diff);
    if (!(Number(r.affectedRows) > 0)) return { ok: false, play };
    if (allShown(word, play.revealed)) return { ...(await solve(userId, day, diff, play, word)), ok: true, allRevealed: true };
    return { ok: true, play, letter: true, position: letterNo(at) };
}

async function giveUp(userId, day, diff) {
    await pool.execute("UPDATE trivia_plays SET status = 'gaveup', finished_at = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
        [Date.now(), String(userId), day, diff]);
    return getPlay(userId, day, diff);
}

// A guess. Returns { result: 'solved'|'wrong'|'failed'|'locked'|'already', play, award?, shown?, allRevealed? }
// A wrong guess first shows the letters in the right place and one random letter; if that shows every letter, it is
// solved (even on the last allowed wrong guess), otherwise too many wrong guesses = failed.
async function guess(userId, day, diff, word, answer) {
    const p = await getPlay(userId, day, diff);
    if (!p || p.status !== 'playing') return { result: 'locked', play: p };
    const d = W.DIFF[diff];
    if (W.sameAnswer(answer, word.word)) return solve(userId, day, diff, p, word);
    const wrong = p.wrong + 1;
    const matched = W.matchingLetters(word.word, answer).filter(i => !p.revealed.includes(i));
    const afterMatch = [...p.revealed, ...matched];
    const hidden = W.letterPositions(word.word).filter(i => !afterMatch.includes(i));
    const revealed = hidden.length ? [...afterMatch, hidden[Math.floor(Math.random() * hidden.length)]] : afterMatch;
    const shown = revealed.length - p.revealed.length;
    if (allShown(word, revealed)) {
        await pool.execute("UPDATE trivia_plays SET wrong = ?, revealed = ?, hint_round = 0 WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
            [wrong, JSON.stringify(revealed), String(userId), day, diff]);
        return { ...(await solve(userId, day, diff, await getPlay(userId, day, diff), word)), allRevealed: true, shown };
    }
    if (wrong >= d.limit) {
        await pool.execute("UPDATE trivia_plays SET wrong = ?, status = 'failed', finished_at = ? WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
            [wrong, Date.now(), String(userId), day, diff]);
        return { result: 'failed', play: await getPlay(userId, day, diff) };
    }
    await pool.execute("UPDATE trivia_plays SET wrong = ?, revealed = ?, hint_round = 0 WHERE user_id = ? AND day = ? AND difficulty = ? AND status = 'playing'",
        [wrong, JSON.stringify(revealed), String(userId), day, diff]);
    return { result: 'wrong', play: await getPlay(userId, day, diff), newLetter: hidden.length > 0, shown };
}

// Solve: one transaction for the game and the person's bits/streak/season (and only one solve per day)
async function solve(userId, day, diff, p, word) {
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
        const letters = W.letterPositions(word.word);
        const bits = W.bitsFor(diff, letters.filter(i => !p.revealed.includes(i)).length, letters.length);
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

// ---------- console (mybot.js: "trivia <id>", "trivia reset <id> today|purge", "trivia reset confirm") ----------
// Only this user's trivia_plays / trivia_users / trivia_players rows. trivia_words and trivia_guild are never touched.
// "today" keeps trivia_players (which servers they play in). A reset needs "trivia reset confirm" within 60 seconds.
let pendingTriviaReset = null; // { type: 'today'|'purge', userId, day, expires }
const TRIVIA_USAGE = '[CONSOLE] Usage: trivia <discord user id>  |  trivia reset <discord user id> today  |  trivia reset <discord user id> purge  |  trivia reset confirm';

// The streak/last solve day from before today's solve, so the next solve today gets the same streak (and milestone):
// nextStreak() only checks "last solve = yesterday in the same month" -> streak + 1, else 1.
// streakToday = the streak today's solve gave. prevDay = latest earlier day with a solve (or null).
function streakBeforeToday(streakToday, today, prevDay) {
    const yesterday = W.addDays(today, -1);
    if (streakToday > 1) return { streak: streakToday - 1, last_solve_day: yesterday };
    // Streak was 1: the next solve must give 1 again, so never leave "yesterday in the same month" here
    if (!prevDay || (prevDay === yesterday && W.seasonOf(prevDay) === W.seasonOf(today))) return { streak: 0, last_solve_day: null };
    return { streak: 0, last_solve_day: prevDay };
}

// Works out what "trivia reset <id> today" changes (q = pool or a connection inside the transaction)
async function triviaTodayPlan(q, userId, today) {
    const [plays] = await q.execute('SELECT difficulty, status, wrong, bits FROM trivia_plays WHERE user_id = ? AND day = ?', [userId, today]);
    const [[u]] = await q.execute('SELECT * FROM trivia_users WHERE user_id = ?', [userId]);
    const solved = plays.find(p => p.status === 'solved') || null;
    const bits = solved ? Number(solved.bits) || 0 : 0;
    const plan = { plays, solved, bits, user: u || null, users: null };
    if (!u) return plan;
    const season = W.seasonOf(today);
    const users = {
        bits_total: Math.max(0, (Number(u.bits_total) || 0) - bits),
        season_bits: u.season_key === season ? Math.max(0, (Number(u.season_bits) || 0) - bits) : Number(u.season_bits) || 0,
        streak: Number(u.streak) || 0,
        last_solve_day: u.last_solve_day ? String(u.last_solve_day) : null
    };
    if (users.last_solve_day === today) {
        const [[prev]] = await q.execute("SELECT MAX(day) AS day FROM trivia_plays WHERE user_id = ? AND day < ? AND status = 'solved'", [userId, today]);
        Object.assign(users, streakBeforeToday(Number(u.streak) || 0, today, prev && prev.day ? String(prev.day) : null));
    }
    plan.users = users;
    return plan;
}

async function triviaPurgeCounts(q, userId) {
    const [[a]] = await q.execute('SELECT COUNT(*) AS n FROM trivia_plays WHERE user_id = ?', [userId]);
    const [[b]] = await q.execute('SELECT COUNT(*) AS n FROM trivia_users WHERE user_id = ?', [userId]);
    const [[c]] = await q.execute('SELECT COUNT(*) AS n FROM trivia_players WHERE user_id = ?', [userId]);
    return { plays: Number(a.n), users: Number(b.n), players: Number(c.n) };
}

async function adminTrivia(args) {
    args = (args || []).filter(Boolean);
    const isId = v => typeof v === 'string' && /^\d{15,22}$/.test(v);
    const show = args.length === 1 && isId(args[0]);
    const confirm = args.length === 2 && args[0] === 'reset' && args[1] === 'confirm';
    const reset = args.length === 3 && args[0] === 'reset' && isId(args[1]) && (args[2] === 'today' || args[2] === 'purge');
    if (!show && !confirm && !reset) {
        console.log(TRIVIA_USAGE);
        return;
    }
    try {
        await ensureTables();
    } catch (err) {
        console.error('❌ [TRIVIA] Database not ready:', err.message);
        return;
    }
    const today = W.dayOf();
    try {
        if (show) {
            const userId = args[0];
            const [[u]] = await pool.execute('SELECT * FROM trivia_users WHERE user_id = ?', [userId]);
            const [plays] = await pool.execute('SELECT difficulty, status, wrong, bits FROM trivia_plays WHERE user_id = ? AND day = ?', [userId, today]);
            const [[all]] = await pool.execute('SELECT COUNT(*) AS n FROM trivia_plays WHERE user_id = ?', [userId]);
            const [[srv]] = await pool.execute('SELECT COUNT(*) AS n FROM trivia_players WHERE user_id = ?', [userId]);
            if (!u && !plays.length && !Number(all.n) && !Number(srv.n)) {
                console.log('\n🧩 [TRIVIA] ' + userId + ': no Trivia data.\n');
                return;
            }
            console.log('\n🧩 [TRIVIA] ' + userId + (u && u.display_name ? ' (' + u.display_name + ')' : ''));
            if (u) {
                console.log('  Bits: ' + (Number(u.bits_total) || 0) + ' all time | ' + (Number(u.season_bits) || 0) + ' in season ' + (u.season_key || 'none') +
                    (u.season_key && u.season_key !== W.seasonOf(today) ? ' (old season: 0 this month)' : ''));
                console.log('  Streak: ' + (Number(u.streak) || 0) + ' (shown today: ' + W.liveStreak(u, today) + ') | Last solve: ' + (u.last_solve_day || 'never') +
                    ' | Hidden: ' + (Number(u.hidden) ? 'yes' : 'no'));
            } else {
                console.log('  No trivia_users row (no bits/streak saved).');
            }
            console.log('  Today (' + today + ' JST):' + (plays.length ? '' : ' no plays'));
            for (const d of W.DIFFICULTIES) {
                const p = plays.find(x => x.difficulty === d.key);
                if (p) console.log('    ' + d.name + ': ' + p.status + ', ' + (Number(p.wrong) || 0) + ' wrong' + (p.status === 'solved' ? ', ' + (Number(p.bits) || 0) + ' bits' : ''));
            }
            console.log('  Games saved (all days): ' + Number(all.n) + ' | Servers: ' + Number(srv.n) + '\n');
            return;
        }

        if (reset) {
            const userId = args[1];
            if (args[2] === 'today') {
                const plan = await triviaTodayPlan(pool, userId, today);
                if (!plan.plays.length && !(plan.user && plan.users && plan.user.last_solve_day && String(plan.user.last_solve_day) === today)) {
                    pendingTriviaReset = null;
                    console.log('\n🧩 [TRIVIA RESET] ' + userId + ' has no Trivia plays today (' + today + ' JST). Nothing to reset.\n');
                    return;
                }
                console.log('\n🧩 [TRIVIA RESET] Today (' + today + ' JST) for ' + userId + (plan.user && plan.user.display_name ? ' (' + plan.user.display_name + ')' : '') + ':');
                console.log('  Plays to delete: ' + plan.plays.map(p => (W.DIFF[p.difficulty] ? W.DIFF[p.difficulty].name : p.difficulty) + ' (' + p.status + ')').join(', '));
                if (plan.solved && plan.users) {
                    console.log('  Bits removed: ' + plan.bits + ' (all time ' + plan.user.bits_total + ' -> ' + plan.users.bits_total +
                        ', season ' + (plan.user.season_bits || 0) + ' -> ' + plan.users.season_bits + ')');
                }
                if (plan.users && plan.user.last_solve_day && String(plan.user.last_solve_day) === today) {
                    console.log('  Streak: ' + plan.user.streak + ' -> ' + plan.users.streak + ' | Last solve: ' + today + ' -> ' + (plan.users.last_solve_day || 'none'));
                }
                console.log('  Server list (trivia_players) is kept. Other users, words and server settings are not touched.');
                console.log('  Type "trivia reset confirm" within 60 seconds to do this.\n');
            } else {
                const c = await triviaPurgeCounts(pool, userId);
                if (!c.plays && !c.users && !c.players) {
                    pendingTriviaReset = null;
                    console.log('\n🧩 [TRIVIA RESET] ' + userId + ' has no Trivia data. Nothing to delete.\n');
                    return;
                }
                console.log('\n🧩 [TRIVIA RESET] ALL Trivia data of ' + userId + ' will be deleted:');
                console.log('  trivia_plays: ' + c.plays + ' row(s) (all days) | trivia_users: ' + c.users + ' row(s) | trivia_players: ' + c.players + ' row(s)');
                console.log('  Other users, words and server settings are not touched.');
                console.log('  Type "trivia reset confirm" within 60 seconds to delete it.\n');
            }
            pendingTriviaReset = { type: args[2], userId, day: today, expires: Date.now() + 60000 };
            return;
        }
    } catch (err) {
        console.error('❌ [TRIVIA] Failed:', err.message);
        return;
    }

    // confirm
    if (!pendingTriviaReset || Date.now() > pendingTriviaReset.expires) {
        pendingTriviaReset = null;
        console.log('[TRIVIA RESET] Nothing to confirm. Type "trivia reset <id> today" or "trivia reset <id> purge" first.');
        return;
    }
    const job = pendingTriviaReset;
    pendingTriviaReset = null;
    if (job.type === 'today' && job.day !== today) {
        console.log('[TRIVIA RESET] The JST day changed since the preview. Nothing was changed: run "trivia reset ' + job.userId + ' today" again.');
        return;
    }
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        if (job.type === 'today') {
            await conn.execute('SELECT user_id FROM trivia_users WHERE user_id = ? FOR UPDATE', [job.userId]);
            const plan = await triviaTodayPlan(conn, job.userId, today);
            const [del] = await conn.execute('DELETE FROM trivia_plays WHERE user_id = ? AND day = ?', [job.userId, today]);
            if (plan.users) {
                await conn.execute('UPDATE trivia_users SET bits_total = ?, season_bits = ?, streak = ?, last_solve_day = ?, updated_at = ? WHERE user_id = ?',
                    [plan.users.bits_total, plan.users.season_bits, plan.users.streak, plan.users.last_solve_day, Date.now(), job.userId]);
            }
            await conn.commit();
            console.log('\n✅ [TRIVIA RESET] ' + job.userId + ': ' + del.affectedRows + ' play(s) of today deleted' +
                (plan.solved && plan.users ? ', ' + plan.bits + ' bit(s) removed' : '') +
                (plan.users ? ', streak ' + plan.users.streak + ' (last solve ' + (plan.users.last_solve_day || 'none') + ')' : '') + '. They can play today again.\n');
        } else {
            const [a] = await conn.execute('DELETE FROM trivia_plays WHERE user_id = ?', [job.userId]);
            const [b] = await conn.execute('DELETE FROM trivia_users WHERE user_id = ?', [job.userId]);
            const [c] = await conn.execute('DELETE FROM trivia_players WHERE user_id = ?', [job.userId]);
            await conn.commit();
            console.log('\n✅ [TRIVIA RESET] All Trivia data of ' + job.userId + ' deleted: trivia_plays ' + a.affectedRows + ', trivia_users ' + b.affectedRows + ', trivia_players ' + c.affectedRows + ' row(s).\n');
        }
    } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        console.error('❌ [TRIVIA RESET] Failed (nothing was changed):', err.message);
    } finally {
        if (conn) conn.release();
    }
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
    BANK_FILE, BANK_FORMAT, ensureTables, getBank, refreshBank, buildBank, bankIsOld, wordsOf, yesterdayAnswers,
    touchPlayer, getUser, shareChannel, dayStatus, getPlay, startPlay, useHint, giveUp, guess, markShared, shareLine, cleanup, start, adminTrivia,
    _reset: () => { bank = null; building = null; tablesReady = false; }
};
