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
// True when a text contains the answer or a big part of it
function leaks(word, value) {
    const f = fold(value);
    const whole = fold(word);
    return f.includes(whole) || giveaway(word).some(w => f.includes(w));
}
// A hint is a plain string, or { text, letter } when it shows a letter of the answer (letter = 0-based letter index,
// spaces/symbols/digits not counted). Old saved words have plain strings only.
const hintText = h => (h && typeof h === 'object') ? String(h.text || '') : String(h === undefined || h === null ? '' : h);
// Cell position of the letter a clue shows (for the boxes / revealed), or -1. Plain strings: the "First letter: X" format.
function hintLetter(word, h) {
    const lp = letterPositions(word);
    let k = -1;
    if (h && typeof h === 'object') {
        if (Number.isInteger(h.letter)) k = h.letter;
    } else if (/^First letter: \S$/u.test(String(h || '').trim())) {
        k = 0;
    }
    if (k < 0 || k >= lp.length) return -1;
    // The letter named in the text must be that letter of the answer
    const m = /:\s*(\S)$/u.exec(hintText(h).trim());
    if (m && foldChar(m[1]).charAt(0) !== cells(word)[lp[k]].l) return -1;
    return lp[k];
}
const MAX_HINTS = 10;
// Clean list of up to 10 hints (Category first, First letter last): no empty ones, no repeats, none that contain
// (a big part of) the answer
function makeHints(word, specific) {
    const out = [];
    const seenText = new Set();
    const add = (h, room) => {
        const t = hintText(h).trim();
        if (!t || out.length >= room) return;
        const value = t.split(': ').slice(1).join(': ') || t;
        if (!fold(value) || leaks(word, value)) return;
        if (seenText.has(t)) return;
        seenText.add(t);
        out.push(h);
    };
    const first = cells(word).find(c => c.t === 'letter');
    for (const h of specific) add(h, first ? MAX_HINTS - 1 : MAX_HINTS);
    if (first) add({ text: 'First letter: ' + first.l.toUpperCase(), letter: 0 }, MAX_HINTS);
    return out;
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

// A short one-line clue from a game text (Description / Tooltip): no markup, the answer's words masked as ???,
// first sentence (or first ~150 characters). '' when too short. makeHints still drops it if a part of the answer is left.
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function textHint(label, raw, word, max = 150) {
    let t = cleanLore(typeof raw === 'string' ? raw : '', 600).replace(/\s*\n\s*/g, ' ').trim();
    if (!t) return '';
    const parts = [String(word)].concat(String(word).split(/[\s\-']+/).filter(w => fold(w).length >= 4));
    for (const w of parts) t = t.replace(new RegExp('\\p{L}*' + escRe(w) + '\\p{L}*', 'giu'), '???');
    const m = /^.*?[.!?…](?=\s|$)/u.exec(t);
    if (m && m[0].length >= 20) t = m[0];
    if (t.length > max) {
        const cut = t.slice(0, max);
        const sp = cut.lastIndexOf(' ');
        t = cut.slice(0, sp > max * 0.5 ? sp : max).trim() + '…';
    }
    t = t.replace(/[*_~`|\\]/g, '').replace(/@/g, '@​').trim();
    return t.replace(/\?\?\?/g, '').replace(/[^\p{L}]/gu, '').length >= 10 ? label + ': ' + t : '';
}
const yes = v => v === true || v === 1;
const listOf = (items, max = 3) => items.filter(Boolean).slice(0, max).join(', ');
// The first name in `names` that doesn't give `word` away
const safeOther = (word, names) => names.find(n => n && fold(n) !== fold(word) && !leaks(word, n)) || '';

const STAT_NAMES = { 1: 'Strength', 2: 'Dexterity', 3: 'Vitality', 4: 'Intelligence', 5: 'Mind' };
const RARITY = { 1: 'Common (white)', 2: 'Uncommon (green)', 3: 'Rare (blue)', 4: 'Relic (purple)', 7: 'Aetherial (pink)' };
const CRAFTERS = { woodworking: 'Carpenter', smithing: 'Blacksmith', armorcraft: 'Armorer', goldsmithing: 'Goldsmith', leatherworking: 'Leatherworker', clothcraft: 'Weaver', alchemy: 'Alchemist', cooking: 'Culinarian' };
const ROULETTES = [['LevelingRoulette', 'Leveling'], ['HighLevelRoulette', 'High-level Dungeons'], ['ExpertRoulette', 'Expert'], ['TrialRoulette', 'Trials'],
    ['AllianceRoulette', 'Alliance Raids'], ['NormalRaidRoulette', 'Normal Raids'], ['MSQRoulette', 'Main Scenario']];
const secs = v => { const s = num(v) / 10; return (Math.round(s * 10) / 10) + 's'; };

// Sorts the raw XIVAPI rows into the 6 pools. raw = { classJobs, territories, content, mounts, minions, actions, items,
// recipes, and the *Transient sheets mountLore, minionLore, actionLore, contentLore (same row_id as the base sheet) }
// (arrays of { row_id, fields }). Returns { easy: [{ word, category, hints, lore }], ... }.
// Fields that are missing in the data just give no hint.
function buildPools(raw) {
    const pools = { easy: [], normal: [], hard: [], extreme: [], savage: [], ultimate: [] };
    const seen = { easy: new Set(), normal: new Set(), hard: new Set(), extreme: new Set(), savage: new Set(), ultimate: new Set() };
    const mountLore = byRow(raw.mountLore), minionLore = byRow(raw.minionLore), actionLore = byRow(raw.actionLore), contentLore = byRow(raw.contentLore);
    const transient = (map, id) => {
        const f = map.get(Number(id)) || {};
        const body = text(f.DescriptionEnhanced) || text(f.Description);
        return loreOf(body, quoteLines(text(f.Tooltip)));
    };
    // Quote (Tooltip) and description clues of a mount/minion
    const transientHints = (map, id, word) => {
        const f = map.get(Number(id)) || {};
        return [textHint('Quote', text(f.Tooltip), word), textHint('Description', text(f.DescriptionEnhanced) || text(f.Description), word)];
    };
    const put = (diff, word, category, hints, lore) => {
        word = String(word || '').trim().replace(/\s+/g, ' ');
        if (!goodName(word)) return;
        const key = fold(word);
        if (seen[diff].has(key)) return;
        seen[diff].add(key);
        // Text clues are made for the name before cleaning; make them again if the name changed
        pools[diff].push({ word, category, hints: makeHints(word, ['Category: ' + category, ...hints.map(h => (typeof h === 'function' ? h(word) : h))]), lore: lore || '' });
    };
    const longName = w => String(w).trim().split(/\s+/).length >= 3 || String(w).trim().length >= 20;

    // Easy: jobs and classes
    const jobRows = (raw.classJobs || []).map(r => {
        const f = r.fields || {};
        return { f, name: titleCase(text(field(f, 'Name'))), isJob: num(field(f, 'JobIndex')) > 0, parent: titleCase(text(field(f, 'ClassJobParent.Name'))) };
    });
    for (const { f, name, isJob, parent } of jobRows) {
        if (!name || name.toLowerCase() === 'adventurer') continue;
        const role = ROLE_NAMES[num(field(f, 'Role'))];
        const abbr = text(field(f, 'Abbreviation'));
        const disciple = text(field(f, 'ClassJobCategory.Name'));
        const town = text(field(f, 'StartingTown.Name')).replace(/^nowheresville$/i, ''); // "Nowheresville" = the game's placeholder (no real starting city)
        const startLevel = num(field(f, 'StartingLevel'));
        const stat = STAT_NAMES[num(field(f, 'PrimaryStat'))];
        const becomes = isJob ? '' : safeOther(name, jobRows.filter(j => j.isJob && j.parent === name).map(j => j.name));
        put('easy', name, isJob ? 'Job' : 'Class', [
            role ? 'Role: ' + role : '',
            /^disciples? of /i.test(disciple) ? 'Type: ' + disciple : '',
            stat ? 'Main stat: ' + stat : '',
            town ? 'Starting city: ' + town : '',
            startLevel > 1 ? 'Starts at level ' + startLevel : '',
            yes(field(f, 'IsLimitedJob')) ? 'It is a limited job' : '',
            becomes ? 'It becomes: ' + becomes : '',
            isJob && parent && parent !== name ? 'It starts as: ' + parent : '',
            abbr ? 'Abbreviation: ' + abbr : ''
        ], loreOf(name + (abbr ? ' (' + abbr + ')' : '') + ' — ' + (role ? role + ' ' : '') + (isJob ? 'job' : 'class') +
            (isJob && parent && parent !== name ? ', starts as ' + parent : '') + '.'));
    }
    // Easy: cities and regions. Normal: field zones.
    const places = (raw.territories || []).map(r => {
        const f = r.fields || {};
        return { place: text(field(f, 'PlaceName.Name')), region: text(field(f, 'PlaceNameRegion.Name')), area: text(field(f, 'PlaceNameZone.Name')),
            exp: text(field(f, 'ExVersion.Name')), use: num(field(f, 'TerritoryIntendedUse')) };
    }).filter(t => t.use === 0 || t.use === 1);
    const inRegion = (region, use) => places.filter(t => t.place && t.region === region && (use === undefined || t.use === use)).map(t => capFirst(t.place))
        .filter((n, i, a) => a.indexOf(n) === i);
    const regionSeen = new Set();
    for (const t of places) {
        const { place, region, area, exp, use } = t;
        const name = capFirst(place);
        const where = (region ? ' in ' + region : '') + (exp ? ' (' + exp + ')' : '') + '.';
        const hints = [region ? 'Region: ' + region : '', exp ? 'Expansion: ' + exp : '',
            area && fold(area) !== fold(place) && fold(area) !== fold(region) ? 'Area: ' + area : '',
            region ? 'Also in this region: ' + safeOther(name, inRegion(region)) : ''].filter(h => !/: $/.test(h));
        if (use === 0 && place) put('easy', name, 'City', hints, 'A city' + where);
        if (use === 1 && place) put('normal', name, 'Zone', hints, 'A zone' + where);
        if (region && !regionSeen.has(region)) {
            regionSeen.add(region);
            const R = capFirst(region);
            const zones = inRegion(region, 1), cities = inRegion(region, 0);
            const zone2 = safeOther(R, zones);
            put('easy', R, 'Region', [exp ? 'Expansion: ' + exp : '',
                zones.length ? zones.length + (zones.length === 1 ? ' field zone' : ' field zones') : '',
                cities.length ? 'A city there: ' + safeOther(R, cities) : '',
                zone2 ? 'A zone there: ' + zone2 : '',
                zone2 ? 'Another zone there: ' + safeOther(R, zones.filter(z => z !== zone2)) : ''
            ].filter(h => !/: $/.test(h)), 'A region of the world' + (exp ? ', first seen in ' + exp : '') + '.');
        }
    }
    // Hard: dungeons. Extreme: trials and raids.
    for (const r of raw.content || []) {
        const f = r.fields || {};
        const name = capFirst(text(field(f, 'Name')));
        const type = text(field(f, 'ContentType.Name'));
        const level = num(field(f, 'ClassJobLevelRequired'));
        const sync = num(field(f, 'ClassJobLevelSync'));
        const ilvl = num(field(f, 'ItemLevelRequired'));
        const ilvlSync = num(field(f, 'ItemLevelSync'));
        const zone = text(field(f, 'TerritoryType.PlaceName.Name'));
        const region = text(field(f, 'TerritoryType.PlaceNameRegion.Name'));
        const exp = text(field(f, 'TerritoryType.ExVersion.Name'));
        const roulettes = ROULETTES.filter(([k]) => yes(field(f, k))).map(([, n]) => n);
        const desc = text(field(contentLore.get(Number(r.row_id)) || {}, 'Description'));
        const hints = [level ? 'Level ' + level : '', exp ? 'Expansion: ' + exp : '', ilvl ? 'Item level ' + ilvl : '',
            roulettes.length ? 'Roulette: ' + listOf(roulettes) : '', region ? 'Region: ' + region : '',
            zone && fold(zone) !== fold(name) ? 'Zone: ' + zone : '', yes(field(f, 'HighEndDuty')) ? 'It is a high-end duty' : '',
            sync && sync !== level ? 'Level sync ' + sync : '', ilvlSync ? 'Item level sync ' + ilvlSync : '',
            w => textHint('Description', desc, w)];
        const cat = /^dungeons?$/i.test(type) ? 'Dungeon' : /trial/i.test(type) ? 'Trial' : (/raid/i.test(type) && !/ultimate/i.test(type)) ? (/alliance/i.test(type) ? 'Alliance Raid' : 'Raid') : null;
        if (!cat) continue;
        const lore = loreOf([cat, level ? 'Level ' + level : '', exp].filter(Boolean).join(' · '), desc);
        put(cat === 'Dungeon' ? 'hard' : 'extreme', name, cat, hints, lore);
    }
    // Mounts: Normal (short names) or Ultimate (long names)
    for (const r of raw.mounts || []) {
        const f = r.fields || {};
        const name = titleCase(text(field(f, 'Singular')));
        if (!name) continue;
        const seats = field(f, 'ExtraSeats');
        const riders = seats === undefined || seats === null ? 0 : num(seats) + 1;
        put(longName(name) ? 'ultimate' : 'normal', name, 'Mount', [
            riders ? 'Seats: ' + riders + (riders === 1 ? ' rider' : ' riders') : '',
            w => transientHints(mountLore, r.row_id, w)[0], w => transientHints(mountLore, r.row_id, w)[1]
        ], transient(mountLore, r.row_id));
    }
    // Minions: Extreme (short names) or Ultimate (long names)
    for (const r of raw.minions || []) {
        const f = r.fields || {};
        const name = titleCase(text(field(f, 'Singular')));
        if (!name) continue;
        const t = minionLore.get(Number(r.row_id)) || {};
        const race = text(field(f, 'MinionRace.Name'));
        const move = text(field(f, 'Behavior.Name'));
        const skill = text(field(t, 'MinionSkillType.Name'));
        const special = text(field(t, 'SpecialActionName'));
        const atk = num(field(t, 'Attack')), def = num(field(t, 'Defense')), spd = num(field(t, 'Speed'));
        put(longName(name) ? 'ultimate' : 'extreme', name, 'Minion', [
            race ? 'Minion race: ' + race : '',
            move ? 'Behavior: ' + move : '',
            skill ? 'Verminion skill type: ' + skill : '',
            special ? 'Special action: ' + special : '',
            atk || def || spd ? 'Verminion stats: ATK ' + atk + ' / DEF ' + def + ' / SPD ' + spd : '',
            w => transientHints(minionLore, r.row_id, w)[0], w => transientHints(minionLore, r.row_id, w)[1]
        ], transient(minionLore, r.row_id));
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
        const kind = text(field(f, 'ActionCategory.Name'));
        const users = text(field(f, 'ClassJobCategory.Name'));
        const cast = field(f, 'Cast100ms'), recast = field(f, 'Recast100ms');
        const range = num(field(f, 'Range')), radius = num(field(f, 'EffectRange')), charges = num(field(f, 'MaxCharges'));
        const targets = [yes(field(f, 'CanTargetHostile')) ? 'enemies' : '', yes(field(f, 'CanTargetParty')) ? 'party members' : '',
            yes(field(f, 'CanTargetSelf')) ? 'self' : ''].filter(Boolean);
        const desc = text(field(actionLore.get(Number(r.row_id)) || {}, 'Description'));
        const hints = [who === job ? 'Job: ' + job : 'Role action', 'Level ' + level,
            kind ? 'Action type: ' + kind : '',
            w => textHint('Description', desc, w),
            cast === undefined || cast === null ? '' : num(cast) > 0 ? 'Cast time: ' + secs(cast) : 'Instant cast',
            recast === undefined || recast === null || num(recast) <= 0 ? '' : 'Recast: ' + secs(recast),
            who === job && yes(field(f, 'IsRoleAction')) ? 'Role action' : '',
            yes(field(f, 'TargetArea')) ? 'It is ground-targeted' : targets.length ? 'Targets: ' + targets.join(', ') : '',
            range > 0 ? 'Range: ' + range + ' yalms' : '',
            radius > 0 ? 'Effect radius: ' + radius + ' yalms' : '',
            charges > 1 ? charges + ' charges' : '',
            users && users.length <= 60 ? 'Used by: ' + users : ''];
        const lore = loreOf(who + ' · Level ' + level, desc);
        if (level <= 50) put('hard', name, 'Action', hints, lore);
        put('savage', name, 'Action', hints, lore);
    }
    // Who crafts each item (Recipe sheet, joined in memory)
    const crafted = new Map();
    for (const r of raw.recipes || []) {
        const f = r.fields || {};
        const id = num(field(f, 'ItemResult'));
        const craft = text(field(f, 'CraftType.Name'));
        if (!id || !craft) continue;
        const job = CRAFTERS[craft.toLowerCase()] || craft;
        const c = crafted.get(id) || { jobs: [], expert: false };
        if (!c.jobs.includes(job)) c.jobs.push(job);
        if (yes(field(f, 'IsExpert'))) c.expert = true;
        crafted.set(id, c);
    }
    // Ultimate: marketable items with 2+ words
    for (const r of raw.items || []) {
        const f = r.fields || {};
        const name = text(field(f, 'Name'));
        if (!name || name.split(/\s+/).length < 2 || num(field(f, 'ItemSearchCategory')) <= 0) continue;
        const ilvl = num(field(f, 'LevelItem'));
        const kind = text(field(f, 'ItemUICategory.Name'));
        const market = text(field(f, 'ItemSearchCategory.Name'));
        const equip = num(field(f, 'LevelEquip'));
        const users = text(field(f, 'ClassJobCategory.Name'));
        const rarity = RARITY[num(field(f, 'Rarity'))];
        const craft = crafted.get(Number(r.row_id));
        const gc = text(field(f, 'GrandCompany.Name'));
        const series = text(field(f, 'ItemSeries.Name'));
        const melds = num(field(f, 'MateriaSlotCount')), dyes = num(field(f, 'DyeCount')), stack = num(field(f, 'StackSize'));
        const desc = text(field(f, 'Description'));
        put('ultimate', name, 'Item', [kind ? 'Item type: ' + kind : '', ilvl ? 'Item level ' + ilvl : '',
            equip > 1 ? 'Equip level ' + equip : '',
            users && users.length <= 60 ? 'Usable by: ' + users : '',
            craft ? 'Crafted by: ' + listOf(craft.jobs) + (craft.expert ? ' (expert recipe)' : '') : '',
            rarity ? 'Rarity: ' + rarity : '',
            market && fold(market) !== fold(kind) ? 'Market board: ' + market : '',
            w => textHint('Description', desc, w),
            gc ? 'Grand Company: ' + gc : '',
            series ? 'Item series: ' + series : '',
            melds ? melds + (melds === 1 ? ' materia slot' : ' materia slots') : '',
            dyes ? 'It can be dyed' : '',
            stack > 1 ? 'Stacks up to ' + stack : '',
            yes(field(f, 'CanBeHq')) ? 'It can be high quality' : '',
            yes(field(f, 'IsUnique')) ? 'It is unique' : '',
            yes(field(f, 'IsCollectable')) ? 'It is a collectable' : ''],
            loreOf([kind, ilvl ? 'Item level ' + ilvl : ''].filter(Boolean).join(' · '), desc));
    }
    return pools;
}

module.exports = {
    DIFFICULTIES, DIFF, MILESTONES, HINTS_PER_GUESS, ZWSP, HIDDEN,
    dayOf, addDays, seasonOf, msToReset,
    fold, foldChar, sameAnswer, cells, letterPositions, matchingLetters, renderBoxes, indicator,
    bitsFor, liveStreak, nextStreak, seedOf, pickWord,
    titleCase, capFirst, goodName, makeHints, hintText, hintLetter, field, num, text, buildPools, cleanLore
};
