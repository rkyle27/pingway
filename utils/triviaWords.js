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
// - Languages (en, fr, de, ja): every word has an id (e.g. 'job:19') and its official name, clues and lore in each
//   language (bank entry .i18n.fr/.de/.ja). The difficulty rules (which pool, which rows count) always use the English
//   data, so a word is in the same difficulty in every language. Only words whose name works in all 4 languages
//   are picked as the word of the day (see isComplete).
//   * fr/de: same rules as English (accents folded: é = e, ß = ss; de also takes ae/oe/ue for ä/ö/ü). An accented
//     letter is shown as the real letter (É, Ü) instead of a 🇦-style box.
//   * ja: each character is one "letter" (kana, kanji, ー). Answers are compared after NFKC (full/half width),
//     katakana -> hiragana, and without spaces, ・ and ー. Kanji must be the same. Shown letters are the real characters.

const crypto = require('crypto');
const i18n = require('./i18n');
const LANGS = i18n.LANGS;

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
// Japanese: one character as it is compared (NFKC full/half width, lower case, katakana -> hiragana, Latin accents folded)
function jaKey(ch) {
    let s = String(ch || '').normalize('NFKC').toLowerCase();
    s = s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
    if (/\p{Script=Latin}/u.test(s)) s = Array.from(s).map(c => (/\p{Script=Latin}/u.test(c) ? foldChar(c) : c)).join('');
    return s;
}
// German: ä/ö/ü also as ae/oe/ue
const DE_UMLAUT = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'ae', 'Ö': 'oe', 'Ü': 'ue' };
const foldDe = text => fold(String(text || '').normalize('NFC').replace(/[äöüÄÖÜ]/g, c => DE_UMLAUT[c]));
// The text as it is compared, in a language (en/fr/de: letters a-z only; ja: see jaKey, no spaces/symbols/ー)
function foldFor(text, lang) {
    if (lang !== 'ja') return fold(text);
    let out = '';
    for (const ch of Array.from(String(text || '').normalize('NFKC'))) {
        if (ch === 'ー' || !/\p{L}/u.test(ch)) continue;
        out += jaKey(ch);
    }
    return out;
}
// Same answer? (lang: the language of both texts; default English)
function sameAnswer(a, b, lang) {
    if (!lang || lang === 'en' || lang === 'fr') return fold(a) !== '' && fold(a) === fold(b);
    if (lang === 'de') {
        const A = [fold(a), foldDe(a)], B = [fold(b), foldDe(b)];
        return A.some(x => x !== '' && B.includes(x));
    }
    const fa = foldFor(a, lang);
    return fa !== '' && fa === foldFor(b, lang);
}

// One cell per character: letter (a box), space (a gap) or sym (always shown). l = the letter as compared,
// ch = the real character (shown for accented letters and in Japanese)
function cells(word, lang) {
    if (lang === 'ja') {
        return Array.from(String(word).normalize('NFC')).map(ch => {
            if (/\s/.test(ch)) return { t: 'space' };
            if (/\p{L}/u.test(ch)) {
                const l = jaKey(ch);
                if (l) return { t: 'letter', l, ch };
            }
            return { t: 'sym', ch };
        });
    }
    return Array.from(String(word).normalize('NFC')).map(ch => {
        if (/\s/.test(ch)) return { t: 'space' };
        if (/\p{L}/u.test(ch)) {
            const f = foldChar(ch);
            if (f) return { t: 'letter', l: f[0], ch };
        }
        return { t: 'sym', ch };
    });
}
const letterPositions = (word, lang) => cells(word, lang).map((c, i) => (c.t === 'letter' ? i : -1)).filter(i => i >= 0);
// Letter positions of the answer where the guess has the same letter in the same place:
// the k-th letter of the guess vs the k-th letter of the answer (spaces, symbols and digits skipped, accents folded)
function matchingLetters(word, guessText, lang) {
    const ans = cells(word, lang).map((c, i) => ({ c, i })).filter(x => x.c.t === 'letter');
    const typed = lang === 'ja' ? String(guessText || '').normalize('NFKC') : guessText;
    const g = cells(typed, lang).filter(c => c.t === 'letter' && c.l !== 'ー').map(c => c.l);
    if (lang === 'ja') {
        // ー is often left out when typing: compare without it
        const a2 = ans.filter(x => x.c.l !== 'ー');
        const out = [];
        for (let k = 0; k < a2.length && k < g.length; k++) if (a2[k].c.l === g[k]) out.push(a2[k].i);
        return out;
    }
    const out = [];
    for (let k = 0; k < ans.length && k < g.length; k++) if (ans[k].c.l === g[k]) out.push(ans[k].i);
    return out;
}

const ZWSP = '​';
const HIDDEN = '⬜';
const indicator = l => String.fromCodePoint(0x1F1E6 + (l.charCodeAt(0) - 97));
const escMd = ch => (/[\\*_~`|>#\[\]()]/.test(ch) ? '\\' + ch : ch);

// An accented letter as shown (upper case when that stays one character, e.g. é -> É, ß stays ß)
const upperOne = ch => { const u = String(ch).toUpperCase(); return Array.from(u).length === 1 ? u : ch; };
// How a shown letter looks: 🇦..🇿 (English, and plain a-z in fr/de), the real letter (accented fr/de), the character (ja)
function shownLetter(c, lang) {
    if (lang === 'ja') return escMd(c.ch);
    if ((lang === 'fr' || lang === 'de') && c.ch && c.ch.toLowerCase() !== c.l) return escMd(upperOne(c.ch));
    return indicator(c.l);
}
// The boxes line. revealed = cell positions that are shown. showAll = every letter shown.
function renderBoxes(word, revealed, showAll, lang) {
    const open = new Set((revealed || []).map(Number));
    let out = '';
    let prevBox = false;
    const ja = lang === 'ja';
    for (const [i, c] of cells(word, lang).entries()) {
        if (c.t === 'space') { out += ja ? '\u3000' : '   '; prevBox = false; continue; }
        if (c.t === 'sym') { out += escMd(c.ch); prevBox = false; continue; }
        if (prevBox && !ja) out += ZWSP; // keeps 🇺🇸-style flags from forming
        out += (showAll || open.has(i)) ? (lang && lang !== 'en' ? shownLetter(c, lang) : indicator(c.l)) : HIDDEN;
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
    const file = process.env.PINGWAY_TRIVIA_SALT_FILE || path.join(__dirname, '..', 'data', 'trivia_salt.txt'); // env: tests only
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
// fr/de/ja game names: no markup (<SoftHyphen/>, soft hyphens, German [a]/[p] grammar marks)
const cleanGameName = s => String(s || '').replace(/<[^>]*>/g, '').replace(/­/g, '').replace(/\[[a-zA-Z]{1,2}\]/g, '').replace(/\s+/g, ' ').trim();

// Characters a Japanese answer may have: kana, kanji, Latin letters, digits, spaces, ・ ー 々 and a few joiners
const JA_OK = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Latin}0-9０-９ー・･々〆　 '’\-－]+$/u;
// Names Pingway can use as answers: 4+ letters, up to 32 characters, not mostly digits, no odd characters
// (ja: 2+ characters, up to 20, only the characters above)
function goodName(name, lang) {
    const n = String(name || '').trim();
    if (lang === 'ja') {
        if (!n || n.length > 20 || !JA_OK.test(n)) return false;
        const letters = cells(n, 'ja').filter(c => c.t === 'letter').length;
        if (letters < 2) return false;
        const digits = (n.normalize('NFKC').match(/\d/g) || []).length;
        return digits < letters;
    }
    if (!n || n.length > 32) return false;
    if (/[<>{}\[\]@#\/\\|_=+*^%$]/.test(n) || /[　-鿿]/.test(n)) return false;
    const letters = fold(n).length;
    if (letters < 4) return false;
    const digits = (n.match(/\d/g) || []).length;
    if (digits >= letters) return false;
    return true;
}

// Words of the answer that would give it away when found in a hint
function giveaway(word, lang) {
    if (!lang || lang === 'en') return String(word).split(/[\s\-']+/).map(fold).filter(w => w.length >= 4);
    if (lang === 'ja') return String(word).split(/[\s・･　]+/).map(w => foldFor(w, 'ja')).filter(w => w.length >= 2);
    return String(word).split(/[\s\-'’]+/).map(fold).filter(w => w.length >= 4);
}
// True when a text contains the answer or a big part of it
function leaks(word, value, lang) {
    const f = foldFor(value, lang);
    const whole = foldFor(word, lang);
    return f.includes(whole) || giveaway(word, lang).some(w => f.includes(w));
}
// A hint is a plain string, or { text, letter } when it shows a letter of the answer (letter = 0-based letter index,
// spaces/symbols/digits not counted). Old saved words have plain strings only.
const hintText = h => (h && typeof h === 'object') ? String(h.text || '') : String(h === undefined || h === null ? '' : h);
// The letter key of one typed/shown character (to check the letter a clue names)
const keyOf = (ch, lang) => (lang === 'ja' ? jaKey(ch) : foldChar(ch).charAt(0));
// Cell position of the letter a clue shows (for the boxes / revealed), or -1. Plain strings: the "First letter: X" format.
function hintLetter(word, h, lang) {
    const lp = letterPositions(word, lang);
    let k = -1;
    if (h && typeof h === 'object') {
        if (Number.isInteger(h.letter)) k = h.letter;
    } else if (/^First letter: \S$/u.test(String(h || '').trim())) {
        k = 0;
    }
    if (k < 0 || k >= lp.length) return -1;
    // The letter named in the text must be that letter of the answer
    const m = /:\s*(\S)$/u.exec(hintText(h).trim());
    if (m && keyOf(m[1], lang) !== cells(word, lang)[lp[k]].l) return -1;
    return lp[k];
}
const MAX_HINTS = 10;
// Clean list of up to 10 hints (Category first, First letter last): no empty ones, no repeats, none that contain
// (a big part of) the answer
function makeHints(word, specific, lang) {
    const out = [];
    const seenText = new Set();
    const add = (h, room) => {
        const t = hintText(h).trim();
        if (!t || out.length >= room) return;
        const value = t.split(': ').slice(1).join(': ') || t;
        if (!foldFor(value, lang) || leaks(word, value, lang)) return;
        if (seenText.has(t)) return;
        seenText.add(t);
        out.push(h);
    };
    const first = cells(word, lang).find(c => c.t === 'letter');
    for (const h of specific) add(h, first ? MAX_HINTS - 1 : MAX_HINTS);
    if (first) {
        const shown = !lang || lang === 'en' ? first.l.toUpperCase() : lang === 'ja' ? first.ch : upperOne(first.ch);
        add({ text: i18n.t(lang || 'en', 'trivia.hints.firstLetter', { l: shown }), letter: 0 }, MAX_HINTS);
    }
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

// Lore / more info shown after a solve: no game markup (<...>), no odd control characters, at most ~600 characters
// (cut at the end of a sentence when possible; ja sentences end with 。！？). Line breaks stay.
function cleanLore(raw, max = 600, lang) {
    if (typeof raw !== 'string') return '';
    let t = raw.replace(/\r\n?/g, '\n').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮￼�]/g, '');
    if (lang && lang !== 'en') t = t.replace(/­/g, '');
    t = t.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    let end = -1;
    const re = lang === 'ja' ? /[。！？]|[.!?…](?=\s|$)/g : /[.!?…](?=\s|$)/g;
    let m;
    while ((m = re.exec(cut))) end = m.index + 1;
    if (end >= max * 0.4) return cut.slice(0, end).trim();
    const sp = cut.lastIndexOf(' ');
    return cut.slice(0, sp > max * 0.5 ? sp : max).trim() + '…';
}
// A short quote (Tooltip of mounts/minions) as italic lines
function quoteLines(raw, lang) {
    const q = cleanLore(raw, 300, lang);
    return q ? q.split('\n').filter(Boolean).map(l => '*' + l.replace(/\*/g, '') + '*').join('\n') : '';
}
const byRow = rows => new Map((rows || []).map(r => [Number(r.row_id), r.fields || {}]));

// A short one-line clue from a game text (Description / Tooltip): no markup, the answer's words masked as ???,
// first sentence (or first ~150 characters, ja ~90). '' when too short. makeHints still drops it if a part of the answer is left.
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function textHint(label, raw, word, max, lang) {
    const ja = lang === 'ja';
    if (max === undefined) max = ja ? 90 : 150;
    let t = cleanLore(typeof raw === 'string' ? raw : '', 600, lang).replace(/\s*\n\s*/g, ' ').trim();
    if (!t) return '';
    if (ja) {
        // No spaces between Japanese words: mask the name (and its parts) exactly
        const parts = [String(word)].concat(String(word).split(/[\s・･]+/).filter(w => foldFor(w, 'ja').length >= 2));
        for (const w of parts) t = t.split(w).join('???');
    } else {
        const split = !lang || lang === 'en' ? /[\s\-']+/ : /[\s\-'’]+/;
        const parts = [String(word)].concat(String(word).split(split).filter(w => fold(w).length >= 4));
        for (const w of parts) t = t.replace(new RegExp('\\p{L}*' + escRe(w) + '\\p{L}*', 'giu'), '???');
    }
    const m = ja ? /^.*?[。！？!?]/u.exec(t) : /^.*?[.!?…](?=\s|$)/u.exec(t);
    if (m && m[0].length >= (ja ? 10 : 20)) t = m[0];
    if (t.length > max) {
        const cut = t.slice(0, max);
        const sp = cut.lastIndexOf(' ');
        t = cut.slice(0, sp > max * 0.5 ? sp : max).trim() + '…';
    }
    t = t.replace(/[*_~`|\\]/g, '').replace(/@/g, '@​').trim();
    if (t.replace(/\?\?\?/g, '').replace(/[^\p{L}]/gu, '').length < (ja ? 6 : 10)) return '';
    return !lang || lang === 'en' ? label + ': ' + t : i18n.t(lang, 'trivia.hints.labelValue', { label, v: t });
}
const yes = v => v === true || v === 1;
const listOf = (items, max = 3, sep = ', ') => items.filter(Boolean).slice(0, max).join(sep);

const ROLE_IDS = [1, 2, 3, 4];
const STAT_IDS = [1, 2, 3, 4, 5];
const RARITY_IDS = [1, 2, 3, 4, 7];
const CRAFTERS = { woodworking: 'Carpenter', smithing: 'Blacksmith', armorcraft: 'Armorer', goldsmithing: 'Goldsmith', leatherworking: 'Leatherworker', clothcraft: 'Weaver', alchemy: 'Alchemist', cooking: 'Culinarian' };
const ROULETTES = ['LevelingRoulette', 'HighLevelRoulette', 'ExpertRoulette', 'TrialRoulette', 'AllianceRoulette', 'NormalRaidRoulette', 'MSQRoulette'];

// Plural form of a count in a language ('one' | 'other', the suffix of the _one/_other keys in the locale files)
function pluralOf(lang, n) {
    try { return new Intl.PluralRules(lang || 'en').select(Number(n)) === 'one' ? 'one' : 'other'; } catch (e) { return Number(n) === 1 ? 'one' : 'other'; }
}

// Sorts the raw XIVAPI rows into the 6 pools. raw = { classJobs, territories, content, mounts, minions, actions, items,
// recipes, and the *Transient sheets mountLore, minionLore, actionLore, contentLore (same row_id as the base sheet) }
// (arrays of { row_id, fields }). Returns { easy: [{ id, word, category, hints, lore }], ... }.
// Fields that are missing in the data just give no hint.
// opts.lang: the language of raw (default 'en'); opts.en: the English rows (needed for other languages: the rules that
// decide the difficulty and which rows count always read the English data, so the pools are the same in every language).
function buildPools(raw, opts) {
    const lang = (opts && opts.lang) || 'en';
    const en = lang === 'en';
    const E = (opts && opts.en) || raw;
    const L = (key, vars) => i18n.t(lang, 'trivia.hints.' + key, vars);
    const LP = (key, n, vars) => i18n.t(lang, 'trivia.hints.' + key + '_' + pluralOf(lang, n), Object.assign({ n }, vars));
    const labeled = (key, v) => (v ? L(key, { v }) : '');
    const F = s => foldFor(s, lang);
    const sep = L('listSep');
    const loreSep = L('loreSep');
    const nm = s => (en ? s : cleanGameName(s));
    const nameCase = s => (en ? titleCase(s) : capFirst(cleanGameName(s)));
    const loreOf = (...parts) => cleanLore(parts.filter(p => p && String(p).trim()).join('\n'), 600, lang);
    const twin = (key, r) => (en ? (r.fields || {}) : (enRows[key].get(Number(r.row_id)) || {})); // the English row of r
    const enRows = {};
    for (const key of ['classJobs', 'territories', 'content', 'mounts', 'minions', 'actions', 'items', 'recipes']) enRows[key] = en ? null : byRow(E[key]);
    const seconds = v => { const s = num(v) / 10; const x = Math.round(s * 10) / 10; return L('seconds', { n: en || lang === 'ja' ? String(x) : String(x).replace('.', ',') }); };
    const safeOther = (word, names) => names.find(n => n && F(n) !== F(word) && !leaks(word, n, lang)) || '';

    const pools = { easy: [], normal: [], hard: [], extreme: [], savage: [], ultimate: [] };
    const seen = { easy: new Set(), normal: new Set(), hard: new Set(), extreme: new Set(), savage: new Set(), ultimate: new Set() };
    const mountLore = byRow(raw.mountLore), minionLore = byRow(raw.minionLore), actionLore = byRow(raw.actionLore), contentLore = byRow(raw.contentLore);
    const transient = (map, id) => {
        const f = map.get(Number(id)) || {};
        const body = text(f.DescriptionEnhanced) || text(f.Description);
        return loreOf(body, quoteLines(text(f.Tooltip), lang));
    };
    // Quote (Tooltip) and description clues of a mount/minion
    const transientHints = (map, id, word) => {
        const f = map.get(Number(id)) || {};
        return [textHint(L('quote'), text(f.Tooltip), word, undefined, lang), textHint(L('description'), text(f.DescriptionEnhanced) || text(f.Description), word, undefined, lang)];
    };
    const put = (diff, id, word, catKey, hints, lore) => {
        word = String(word || '').trim().replace(/\s+/g, ' ');
        if (!goodName(word, lang)) return;
        const key = F(word);
        if (seen[diff].has(key)) return;
        seen[diff].add(key);
        const category = L('cat.' + catKey);
        // Text clues are made for the name before cleaning; make them again if the name changed
        pools[diff].push({ id, word, category, hints: makeHints(word, [L('category', { v: category }), ...hints.map(h => (typeof h === 'function' ? h(word) : h))], lang), lore: lore || '' });
    };
    const longName = w => String(w).trim().split(/\s+/).length >= 3 || String(w).trim().length >= 20;

    // Easy: jobs and classes
    const jobRows = (raw.classJobs || []).map(r => {
        const f = r.fields || {};
        const fe = twin('classJobs', r);
        return { id: Number(r.row_id), f, fe, name: nameCase(text(field(f, 'Name'))), enName: titleCase(text(field(fe, 'Name'))),
            isJob: num(field(f, 'JobIndex')) > 0, parent: nameCase(text(field(f, 'ClassJobParent.Name'))) };
    });
    const jobByEnName = new Map(jobRows.map(j => [j.enName, j.name]));
    for (const { id, f, fe, name, enName, isJob, parent } of jobRows) {
        if (!name || enName.toLowerCase() === 'adventurer') continue;
        const roleNo = num(field(f, 'Role'));
        const role = ROLE_IDS.includes(roleNo) ? L('roles.' + roleNo) : '';
        const abbr = text(field(f, 'Abbreviation'));
        const disciple = /^disciples? of /i.test(text(field(fe, 'ClassJobCategory.Name'))) ? text(field(f, 'ClassJobCategory.Name')) : '';
        // "Nowheresville" = the game's placeholder (no real starting city)
        const town = /^nowheresville$/i.test(text(field(fe, 'StartingTown.Name'))) ? '' : nm(text(field(f, 'StartingTown.Name')));
        const startLevel = num(field(f, 'StartingLevel'));
        const statNo = num(field(f, 'PrimaryStat'));
        const stat = STAT_IDS.includes(statNo) ? L('stats.' + statNo) : '';
        const becomes = isJob ? '' : safeOther(name, jobRows.filter(j => j.isJob && j.parent === name).map(j => j.name));
        const startsAs = isJob && parent && parent !== name;
        put('easy', 'job:' + id, name, isJob ? 'job' : 'class', [
            labeled('role', role),
            labeled('type', disciple),
            labeled('mainStat', stat),
            labeled('startingCity', town),
            startLevel > 1 ? L('startsAtLevel', { n: startLevel }) : '',
            yes(field(f, 'IsLimitedJob')) ? L('limitedJob') : '',
            labeled('becomes', becomes),
            startsAs ? L('startsAs', { v: parent }) : '',
            labeled('abbreviation', abbr)
        ], loreOf(L('lore.line', {
            name, abbr: abbr ? L('lore.abbr', { v: abbr }) : '',
            what: L('lore.' + (isJob ? 'job' : 'class') + (role ? 'Role' : ''), { role }),
            startsAs: startsAs ? L('lore.startsAs', { v: parent }) : ''
        })));
    }
    // Easy: cities and regions. Normal: field zones.
    const places = (raw.territories || []).map(r => {
        const f = r.fields || {};
        return { place: nm(text(field(f, 'PlaceName.Name'))), placeId: num(field(f, 'PlaceName')) || 't' + r.row_id,
            region: nm(text(field(f, 'PlaceNameRegion.Name'))), regionId: num(field(f, 'PlaceNameRegion')), area: nm(text(field(f, 'PlaceNameZone.Name'))),
            exp: nm(text(field(f, 'ExVersion.Name'))), use: num(field(f, 'TerritoryIntendedUse')) };
    }).filter(t => t.use === 0 || t.use === 1);
    const inRegion = (region, use) => places.filter(t => t.place && t.region === region && (use === undefined || t.use === use)).map(t => capFirst(t.place))
        .filter((n, i, a) => a.indexOf(n) === i);
    const variant = (key, region, exp) => L(key + '.' + (region && exp ? 'full' : region ? 'region' : exp ? 'exp' : 'plain'), { region, exp });
    const regionSeen = new Set();
    for (const t of places) {
        const { place, region, area, exp, use } = t;
        const name = capFirst(place);
        const hints = [labeled('region', region), labeled('expansion', exp),
            area && F(area) !== F(place) && F(area) !== F(region) ? L('area', { v: area }) : '',
            region ? labeled('alsoInRegion', safeOther(name, inRegion(region))) : ''].filter(h => !/: $/.test(h));
        if (use === 0 && place) put('easy', 'place:' + t.placeId, name, 'city', hints, variant('lore.city', region, exp));
        if (use === 1 && place) put('normal', 'place:' + t.placeId, name, 'zone', hints, variant('lore.zone', region, exp));
        if (region && !regionSeen.has(region)) {
            regionSeen.add(region);
            const R = capFirst(region);
            const zones = inRegion(region, 1), cities = inRegion(region, 0);
            const zone2 = safeOther(R, zones);
            put('easy', 'region:' + (t.regionId || F(region)), R, 'region', [labeled('expansion', exp),
                zones.length ? LP('fieldZones', zones.length) : '',
                cities.length ? labeled('cityThere', safeOther(R, cities)) : '',
                labeled('zoneThere', zone2),
                zone2 ? labeled('anotherZoneThere', safeOther(R, zones.filter(z => z !== zone2))) : ''
            ].filter(h => !/: $/.test(h)), L('lore.region.' + (exp ? 'exp' : 'plain'), { exp }));
        }
    }
    // Hard: dungeons. Extreme: trials and raids.
    for (const r of raw.content || []) {
        const f = r.fields || {};
        const fe = twin('content', r);
        const name = capFirst(nm(text(field(f, 'Name'))));
        const type = text(field(fe, 'ContentType.Name'));
        const level = num(field(f, 'ClassJobLevelRequired'));
        const sync = num(field(f, 'ClassJobLevelSync'));
        const ilvl = num(field(f, 'ItemLevelRequired'));
        const ilvlSync = num(field(f, 'ItemLevelSync'));
        const zone = nm(text(field(f, 'TerritoryType.PlaceName.Name')));
        const region = nm(text(field(f, 'TerritoryType.PlaceNameRegion.Name')));
        const exp = nm(text(field(f, 'TerritoryType.ExVersion.Name')));
        const roulettes = ROULETTES.filter(k => yes(field(f, k))).map(k => L('roulettes.' + k));
        const desc = text(field(contentLore.get(Number(r.row_id)) || {}, 'Description'));
        const hints = [level ? L('level', { n: level }) : '', labeled('expansion', exp), ilvl ? L('itemLevel', { n: ilvl }) : '',
            roulettes.length ? L('roulette', { v: listOf(roulettes, 3, sep) }) : '', labeled('region', region),
            zone && F(zone) !== F(name) ? L('zone', { v: zone }) : '', yes(field(f, 'HighEndDuty')) ? L('highEnd') : '',
            sync && sync !== level ? L('levelSync', { n: sync }) : '', ilvlSync ? L('itemLevelSync', { n: ilvlSync }) : '',
            w => textHint(L('description'), desc, w, undefined, lang)];
        const cat = /^dungeons?$/i.test(type) ? 'dungeon' : /trial/i.test(type) ? 'trial' : (/raid/i.test(type) && !/ultimate/i.test(type)) ? (/alliance/i.test(type) ? 'allianceRaid' : 'raid') : null;
        if (!cat) continue;
        const lore = loreOf([L('cat.' + cat), level ? L('level', { n: level }) : '', exp].filter(Boolean).join(loreSep), desc);
        put(cat === 'dungeon' ? 'hard' : 'extreme', 'duty:' + r.row_id, name, cat, hints, lore);
    }
    // Mounts: Normal (short names) or Ultimate (long names; the English name decides)
    for (const r of raw.mounts || []) {
        const f = r.fields || {};
        const name = nameCase(text(field(f, 'Singular')));
        const enName = en ? name : titleCase(text(field(twin('mounts', r), 'Singular')));
        if (!name || !enName) continue;
        const seats = field(f, 'ExtraSeats');
        const riders = seats === undefined || seats === null ? 0 : num(seats) + 1;
        put(longName(enName) ? 'ultimate' : 'normal', 'mount:' + r.row_id, name, 'mount', [
            riders ? LP('seats', riders) : '',
            w => transientHints(mountLore, r.row_id, w)[0], w => transientHints(mountLore, r.row_id, w)[1]
        ], transient(mountLore, r.row_id));
    }
    // Minions: Extreme (short names) or Ultimate (long names; the English name decides)
    for (const r of raw.minions || []) {
        const f = r.fields || {};
        const name = nameCase(text(field(f, 'Singular')));
        const enName = en ? name : titleCase(text(field(twin('minions', r), 'Singular')));
        if (!name || !enName) continue;
        const t = minionLore.get(Number(r.row_id)) || {};
        const race = nm(text(field(f, 'MinionRace.Name')));
        const move = nm(text(field(f, 'Behavior.Name')));
        const skill = nm(text(field(t, 'MinionSkillType.Name')));
        const special = nm(text(field(t, 'SpecialActionName')));
        const atk = num(field(t, 'Attack')), def = num(field(t, 'Defense')), spd = num(field(t, 'Speed'));
        put(longName(enName) ? 'ultimate' : 'extreme', 'minion:' + r.row_id, name, 'minion', [
            labeled('minionRace', race),
            labeled('behavior', move),
            labeled('skillType', skill),
            labeled('specialAction', special),
            atk || def || spd ? L('verminionStats', { atk, def, spd }) : '',
            w => transientHints(minionLore, r.row_id, w)[0], w => transientHints(minionLore, r.row_id, w)[1]
        ], transient(minionLore, r.row_id));
    }
    // Actions: Hard (level 50 or lower), Savage (all of them)
    for (const r of raw.actions || []) {
        const f = r.fields || {};
        if (field(f, 'IsPvP') === true || field(f, 'IsPlayerAction') === false) continue;
        const name = nm(text(field(f, 'Name')));
        const jobEn = titleCase(text(field(twin('actions', r), 'ClassJob.Name')));
        const level = num(field(f, 'ClassJobLevel'));
        if (!name || !level) continue;
        const isRole = !(jobEn && jobEn.toLowerCase() !== 'adventurer');
        const job = en ? jobEn : nameCase(text(field(f, 'ClassJob.Name')));
        const who = isRole ? L('roleAction') : job;
        const kind = nm(text(field(f, 'ActionCategory.Name')));
        const users = nm(text(field(f, 'ClassJobCategory.Name')));
        const cast = field(f, 'Cast100ms'), recast = field(f, 'Recast100ms');
        const range = num(field(f, 'Range')), radius = num(field(f, 'EffectRange')), charges = num(field(f, 'MaxCharges'));
        const targets = [yes(field(f, 'CanTargetHostile')) ? L('targetEnemies') : '', yes(field(f, 'CanTargetParty')) ? L('targetParty') : '',
            yes(field(f, 'CanTargetSelf')) ? L('targetSelf') : ''].filter(Boolean);
        const desc = text(field(actionLore.get(Number(r.row_id)) || {}, 'Description'));
        const hints = [isRole ? L('roleAction') : L('job', { v: job }), L('level', { n: level }),
            labeled('actionType', kind),
            w => textHint(L('description'), desc, w, undefined, lang),
            cast === undefined || cast === null ? '' : num(cast) > 0 ? L('castTime', { v: seconds(cast) }) : L('instant'),
            recast === undefined || recast === null || num(recast) <= 0 ? '' : L('recast', { v: seconds(recast) }),
            !isRole && yes(field(f, 'IsRoleAction')) ? L('roleAction') : '',
            yes(field(f, 'TargetArea')) ? L('groundTargeted') : targets.length ? L('targets', { v: targets.join(sep) }) : '',
            range > 0 ? L('range', { n: range }) : '',
            radius > 0 ? L('radius', { n: radius }) : '',
            charges > 1 ? L('charges', { n: charges }) : '',
            users && users.length <= 60 ? L('usedBy', { v: users }) : ''];
        const lore = loreOf(who + loreSep + L('level', { n: level }), desc);
        if (level <= 50) put('hard', 'action:' + r.row_id, name, 'action', hints, lore);
        put('savage', 'action:' + r.row_id, name, 'action', hints, lore);
    }
    // Who crafts each item (Recipe sheet, joined in memory; other languages use the English recipes and their own job names)
    const crafted = new Map();
    for (const r of (en ? raw.recipes : (raw.recipes || E.recipes)) || []) {
        const f = r.fields || {};
        const fe = en ? f : (enRows.recipes.get(Number(r.row_id)) || f);
        const id = num(field(f, 'ItemResult'));
        const craft = text(field(fe, 'CraftType.Name'));
        if (!id || !craft) continue;
        const jobEn = CRAFTERS[craft.toLowerCase()] || craft;
        const job = en ? jobEn : (jobByEnName.get(jobEn) || jobEn);
        const c = crafted.get(id) || { jobs: [], expert: false };
        if (!c.jobs.includes(job)) c.jobs.push(job);
        if (yes(field(f, 'IsExpert'))) c.expert = true;
        crafted.set(id, c);
    }
    // Ultimate: marketable items with 2+ words (in English)
    for (const r of raw.items || []) {
        const f = r.fields || {};
        const name = nm(text(field(f, 'Name')));
        const enName = en ? name : text(field(twin('items', r), 'Name'));
        if (!name || !enName || enName.split(/\s+/).length < 2 || num(field(f, 'ItemSearchCategory')) <= 0) continue;
        const ilvl = num(field(f, 'LevelItem'));
        const kind = nm(text(field(f, 'ItemUICategory.Name')));
        const market = nm(text(field(f, 'ItemSearchCategory.Name')));
        const equip = num(field(f, 'LevelEquip'));
        const users = nm(text(field(f, 'ClassJobCategory.Name')));
        const rarityNo = num(field(f, 'Rarity'));
        const rarity = RARITY_IDS.includes(rarityNo) ? L('rarities.' + rarityNo) : '';
        const craft = crafted.get(Number(r.row_id));
        const gc = nm(text(field(f, 'GrandCompany.Name')));
        const series = nm(text(field(f, 'ItemSeries.Name')));
        const melds = num(field(f, 'MateriaSlotCount')), dyes = num(field(f, 'DyeCount')), stack = num(field(f, 'StackSize'));
        const desc = text(field(f, 'Description'));
        put('ultimate', 'item:' + r.row_id, name, 'item', [labeled('itemType', kind), ilvl ? L('itemLevel', { n: ilvl }) : '',
            equip > 1 ? L('equipLevel', { n: equip }) : '',
            users && users.length <= 60 ? L('usableBy', { v: users }) : '',
            craft ? L('craftedBy', { v: listOf(craft.jobs, 3, sep) + (craft.expert ? L('expertRecipe') : '') }) : '',
            labeled('rarity', rarity),
            market && F(market) !== F(kind) ? L('marketBoard', { v: market }) : '',
            w => textHint(L('description'), desc, w, undefined, lang),
            labeled('grandCompany', gc),
            labeled('itemSeries', series),
            melds ? LP('materia', melds) : '',
            dyes ? L('dyeable') : '',
            stack > 1 ? L('stacks', { n: stack }) : '',
            yes(field(f, 'CanBeHq')) ? L('hq') : '',
            yes(field(f, 'IsUnique')) ? L('unique') : '',
            yes(field(f, 'IsCollectable')) ? L('collectable') : ''],
            loreOf([kind, ilvl ? L('itemLevel', { n: ilvl }) : ''].filter(Boolean).join(loreSep), desc));
    }
    return pools;
}

// ---------- languages in the bank ----------
const OTHER_LANGS = LANGS.filter(l => l !== 'en');
// Adds .i18n = { fr: { word, category, hints, lore }, de, ja } to each English entry, from the pools built in the
// other languages (same id in the same difficulty). A language is left out when the name didn't work there.
function mergeLangPools(enPools, byLang) {
    for (const [key, list] of Object.entries(enPools)) {
        const idx = {};
        for (const [lang, pools] of Object.entries(byLang || {})) {
            idx[lang] = new Map();
            for (const e of (pools && pools[key]) || []) if (!idx[lang].has(e.id)) idx[lang].set(e.id, e);
        }
        for (const e of list) {
            const out = {};
            for (const lang of Object.keys(idx)) {
                const m = idx[lang].get(e.id);
                if (m) out[lang] = { word: m.word, category: m.category, hints: m.hints, lore: m.lore };
            }
            e.i18n = out;
        }
    }
    return enPools;
}
// True when the word has a usable name in every language (only these are picked as words of the day)
const isComplete = e => !!e && OTHER_LANGS.every(l => e.i18n && e.i18n[l] && e.i18n[l].word);
// The word in one language: { word, category, hints, lore, lang } (lang = the language really used: 'en' when the
// word has no name in that language, e.g. words saved before the bank had languages)
function viewOf(e, lang) {
    if (!e) return null;
    const x = lang && lang !== 'en' && e.i18n && e.i18n[lang];
    if (x && x.word) return { word: x.word, category: x.category || e.category, hints: Array.isArray(x.hints) ? x.hints : [], lore: x.lore || '', lang };
    return { word: e.word, category: e.category, hints: e.hints || [], lore: e.lore || '', lang: 'en' };
}

module.exports = {
    LANGS, DIFFICULTIES, DIFF, MILESTONES, HINTS_PER_GUESS, ZWSP, HIDDEN,
    dayOf, addDays, seasonOf, msToReset,
    fold, foldChar, foldFor, jaKey, sameAnswer, cells, letterPositions, matchingLetters, renderBoxes, indicator,
    bitsFor, liveStreak, nextStreak, seedOf, pickWord, pluralOf,
    titleCase, capFirst, cleanGameName, goodName, makeHints, hintText, hintLetter, leaks, field, num, text, buildPools, cleanLore, textHint,
    mergeLangPools, isComplete, viewOf
};
