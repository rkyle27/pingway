// Pingway Trivia: the plain rules, with no database and no Discord in here (easy to test).
// - Days are JST calendar days (Asia/Tokyo, UTC+9, no summer time). A new day starts at 0:00 JST.
// - Letters: accents are folded (ä -> a, œ -> oe, æ -> ae, ß -> ss). Answers are compared on the letters a-z only,
//   so case, accents, spaces, symbols and digits never matter.
// - The word is shown as one box per letter: ⬜ hidden, 🇦..🇿 shown. Spaces are a gap, symbols and digits are shown as they are.
// - Bits on a solve: base + base x (letters still hidden / all letters), rounded. Never below base, never above double.
//   Nothing shown = double; every letter shown = base. Hints cost nothing by themselves (a letter hint shows a letter).
// - Hints: up to 3 per guess (the count starts again after each wrong guess). Clues first, then one letter each.
// - A wrong guess shows every letter that is the same letter in the same place as the answer (k-th letter vs
//   k-th letter, spaces/symbols/digits skipped, accents folded), plus one more random letter.
// - Streak: days in a row with a solve. It starts again at 1 on the 1st of every month (new season).
// - The word bank (built from XIVAPI data by utils/trivia.js) is sorted into the 6 difficulties here.

const crypto = require('crypto');

const DIFFICULTIES = [
    { key: 'easy', name: 'Easy', base: 1, limit: 20, emoji: '🟢' },
    { key: 'normal', name: 'Normal', base: 2, limit: 15, emoji: '🔵' },
    { key: 'hard', name: 'Hard', base: 4, limit: 12, emoji: '🟡' },
    { key: 'extreme', name: 'Extreme', base: 6, limit: 9, emoji: '🟠' },
    { key: 'savage', name: 'Savage', base: 10, limit: 7, emoji: '🔴' },
    { key: 'ultimate', name: 'Ultimate', base: 20, limit: 5, emoji: '🟣' }
];
const DIFF = Object.fromEntries(DIFFICULTIES.map(d => [d.key, d]));
const MILESTONES = { 5: 10, 10: 20, 15: 30, 20: 40, 30: 60 };
const HINTS_PER_GUESS = 3;

// ---------- JST days ----------
const JST_MS = 9 * 60 * 60 * 1000;
const dayOf = ms => new Date((ms === undefined ? Date.now() : ms) + JST_MS).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const seasonOf = day => String(day).slice(0, 7);
// Milliseconds until the next 0:00 JST
const msToReset = (ms = Date.now()) => {
    const d = dayOf(ms);
    return Date.parse(addDays(d, 1) + 'T00:00:00Z') - JST_MS - ms;
};

// ---------- letters ----------
const SPECIAL = { 'œ': 'oe', 'Œ': 'oe', 'æ': 'ae', 'Æ': 'ae', 'ß': 'ss', 'ẞ': 'ss', 'ø': 'o', 'Ø': 'o', 'đ': 'd', 'Đ': 'd', 'ł': 'l', 'Ł': 'l', 'ı': 'i', 'þ': 'th', 'Þ': 'th', 'ð': 'd', 'Ð': 'd' };
function foldChar(ch) {
    if (SPECIAL[ch]) return SPECIAL[ch];
    return ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
}
// Only the letters a-z, used to compare answers
function fold(text) {
    let out = '';
    for (const ch of Array.from(String(text || '').normalize('NFC'))) out += foldChar(ch);
    return out;
}
const sameAnswer = (a, b) => fold(a) !== '' && fold(a) === fold(b);

// One cell per character: letter (a box), space (a gap) or sym (always shown)
function cells(word) {
    return Array.from(String(word).normalize('NFC')).map(ch => {
        if (/\s/.test(ch)) return { t: 'space' };
        if (/\p{L}/u.test(ch)) {
            const f = foldChar(ch);
            if (f) return { t: 'letter', l: f[0] };
        }
        return { t: 'sym', ch };
    });
}
const letterPositions = word => cells(word).map((c, i) => (c.t === 'letter' ? i : -1)).filter(i => i >= 0);
// Letter positions of the answer where the guess has the same letter in the same place:
// the k-th letter of the guess vs the k-th letter of the answer (spaces, symbols and digits skipped, accents folded)
function matchingLetters(word, guessText) {
    const ans = cells(word).map((c, i) => ({ c, i })).filter(x => x.c.t === 'letter');
    const g = cells(guessText).filter(c => c.t === 'letter').map(c => c.l);
    const out = [];
    for (let k = 0; k < ans.length && k < g.length; k++) if (ans[k].c.l === g[k]) out.push(ans[k].i);
    return out;
}

const ZWSP = '​';
const HIDDEN = '⬜';
const indicator = l => String.fromCodePoint(0x1F1E6 + (l.charCodeAt(0) - 97));
const escMd = ch => (/[\\*_~`|>#\[\]()]/.test(ch) ? '\\' + ch : ch);

// The boxes line. revealed = cell positions that are shown. showAll = every letter shown.
function renderBoxes(word, revealed, showAll) {
    const open = new Set((revealed || []).map(Number));
    let out = '';
    let prevBox = false;
    for (const [i, c] of cells(word).entries()) {
        if (c.t === 'space') { out += '   '; prevBox = false; continue; }
        if (c.t === 'sym') { out += escMd(c.ch); prevBox = false; continue; }
        if (prevBox) out += ZWSP; // keeps 🇺🇸-style flags from forming
        out += (showAll || open.has(i)) ? indicator(c.l) : HIDDEN;
        prevBox = true;
    }
    return out;
}

// ---------- bits & streak ----------
// hidden = letters not shown at the moment of the solve, total = all letters of the answer
function bitsFor(diffKey, hidden, total) {
    const d = DIFF[diffKey];
    const t = Number(total) || 0;
    const raw = t > 0 ? d.base + Math.round(d.base * (Number(hidden) || 0) / t) : d.base;
    return Math.min(d.base * 2, Math.max(d.base, raw));
}

// Streak shown on a given day (0 when the last solve was before yesterday, or in an earlier month)
function liveStreak(user, today) {
    if (!user || !user.last_solve_day) return 0;
    const last = String(user.last_solve_day);
    if (last === today) return Number(user.streak) || 0;
    if (last === addDays(today, -1) && seasonOf(last) === seasonOf(today)) return Number(user.streak) || 0;
    return 0;
}
// Streak after solving on `day`, and its milestone bonus
function nextStreak(user, day) {
    const last = user && user.last_solve_day ? String(user.last_solve_day) : '';
    const streak = (last === addDays(day, -1) && seasonOf(last) === seasonOf(day)) ? (Number(user.streak) || 0) + 1 : 1;
    return { streak, bonus: MILESTONES[streak] || 0 };
}

// ---------- daily pick ----------
// A private random salt (data/trivia_salt.txt, made on first use, never shared) keeps the daily answers
// unpredictable even though this code and the word data are public.
let salt = null;
function getSalt() {
    if (salt !== null) return salt;
    const fs = require('fs'), path = require('path');
    const file = path.join(__dirname, '..', 'data', 'trivia_salt.txt');
    try { salt = fs.readFileSync(file, 'utf8').trim(); } catch (e) { salt = ''; }
    if (!salt) {
        salt = crypto.randomBytes(32).toString('hex');
        try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, salt); } catch (e) { /* still works for this run */ }
    }
    return salt;
}
function seedOf(day, diffKey) {
    return crypto.createHash('sha256').update('pingway-trivia:' + getSalt() + ':' + day + ':' + diffKey).digest().readUInt32BE(0);
}
// Same answer for the same (day, difficulty, pool, used words). avoid = folded words not to use.
function pickWord(pool, day, diffKey, avoid) {
    const list = (pool || []).filter(e => !(avoid && avoid.has(fold(e.word))));
    const from = list.length ? list : (pool || []);
    if (!from.length) return null;
    const sorted = from.slice().sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
    return sorted[seedOf(day, diffKey) % sorted.length];
}

// ---------- names & hints ----------
const SMALL = new Set(['of', 'the', 'a', 'an', 'and', 'in', 'on', 'to', 'at', 'for', 'de', 'du', 'la', 'le']);
function titleCase(text) {
    return String(text || '').trim().split(/\s+/).map((w, i) => {
        if (i > 0 && SMALL.has(w.toLowerCase())) return w.toLowerCase();
        return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
}
const capFirst = s => { s = String(s || '').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

// Names Pingway can use as answers: 4+ letters, up to 32 characters, not mostly digits, no odd characters
function goodName(name) {
    const n = String(name || '').trim();
    if (!n || n.length > 32) return false;
    if (/[<>{}\[\]@#\/\\|_=+*^%$]/.test(n) || /[　-鿿]/.test(n)) return false;
    const letters = fold(n).length;
    if (letters < 4) return false;
    const digits = (n.match(/\d/g) || []).length;
    if (digits >= letters) return false;
    return true;
}

// Words of the answer that would give it away when found in a hint
function giveaway(word) {
    return String(word).split(/[\s\-']+/).map(fold).filter(w => w.length >= 4);
}
// Clean list of 3-6 hints: no empty ones, no repeats, none that contain (a big part of) the answer
function makeHints(word, specific) {
    const bad = giveaway(word);
    const whole = fold(word);
    const words = String(word).trim().split(/\s+/).length;
    const out = [];
    const add = h => {
        if (!h || out.length >= 6) return;
        const value = String(h).split(': ').slice(1).join(': ') || String(h);
        const f = fold(value);
        if (!f) return;
        if (f.includes(whole) || bad.some(w => f.includes(w))) return;
        if (!out.includes(h)) out.push(h);
    };
    for (const h of specific) add(h);
    add(words === 1 ? 'It is one word' : 'It has ' + words + ' words');
    const first = cells(word).find(c => c.t === 'letter');
    if (first) add('First letter: ' + first.l.toUpperCase());
    return out.slice(0, 6);
}

// Helpers to read XIVAPI v2 fields: links are { value, row_id, fields }, plain values are numbers/strings
function field(fields, dotted) {
    let cur = fields;
    for (const part of String(dotted).split('.')) {
        if (cur === null || cur === undefined) return undefined;
        if (typeof cur === 'object' && !Array.isArray(cur) && cur.fields && !(part in cur)) cur = cur.fields;
        cur = cur[part];
    }
    return cur;
}
const num = v => (v && typeof v === 'object') ? Number(v.value !== undefined ? v.value : v.row_id) || 0 : Number(v) || 0;
const text = v => (v && typeof v === 'object') ? '' : String(v === undefined || v === null ? '' : v).trim();

const ROLE_NAMES = { 1: 'Tank', 2: 'Melee DPS', 3: 'Ranged DPS', 4: 'Healer' };

// Lore / more info shown after a solve: no game markup (<...>), no odd control characters, at most ~600 characters
// (cut at the end of a sentence when possible). Line breaks stay.
function cleanLore(raw, max = 600) {
    if (typeof raw !== 'string') return '';
    let t = raw.replace(/\r\n?/g, '\n').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufffc\ufffd]/g, '');
    t = t.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    let end = -1;
    const re = /[.!?…](?=\s|$)/g;
    let m;
    while ((m = re.exec(cut))) end = m.index + 1;
    if (end >= max * 0.4) return cut.slice(0, end).trim();
    const sp = cut.lastIndexOf(' ');
    return cut.slice(0, sp > max * 0.5 ? sp : max).trim() + '…';
}
// Joins parts with line breaks, then cleans
const loreOf = (...parts) => cleanLore(parts.filter(p => p && String(p).trim()).join('\n'));
// A short quote (Tooltip of mounts/minions) as italic lines
function quoteLines(raw) {
    const q = cleanLore(raw, 300);
    return q ? q.split('\n').filter(Boolean).map(l => '*' + l.replace(/\*/g, '') + '*').join('\n') : '';
}
const byRow = rows => new Map((rows || []).map(r => [Number(r.row_id), r.fields || {}]));

// Sorts the raw XIVAPI rows into the 6 pools. raw = { classJobs, territories, content, mounts, minions, actions, items,
// and the *Transient sheets mountLore, minionLore, actionLore, contentLore (same row_id as the base sheet) }
// (arrays of { row_id, fields }). Returns { easy: [{ word, category, hints, lore }], ... }.
function buildPools(raw) {
    const pools = { easy: [], normal: [], hard: [], extreme: [], savage: [], ultimate: [] };
    const seen = { easy: new Set(), normal: new Set(), hard: new Set(), extreme: new Set(), savage: new Set(), ultimate: new Set() };
    const mountLore = byRow(raw.mountLore), minionLore = byRow(raw.minionLore), actionLore = byRow(raw.actionLore), contentLore = byRow(raw.contentLore);
    const transient = (map, id) => {
        const f = map.get(Number(id)) || {};
        const body = text(f.DescriptionEnhanced) || text(f.Description);
        return loreOf(body, quoteLines(text(f.Tooltip)));
    };
    const put = (diff, word, category, hints, lore) => {
        word = String(word || '').trim().replace(/\s+/g, ' ');
        if (!goodName(word)) return;
        const key = fold(word);
        if (seen[diff].has(key)) return;
        seen[diff].add(key);
        pools[diff].push({ word, category, hints: makeHints(word, ['Category: ' + category, ...hints]), lore: lore || '' });
    };
    const longName = w => String(w).trim().split(/\s+/).length >= 3 || String(w).trim().length >= 20;

    // Easy: jobs and classes
    for (const r of raw.classJobs || []) {
        const f = r.fields || {};
        const name = titleCase(text(field(f, 'Name')));
        if (!name || name.toLowerCase() === 'adventurer') continue;
        const isJob = num(field(f, 'JobIndex')) > 0;
        const parent = titleCase(text(field(f, 'ClassJobParent.Name')));
        const role = ROLE_NAMES[num(field(f, 'Role'))];
        const abbr = text(field(f, 'Abbreviation'));
        put('easy', name, isJob ? 'Job' : 'Class', [
            role ? 'Role: ' + role : '',
            abbr ? 'Abbreviation: ' + abbr : '',
            isJob && parent && parent !== name ? 'It starts as: ' + parent : ''
        ], loreOf(name + (abbr ? ' (' + abbr + ')' : '') + ' — ' + (role ? role + ' ' : '') + (isJob ? 'job' : 'class') +
            (isJob && parent && parent !== name ? ', starts as ' + parent : '') + '.'));
    }
    // Easy: cities and regions. Normal: field zones.
    const regionSeen = new Set();
    for (const r of raw.territories || []) {
        const f = r.fields || {};
        const place = text(field(f, 'PlaceName.Name'));
        const region = text(field(f, 'PlaceNameRegion.Name'));
        const exp = text(field(f, 'ExVersion.Name'));
        const use = num(field(f, 'TerritoryIntendedUse'));
        const where = (region ? ' in ' + region : '') + (exp ? ' (' + exp + ')' : '') + '.';
        if (use === 0 && place) put('easy', capFirst(place), 'City', [region ? 'Region: ' + region : '', exp ? 'Expansion: ' + exp : ''], 'A city' + where);
        if (use === 1 && place) put('normal', capFirst(place), 'Zone', [region ? 'Region: ' + region : '', exp ? 'Expansion: ' + exp : ''], 'A zone' + where);
        if ((use === 0 || use === 1) && region && !regionSeen.has(region)) {
            regionSeen.add(region);
            put('easy', capFirst(region), 'Region', [exp ? 'Expansion: ' + exp : ''], 'A region of the world' + (exp ? ', first seen in ' + exp : '') + '.');
        }
    }
    // Hard: dungeons. Extreme: trials and raids.
    for (const r of raw.content || []) {
        const f = r.fields || {};
        const name = capFirst(text(field(f, 'Name')));
        const type = text(field(f, 'ContentType.Name'));
        const level = num(field(f, 'ClassJobLevelRequired'));
        const zone = text(field(f, 'TerritoryType.PlaceName.Name'));
        const exp = text(field(f, 'TerritoryType.ExVersion.Name'));
        const hints = [level ? 'Level ' + level : '', exp ? 'Expansion: ' + exp : '', zone && fold(zone) !== fold(name) ? 'Zone: ' + zone : ''];
        const cat = /^dungeons?$/i.test(type) ? 'Dungeon' : /trial/i.test(type) ? 'Trial' : (/raid/i.test(type) && !/ultimate/i.test(type)) ? (/alliance/i.test(type) ? 'Alliance Raid' : 'Raid') : null;
        if (!cat) continue;
        const lore = loreOf([cat, level ? 'Level ' + level : '', exp].filter(Boolean).join(' · '), text(field(contentLore.get(Number(r.row_id)) || {}, 'Description')));
        put(cat === 'Dungeon' ? 'hard' : 'extreme', name, cat, hints, lore);
    }
    // Mounts: Normal (short names) or Ultimate (long names)
    for (const r of raw.mounts || []) {
        const name = titleCase(text(field(r.fields || {}, 'Singular')));
        if (!name) continue;
        put(longName(name) ? 'ultimate' : 'normal', name, 'Mount', [], transient(mountLore, r.row_id));
    }
    // Minions: Extreme (short names) or Ultimate (long names)
    for (const r of raw.minions || []) {
        const name = titleCase(text(field(r.fields || {}, 'Singular')));
        if (!name) continue;
        put(longName(name) ? 'ultimate' : 'extreme', name, 'Minion', [], transient(minionLore, r.row_id));
    }
    // Actions: Hard (level 50 or lower), Savage (all of them)
    for (const r of raw.actions || []) {
        const f = r.fields || {};
        if (field(f, 'IsPvP') === true || field(f, 'IsPlayerAction') === false) continue;
        const name = text(field(f, 'Name'));
        const job = titleCase(text(field(f, 'ClassJob.Name')));
        const level = num(field(f, 'ClassJobLevel'));
        if (!name || !level) continue;
        const who = job && job.toLowerCase() !== 'adventurer' ? job : 'Role action';
        const hints = [who === job ? 'Job: ' + job : 'Role action', 'Level ' + level];
        const lore = loreOf(who + ' · Level ' + level, text(field(actionLore.get(Number(r.row_id)) || {}, 'Description')));
        if (level <= 50) put('hard', name, 'Action', hints, lore);
        put('savage', name, 'Action', hints, lore);
    }
    // Ultimate: marketable items with 2+ words
    for (const r of raw.items || []) {
        const f = r.fields || {};
        const name = text(field(f, 'Name'));
        if (!name || name.split(/\s+/).length < 2 || num(field(f, 'ItemSearchCategory')) <= 0) continue;
        const ilvl = num(field(f, 'LevelItem'));
        const kind = text(field(f, 'ItemUICategory.Name'));
        put('ultimate', name, 'Item', [kind ? 'Item type: ' + kind : '', ilvl ? 'Item level ' + ilvl : ''],
            loreOf([kind, ilvl ? 'Item level ' + ilvl : ''].filter(Boolean).join(' · '), text(field(f, 'Description'))));
    }
    return pools;
}

module.exports = {
    DIFFICULTIES, DIFF, MILESTONES, HINTS_PER_GUESS, ZWSP, HIDDEN,
    dayOf, addDays, seasonOf, msToReset,
    fold, foldChar, sameAnswer, cells, letterPositions, matchingLetters, renderBoxes, indicator,
    bitsFor, liveStreak, nextStreak, seedOf, pickWord,
    titleCase, capFirst, goodName, makeHints, field, num, text, buildPools, cleanLore
};
