// FFXIV Collect (https://ffxivcollect.com, public JSON API) - collection data for /ign, /collect and the PF Mount farm.
// Data by FFXIV Collect: every place that shows this data says so.
//
// API (read from the site's source, app/controllers/api + app/views/api):
//   GET /api/characters/{lodestoneId}?ids=1&latest=1  -> character summary: per collection { count, total, ids, public? },
//       achievements also { points, points_total, public }; 404 = not on FFXIV Collect yet, 403 = character private.
//       latest=1 makes FFXIV Collect read the Lodestone again only when its copy is older than 6 hours.
//
// Item lists (mounts, minions, achievements ...) are NEVER downloaded by Pingway. The owner makes the file himself
// (builder page) and puts it in data/ffxivcollect-lists.json; Pingway only reads it (see LISTS_FILE below):
//   { "format": "pingway-collect-1", "builtAt": "<ISO>", "langs": { "en": { "mounts": [items], "minions": [...], ... }, "fr": ..., "de": ..., "ja": ... } }
//   each item already slim: { id, name, icon (https), owned (% of FFXIV Collect players, number), sources [{ type, text }] (max 4) }
//   (achievements also desc (<= 300 chars) + points). Checked on load (bad items left out), kept in memory, read again
//   when the file changes (looked at once a minute at most), so it can be replaced without a restart.
//   A language that isn't in the file -> English. No file / a broken file -> empty lists + notLoaded (friendly message).
//
// Limits (be gentle): at most 2 requests at the same time, 300 ms between starts, 10 s timeout.
// Character cache (database, table ffxiv_collect_chars): refreshed at most every 6 hours; the manual 🔄 Refresh at most
// every 30 minutes per character. When the site is down, the last saved data is used (with a note).
// (The old table ffxiv_collect_lists is not used any more; it is left in the database untouched.)
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://ffxivcollect.com/api';
const UA = 'Pingway (FFXIV Discord bot)';
const TIMEOUT_MS = 10000;
const CHAR_TTL_MS = 6 * 60 * 60 * 1000;
const MANUAL_GAP_MS = 30 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 60 * 1000; // "not on FFXIV Collect" / "private" are asked again after 30 min
const LISTS_FILE = process.env.PINGWAY_COLLECT_LISTS_FILE || path.join(__dirname, '..', 'data', 'ffxivcollect-lists.json'); // env: tests only
const LISTS_FORMAT = 'pingway-collect-1';
const LISTS_CHECK_MS = 60 * 1000; // the file is looked at (fs.stat) at most once a minute
const MAX_PARALLEL = 2;
const SPACING_MS = 300;
const LANGS = ['en', 'fr', 'de', 'ja'];

// Collections Pingway uses (keys in the character summary and in the lists file), emoji for Discord texts.
const COLLECTIONS = {
    mounts: { emoji: '🐎' },
    minions: { emoji: '🐣' },
    achievements: { emoji: '🏆' },
    orchestrions: { emoji: '🎵' },
    emotes: { emoji: '💃' },
    hairstyles: { emoji: '💇' },
    bardings: { emoji: '🐤' },
    cards: { emoji: '🃏' }
};
const COLLECTION_KEYS = Object.keys(COLLECTIONS);

// IGN card stats (one switch each on the website, per character). NULL in the database = the default below:
// Mounts, Minions and Achievement points on (the best known numbers, they fit on one line), Orchestrion + Cards off.
const CARD_STATS = ['mounts', 'minions', 'achievements', 'orchestrions', 'cards'];
const STAT_COLUMNS = { mounts: 'cs_mounts', minions: 'cs_minions', achievements: 'cs_achievements', orchestrions: 'cs_orchestrions', cards: 'cs_cards' };
const STAT_DEFAULTS = { mounts: true, minions: true, achievements: true, orchestrions: false, cards: false };

// ---------- HTTP (gentle) ----------
async function axiosGet(url) {
    const axios = require('axios');
    try {
        const res = await axios.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: TIMEOUT_MS, validateStatus: () => true });
        return { status: res.status, data: res.data };
    } catch (e) {
        return { status: 0, data: null, error: e && e.message };
    }
}
let httpGet = axiosGet;
let running = 0;
let lastStart = 0;
const waiting = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function pump() {
    if (running >= MAX_PARALLEL || !waiting.length) return;
    running++;
    const job = waiting.shift();
    const wait = Math.max(0, lastStart + SPACING_MS - Date.now());
    lastStart = Date.now() + wait;
    sleep(wait).then(() => httpGet(job.url)).then(job.resolve, () => job.resolve({ status: 0, data: null })).finally(() => { running--; pump(); });
    pump();
}
function request(path) {
    return new Promise(resolve => { waiting.push({ url: BASE + path, resolve }); pump(); });
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
    await db.execute(`CREATE TABLE IF NOT EXISTS ffxiv_collect_chars (
        lodestone_id VARCHAR(20) NOT NULL PRIMARY KEY,
        status VARCHAR(16) NOT NULL,
        data MEDIUMTEXT NULL,
        fetched_at BIGINT NULL DEFAULT NULL,
        checked_at BIGINT NOT NULL,
        manual_at BIGINT NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // IGN card stat switches per character (NULL = default, see STAT_DEFAULTS); ign_characters is made by utils/ignClaims.js
    await require('./ignClaims').ensureTables(db);
    for (const c of Object.values(STAT_COLUMNS)) await addColumn(db, 'ign_characters', c, 'TINYINT(1) NULL DEFAULT NULL');
    ready = true;
}

// ---------- shapes ----------
const pct = v => { const n = parseFloat(String(v === undefined || v === null ? '' : v).replace('%', '')); return Number.isFinite(n) ? n : 0; };
const httpsOnly = u => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);

/** API character summary -> what Pingway keeps: { id, name, server, dataCenter, c: { mounts: { count, total, public, ids }, achievements: {.., points, pointsTotal } } } */
function slimCharacter(raw) {
    const out = { id: String(raw.id), name: raw.name || '', server: raw.server || '', dataCenter: raw.data_center || '', lastParsed: raw.last_parsed || null, c: {} };
    for (const key of COLLECTION_KEYS) {
        const x = raw[key];
        if (!x || typeof x !== 'object') continue;
        const pub = x.public !== false; // only some collections can be private ("public" is missing for the others)
        const v = { count: Number(x.count) || 0, total: Number(x.total) || 0, public: pub, ids: pub && Array.isArray(x.ids) ? x.ids.map(Number) : null };
        if (key === 'achievements') { v.points = Number(x.points) || 0; v.pointsTotal = Number(x.points_total) || 0; }
        out.c[key] = v;
    }
    return out;
}

/** API master list item -> { id, name, icon, owned (% of players), sources: [{ type, text }], desc?, points? }
 *  (the shape the owner's builder page writes into the lists file; Pingway itself never downloads the lists) */
function slimItem(collection, raw) {
    if (!raw || raw.id === undefined) return null;
    if (collection === 'minions' && raw.owned === undefined) return null; // minion variants (not summonable on their own)
    const it = { id: Number(raw.id), name: String(raw.name || ''), icon: httpsOnly(raw.icon), owned: pct(raw.owned),
        sources: Array.isArray(raw.sources) ? raw.sources.slice(0, 4).map(s => ({ type: String(s.type || ''), text: String(s.text || '') })) : [] };
    if (collection === 'achievements') { it.desc = String(raw.description || '').slice(0, 300); it.points = Number(raw.points) || 0; }
    return it;
}

// ---------- characters ----------
const inflight = new Map();
const parseData = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

async function readRow(db, id) {
    const [[row]] = await db.execute('SELECT lodestone_id, status, data, fetched_at, checked_at, manual_at FROM ffxiv_collect_chars WHERE lodestone_id = ?', [String(id)]);
    return row || null;
}
async function writeRow(db, id, status, data, fetchedAt, checkedAt, manualAt) {
    await db.execute(
        `INSERT INTO ffxiv_collect_chars (lodestone_id, status, data, fetched_at, checked_at, manual_at) VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), data = VALUES(data), fetched_at = VALUES(fetched_at), checked_at = VALUES(checked_at), manual_at = VALUES(manual_at)`,
        [String(id), status, data ? JSON.stringify(data) : null, fetchedAt, checkedAt, manualAt]
    );
}

/**
 * A character's collections -> { state, data, fetchedAt, stale, waitMin }
 * state: 'ok' | 'notfound' (not on FFXIV Collect yet) | 'private' | 'down' (site down, nothing saved) | 'limited' (manual refresh too soon)
 * stale: true when the site was down and the last saved data is used.
 * opts: { force (the 🔄 Refresh button), now, cacheOnly (never asks the site) }
 */
async function getCharacter(db, lodestoneId, opts) {
    const o = opts || {};
    const id = String(lodestoneId || '');
    if (!/^\d{1,20}$/.test(id)) return { state: 'notfound', data: null };
    const key = id + (o.force ? ':f' : '');
    if (inflight.has(key)) return inflight.get(key);
    const p = loadCharacter(db, id, o).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}
async function loadCharacter(db, id, o) {
    const now = typeof o.now === 'number' ? o.now : Date.now();
    await ensureTables(db);
    const row = await readRow(db, id);
    const saved = row ? parseData(row.data) : null;
    const savedAt = row && row.fetched_at !== null && row.fetched_at !== undefined ? Number(row.fetched_at) : null;
    const okSaved = saved && savedAt !== null ? { state: 'ok', data: saved, fetchedAt: savedAt, stale: false } : null;
    if (o.force) {
        const last = row && row.manual_at !== null && row.manual_at !== undefined ? Number(row.manual_at) : null;
        if (last !== null && now - last < MANUAL_GAP_MS) {
            return Object.assign({}, okSaved || { state: row.status === 'ok' ? 'down' : row.status, data: null }, { state: 'limited', waitMin: Math.ceil((MANUAL_GAP_MS - (now - last)) / 60000), saved: okSaved });
        }
    } else {
        if (o.cacheOnly) return okSaved || { state: row ? (row.status === 'ok' ? 'down' : row.status) : 'none', data: null };
        if (row && row.status === 'ok' && okSaved && now - savedAt < CHAR_TTL_MS) return okSaved;
        if (row && (row.status === 'notfound' || row.status === 'private') && now - Number(row.checked_at) < NEGATIVE_TTL_MS) return { state: row.status, data: null };
    }
    const res = await request('/characters/' + id + '?ids=1&latest=1');
    const manualAt = o.force ? now : (row && row.manual_at !== undefined ? row.manual_at : null);
    if (res.status === 200 && res.data && typeof res.data === 'object' && res.data.id !== undefined) {
        const data = slimCharacter(res.data);
        await writeRow(db, id, 'ok', data, now, now, manualAt);
        return { state: 'ok', data, fetchedAt: now, stale: false };
    }
    if (res.status === 404 || res.status === 403) {
        const st = res.status === 404 ? 'notfound' : 'private';
        await writeRow(db, id, st, null, null, now, manualAt);
        return { state: st, data: null };
    }
    // site down / unexpected answer: keep what we had
    if (o.force && row) await db.execute('UPDATE ffxiv_collect_chars SET manual_at = ? WHERE lodestone_id = ?', [now, id]);
    if (okSaved) return Object.assign({}, okSaved, { stale: true });
    return { state: 'down', data: null };
}

/** Saved data of many characters (leaderboard), never asks the site -> Map lodestoneId -> { data, fetchedAt, status } */
async function cachedMany(db, ids) {
    await ensureTables(db);
    const out = new Map();
    const list = [...new Set(ids.map(String))].filter(x => /^\d{1,20}$/.test(x));
    for (let i = 0; i < list.length; i += 200) {
        const part = list.slice(i, i + 200);
        const [rows] = await db.execute('SELECT lodestone_id, status, data, fetched_at FROM ffxiv_collect_chars WHERE lodestone_id IN (' + part.map(() => '?').join(', ') + ')', part);
        for (const r of rows) out.set(String(r.lodestone_id), { status: r.status, data: parseData(r.data), fetchedAt: r.fetched_at === null || r.fetched_at === undefined ? null : Number(r.fetched_at) });
    }
    return out;
}

// Lazy background refresh (leaderboard): a few characters at a time, through the same gentle queue
const queued = new Set();
function refreshLater(db, ids, max) {
    let n = 0;
    for (const id of ids) {
        if (n >= (max || 10)) break;
        if (queued.has(String(id))) continue;
        queued.add(String(id));
        n++;
        getCharacter(db, id).catch(() => {}).finally(() => queued.delete(String(id)));
    }
    return n;
}

// ---------- item lists (local file only, never downloaded) ----------
let listsFile = LISTS_FILE;
const listState = { data: null, sig: null, checkedAt: null, loading: null };

/** One item of the file -> the clean item, or null (left out) */
function cleanItem(collection, x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    if (typeof x.id !== 'number' || !Number.isInteger(x.id) || x.id <= 0) return null;
    if (typeof x.name !== 'string' || !x.name.trim()) return null;
    if (typeof x.owned !== 'number' || !Number.isFinite(x.owned) || x.owned < 0 || x.owned > 100) return null;
    if (x.sources !== undefined && x.sources !== null && !Array.isArray(x.sources)) return null;
    const str = v => (typeof v === 'string' ? v : '');
    const it = { id: x.id, name: x.name, icon: httpsOnly(x.icon), owned: x.owned,
        sources: (x.sources || []).filter(s => s && typeof s === 'object' && !Array.isArray(s)).slice(0, 4).map(s => ({ type: str(s.type), text: str(s.text) })) };
    if (collection === 'achievements') { it.desc = str(x.desc).slice(0, 300); it.points = typeof x.points === 'number' && Number.isFinite(x.points) ? x.points : 0; }
    return it;
}

/** The parsed file -> { builtAt, langs: { en: { mounts: [...] } } } or null (wrong format / nothing usable) */
function parseListsFile(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.format !== LISTS_FORMAT) return null;
    if (!raw.langs || typeof raw.langs !== 'object' || Array.isArray(raw.langs)) return null;
    const out = { builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null, langs: {}, dropped: 0 };
    let any = false;
    for (const l of LANGS) {
        const src = raw.langs[l];
        if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
        const per = {};
        for (const c of COLLECTION_KEYS) {
            if (!Array.isArray(src[c])) continue;
            const seen = new Set();
            per[c] = [];
            for (const x of src[c]) {
                const it = cleanItem(c, x);
                if (!it || seen.has(it.id)) { out.dropped++; continue; }
                seen.add(it.id);
                per[c].push(it);
            }
            any = true;
        }
        out.langs[l] = per;
    }
    return any ? out : null;
}

/** The lists from the file (read once, again when the file changed; looked at once a minute at most) -> data or null */
function loadLists(now) {
    if (listState.loading) return listState.loading;
    if (listState.checkedAt !== null && now - listState.checkedAt < LISTS_CHECK_MS) return Promise.resolve(listState.data);
    listState.loading = (async () => {
        listState.checkedAt = now;
        let st = null;
        try { st = await fs.promises.stat(listsFile); } catch (e) { st = null; }
        if (!st || !st.isFile()) {
            if (listState.sig !== 'none') console.warn('⚠️ [FFXIV Collect] Item lists file not found: ' + listsFile);
            listState.data = null; listState.sig = 'none';
            return null;
        }
        const sig = st.mtimeMs + ':' + st.size;
        if (sig === listState.sig) return listState.data;
        let parsed = null;
        try { parsed = parseListsFile(JSON.parse(await fs.promises.readFile(listsFile, 'utf8'))); } catch (e) { parsed = null; }
        if (parsed) console.log('📚 [FFXIV Collect] Item lists loaded (built ' + (parsed.builtAt || '?') + (parsed.dropped ? ', ' + parsed.dropped + ' bad items left out' : '') + ').');
        else console.warn('⚠️ [FFXIV Collect] Item lists file is not a valid ' + LISTS_FORMAT + ' file: ' + listsFile);
        listState.data = parsed; listState.sig = sig;
        return parsed;
    })().finally(() => { listState.loading = null; });
    return listState.loading;
}

const notLoadedList = () => Object.defineProperty([], 'notLoaded', { value: true });

/**
 * Items of a collection in lang (from the local file; a language not in the file -> English).
 * No file / a broken file -> [] with .notLoaded = true (callers show collect.listsMissing).
 */
async function getList(db, collection, lang, opts) {
    if (!COLLECTIONS[collection]) return [];
    const now = opts && typeof opts.now === 'number' ? opts.now : Date.now();
    const data = await loadLists(now);
    if (!data) return notLoadedList();
    const l = LANGS.includes(lang) ? lang : 'en';
    const mine = data.langs[l] && data.langs[l][collection];
    if (Array.isArray(mine)) return mine;
    const en = data.langs.en && data.langs.en[collection];
    return Array.isArray(en) ? en : [];
}
/** true when the lists file is there and valid */
async function listsReady(opts) {
    return !!(await loadLists(opts && typeof opts.now === 'number' ? opts.now : Date.now()));
}

// ---------- ownership ----------
const idSets = new WeakMap();
function ownedSet(data, collection) {
    const c = data && data.c && data.c[collection];
    if (!c || !c.public || !Array.isArray(c.ids)) return null;
    let sets = idSets.get(c);
    if (!sets) { sets = new Set(c.ids.map(Number)); idSets.set(c, sets); }
    return sets;
}
/** true / false / null (unknown: private or hidden collection) */
function owns(data, collection, id) {
    const s = ownedSet(data, collection);
    return s ? s.has(Number(id)) : null;
}
/** Items not owned yet, easiest first (most players have them) */
function missing(data, collection, items) {
    const s = ownedSet(data, collection);
    if (!s) return null;
    return items.filter(it => !s.has(it.id)).sort((a, b) => b.owned - a.owned || a.id - b.id);
}
/** Number shown for a stat (achievements = points) */
function statValue(data, collection) {
    const c = data && data.c && data.c[collection];
    if (!c || !c.public) return null;
    return collection === 'achievements' ? { value: c.points || 0, total: c.pointsTotal || 0, count: c.count, countTotal: c.total } : { value: c.count, total: c.total };
}

// ---------- search ----------
function norm(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length];
}
/** 0..1 how well a name fits what was typed (1 = same name) */
function score(query, name) {
    const q = norm(query), n = norm(name);
    if (!q || !n) return 0;
    if (q === n) return 1;
    if (n.startsWith(q)) return 0.9 + 0.05 * (q.length / n.length);
    if (n.includes(q)) return 0.8 + 0.05 * (q.length / n.length);
    const qt = q.split(' '), nt = n.split(' ');
    if (qt.every(w => nt.some(x => x.startsWith(w)))) return 0.75;
    // typos: the whole name, or the same number of words from the start
    const whole = 1 - lev(q, n) / Math.max(q.length, n.length);
    const head = nt.slice(0, qt.length).join(' ');
    const part = head.length ? 1 - lev(q, head) / Math.max(q.length, head.length) : 0;
    return Math.max(whole, part * 0.95) * 0.85;
}

/**
 * Search items. sources: [{ collection, items (user's language), en (English items) }]
 * -> [{ collection, item, score }] best first (only real candidates, score >= 0.5)
 */
function search(query, sources, limit) {
    const out = [];
    for (const src of sources) {
        const en = new Map((src.en || []).map(x => [x.id, x]));
        for (const it of src.items || []) {
            const e = en.get(it.id);
            const sc = Math.max(score(query, it.name), e && e !== it ? score(query, e.name) : 0);
            if (sc >= 0.5) out.push({ collection: src.collection, item: it, score: sc });
        }
        // items only in the English list (should not happen, but a name is a name)
        if (src.items && src.items.length === 0) for (const e of src.en || []) { const sc = score(query, e.name); if (sc >= 0.5) out.push({ collection: src.collection, item: e, score: sc }); }
    }
    out.sort((a, b) => b.score - a.score || b.item.owned - a.item.owned || a.item.name.length - b.item.name.length);
    return out.slice(0, limit || 10);
}
/** The best result is sure enough to answer directly (no "Did you mean…") */
function isConfident(results) {
    if (!results.length) return false;
    const [a, b] = results;
    if (a.score === 1) return !b || b.score < 1;
    return a.score >= 0.8 && (!b || b.score < a.score - 0.08);
}

/** The user's verified Main (ign_characters, claim_key set) -> row or null */
async function verifiedMain(db, uid) {
    const I = require('./ignClaims');
    await I.ensureTables(db);
    await I.migrateUser(db, uid);
    const main = await I.fixMain(db, uid);
    return main && main.claim_key ? main : null;
}

/** IGN card stat switches of a character row -> { mounts: true, ... } (NULL = default) */
function statToggles(row) {
    const out = {};
    for (const k of CARD_STATS) {
        const v = row ? row[STAT_COLUMNS[k]] : undefined;
        out[k] = v === null || v === undefined ? STAT_DEFAULTS[k] : Number(v) === 1;
    }
    return out;
}
async function readStatToggles(db, uid, lodestoneId) {
    await ensureTables(db);
    const [[row]] = await db.execute('SELECT ' + CARD_STATS.map(k => STAT_COLUMNS[k]).join(', ') + ' FROM ign_characters WHERE user_id = ? AND lodestone_id = ?', [String(uid), String(lodestoneId)]);
    return statToggles(row);
}

function ffxivCollectUrl(lodestoneId) { return 'https://ffxivcollect.com/characters/' + lodestoneId; }

module.exports = {
    BASE, UA, TIMEOUT_MS, CHAR_TTL_MS, MANUAL_GAP_MS, MAX_PARALLEL, SPACING_MS, COLLECTIONS, COLLECTION_KEYS,
    LISTS_FILE, LISTS_FORMAT, LISTS_CHECK_MS, listsReady, parseListsFile,
    CARD_STATS, STAT_COLUMNS, STAT_DEFAULTS,
    ensureTables, getCharacter, cachedMany, refreshLater, getList, slimCharacter, slimItem,
    owns, missing, statValue, norm, score, search, isConfident, verifiedMain, statToggles, readStatToggles, ffxivCollectUrl, pct,
    _setHttp(fn) { httpGet = fn || axiosGet; },
    _setListsFile(p) { listsFile = p || LISTS_FILE; listState.data = null; listState.sig = null; listState.checkedAt = null; },
    _reset() { ready = false; inflight.clear(); queued.clear(); waiting.length = 0; running = 0; lastStart = 0; listState.data = null; listState.sig = null; listState.checkedAt = null; },
    _stats() { return { running, waiting: waiting.length }; }
};
