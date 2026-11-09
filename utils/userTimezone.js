// Each user's time zone for AI reminders (IANA name, e.g. Asia/Tokyo).
// Pingway asks once ("What's your time zone?"), saves the answer here, and never asks again.
// Table user_timezone: user_id -> tz. Small cache like utils/userLanguage.js.
const { pool } = require('./db');

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // userId -> { time, tz }
let tableReady = null;

function ensureTable() {
    if (!tableReady) {
        tableReady = pool.execute(
            'CREATE TABLE IF NOT EXISTS user_timezone (' +
            ' user_id VARCHAR(20) NOT NULL PRIMARY KEY,' +
            ' tz VARCHAR(64) NOT NULL,' +
            ' updated_at BIGINT' +
            ')'
        ).catch(err => { tableReady = null; throw err; });
    }
    return tableReady;
}

// Saved time zone, or null when unknown
async function get(userId) {
    const id = String(userId);
    const hit = cache.get(id);
    if (hit && Date.now() - hit.time < CACHE_MS) return hit.tz;
    let tz = null;
    try {
        await ensureTable();
        const [rows] = await pool.execute('SELECT tz FROM user_timezone WHERE user_id = ?', [id]);
        if (rows.length && isValid(rows[0].tz)) tz = canonical(rows[0].tz);
    } catch (err) {
        return null; // database trouble: treat as unknown, don't cache
    }
    cache.set(id, { time: Date.now(), tz });
    return tz;
}

async function set(userId, tz) {
    if (!isValid(tz)) throw new Error('Invalid time zone: ' + tz);
    const id = String(userId);
    const value = canonical(tz);
    await ensureTable();
    await pool.execute(
        'INSERT INTO user_timezone (user_id, tz, updated_at) VALUES (?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE tz = VALUES(tz), updated_at = VALUES(updated_at)',
        [id, value, Date.now()]
    );
    cache.set(id, { time: Date.now(), tz: value });
    return value;
}

function clearCache() { cache.clear(); }

// ---------- time zone names ----------
function isValid(tz) {
    if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}
function canonical(tz) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone; } catch (e) { return tz; }
}

// Common answers -> IANA name (lowercase keys)
const ALIASES = {
    'japan': 'Asia/Tokyo', 'jp': 'Asia/Tokyo', 'jst': 'Asia/Tokyo', 'tokyo': 'Asia/Tokyo', 'osaka': 'Asia/Tokyo', 'japon': 'Asia/Tokyo', '日本': 'Asia/Tokyo', '東京': 'Asia/Tokyo', '大阪': 'Asia/Tokyo', '日本時間': 'Asia/Tokyo',
    'london': 'Europe/London', 'uk': 'Europe/London', 'united kingdom': 'Europe/London', 'england': 'Europe/London', 'britain': 'Europe/London', 'great britain': 'Europe/London', 'gmt': 'Europe/London', 'bst': 'Europe/London', 'londres': 'Europe/London', 'scotland': 'Europe/London', 'wales': 'Europe/London', 'ロンドン': 'Europe/London', 'イギリス': 'Europe/London',
    'philippines': 'Asia/Manila', 'manila': 'Asia/Manila', 'ph': 'Asia/Manila', 'pht': 'Asia/Manila', 'pst philippines': 'Asia/Manila', 'cebu': 'Asia/Manila', 'davao': 'Asia/Manila', 'quezon city': 'Asia/Manila', 'pilipinas': 'Asia/Manila', 'フィリピン': 'Asia/Manila', 'マニラ': 'Asia/Manila',
    'new york': 'America/New_York', 'ny': 'America/New_York', 'nyc': 'America/New_York', 'est': 'America/New_York', 'edt': 'America/New_York', 'eastern': 'America/New_York', 'us eastern': 'America/New_York', 'eastern time': 'America/New_York', 'boston': 'America/New_York', 'miami': 'America/New_York', 'atlanta': 'America/New_York', 'toronto': 'America/Toronto', 'ニューヨーク': 'America/New_York',
    'chicago': 'America/Chicago', 'cst': 'America/Chicago', 'cdt': 'America/Chicago', 'central': 'America/Chicago', 'central time': 'America/Chicago', 'us central': 'America/Chicago', 'texas': 'America/Chicago', 'dallas': 'America/Chicago', 'houston': 'America/Chicago',
    'denver': 'America/Denver', 'mst': 'America/Denver', 'mdt': 'America/Denver', 'mountain': 'America/Denver', 'mountain time': 'America/Denver', 'arizona': 'America/Phoenix', 'phoenix': 'America/Phoenix',
    'los angeles': 'America/Los_Angeles', 'la': 'America/Los_Angeles', 'pst': 'America/Los_Angeles', 'pdt': 'America/Los_Angeles', 'pacific': 'America/Los_Angeles', 'pacific time': 'America/Los_Angeles', 'us pacific': 'America/Los_Angeles', 'california': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', 'seattle': 'America/Los_Angeles', 'vancouver': 'America/Vancouver', 'ロサンゼルス': 'America/Los_Angeles',
    'hawaii': 'Pacific/Honolulu', 'honolulu': 'Pacific/Honolulu', 'alaska': 'America/Anchorage',
    'paris': 'Europe/Paris', 'france': 'Europe/Paris', 'cet': 'Europe/Paris', 'cest': 'Europe/Paris', 'パリ': 'Europe/Paris', 'フランス': 'Europe/Paris',
    'berlin': 'Europe/Berlin', 'germany': 'Europe/Berlin', 'deutschland': 'Europe/Berlin', 'allemagne': 'Europe/Berlin', 'munich': 'Europe/Berlin', 'münchen': 'Europe/Berlin', 'hamburg': 'Europe/Berlin', 'ドイツ': 'Europe/Berlin', 'ベルリン': 'Europe/Berlin',
    'frankreich': 'Europe/Paris', 'japan zeit': 'Asia/Tokyo', 'england zeit': 'Europe/London',
    'spain': 'Europe/Madrid', 'madrid': 'Europe/Madrid', 'italy': 'Europe/Rome', 'rome': 'Europe/Rome', 'netherlands': 'Europe/Amsterdam', 'amsterdam': 'Europe/Amsterdam', 'belgium': 'Europe/Brussels', 'brussels': 'Europe/Brussels', 'switzerland': 'Europe/Zurich', 'austria': 'Europe/Vienna', 'sweden': 'Europe/Stockholm', 'norway': 'Europe/Oslo', 'denmark': 'Europe/Copenhagen', 'poland': 'Europe/Warsaw', 'finland': 'Europe/Helsinki', 'ireland': 'Europe/Dublin', 'dublin': 'Europe/Dublin', 'portugal': 'Europe/Lisbon', 'lisbon': 'Europe/Lisbon', 'greece': 'Europe/Athens', 'turkey': 'Europe/Istanbul', 'russia': 'Europe/Moscow', 'moscow': 'Europe/Moscow',
    'sydney': 'Australia/Sydney', 'australia': 'Australia/Sydney', 'aest': 'Australia/Sydney', 'aedt': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne', 'brisbane': 'Australia/Brisbane', 'perth': 'Australia/Perth', 'adelaide': 'Australia/Adelaide', 'シドニー': 'Australia/Sydney', 'オーストラリア': 'Australia/Sydney',
    'new zealand': 'Pacific/Auckland', 'nz': 'Pacific/Auckland', 'auckland': 'Pacific/Auckland',
    'korea': 'Asia/Seoul', 'south korea': 'Asia/Seoul', 'seoul': 'Asia/Seoul', 'kst': 'Asia/Seoul', '韓国': 'Asia/Seoul',
    'china': 'Asia/Shanghai', 'beijing': 'Asia/Shanghai', 'shanghai': 'Asia/Shanghai', 'hong kong': 'Asia/Hong_Kong', 'hk': 'Asia/Hong_Kong', 'taiwan': 'Asia/Taipei', 'taipei': 'Asia/Taipei', 'singapore': 'Asia/Singapore', 'sg': 'Asia/Singapore', 'malaysia': 'Asia/Kuala_Lumpur', 'thailand': 'Asia/Bangkok', 'bangkok': 'Asia/Bangkok', 'vietnam': 'Asia/Ho_Chi_Minh', 'indonesia': 'Asia/Jakarta', 'jakarta': 'Asia/Jakarta', 'india': 'Asia/Kolkata', 'kolkata': 'Asia/Kolkata', 'mumbai': 'Asia/Kolkata', 'delhi': 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', 'ist india': 'Asia/Kolkata', 'dubai': 'Asia/Dubai', 'uae': 'Asia/Dubai',
    'canada': 'America/Toronto', 'mexico': 'America/Mexico_City', 'brazil': 'America/Sao_Paulo', 'sao paulo': 'America/Sao_Paulo', 'são paulo': 'America/Sao_Paulo', 'argentina': 'America/Argentina/Buenos_Aires',
    'utc': 'UTC', 'z': 'UTC', 'zulu': 'UTC', 'coordinated universal time': 'UTC'
};

let cityIndex = null; // 'tokyo' -> 'Asia/Tokyo' (from the IANA list)
function cities() {
    if (cityIndex) return cityIndex;
    cityIndex = new Map();
    let list = [];
    try { list = Intl.supportedValuesOf('timeZone'); } catch (e) { /* old runtime */ }
    for (const zone of list) {
        const city = zone.split('/').pop().replace(/_/g, ' ').toLowerCase();
        if (!cityIndex.has(city)) cityIndex.set(city, zone);
    }
    return cityIndex;
}

// "UTC+9", "GMT-5", "+09:00" -> Etc/GMT-9 (whole hours) — note Etc/ signs are reversed
function fromOffsetText(s) {
    const m = s.match(/^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(00))?$/i);
    if (!m) return null;
    const h = parseInt(m[2], 10);
    if (h > 14) return null;
    if (h === 0) return 'UTC';
    const zone = 'Etc/GMT' + (m[1] === '+' ? '-' : '+') + h;
    return isValid(zone) ? zone : null;
}

function lookupOne(s) {
    if (!s) return null;
    if (ALIASES[s]) return ALIASES[s];
    const off = fromOffsetText(s);
    if (off) return off;
    if (s.includes('/') && isValid(s)) return canonical(s);
    const c = cities().get(s);
    if (c) return c;
    return null;
}

// Turn the user's answer ("Japan", "I'm in London", "asia/tokyo", "UTC+9") into an IANA name, or null
function resolve(answer) {
    if (!answer || typeof answer !== 'string') return null;
    let s = answer.normalize('NFC').trim().toLowerCase();
    if (!s || s.length > 100) return null;
    // a raw IANA name first (keep its slashes/underscores)
    const raw = s.replace(/[\s.!?。、！？]+$/g, '');
    if (raw.includes('/') && isValid(raw)) return canonical(raw);
    s = s.replace(/[.!?,;:"'()。、！？「」]+/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(?:i'?m|i am|im|i live|living|i'm living|we are|we're|my (?:time ?zone|tz|timezone) is|time ?zone is|timezone|time zone|tz|it'?s|its|je suis|j'habite|ich bin|ich wohne|ich lebe)\s+/i, '')
         .replace(/^(?:in|at|from|en|au|à|a|aux|in der|im|aus)\s+/i, '')
         .replace(/\s+(?:time|time zone|timezone|zeit|です|に住んでいます|在住|時間)$/i, '')
         .trim();
    const direct = lookupOne(s) || lookupOne(s.replace(/\s+/g, ''));
    if (direct) return direct;
    // Japanese answers without spaces: look for a known name inside
    for (const key of Object.keys(ALIASES)) {
        if (/[^\x00-\x7f]/.test(key) && s.includes(key)) return ALIASES[key];
    }
    // last words / pairs of words ("i live in tokyo japan")
    const words = s.split(' ');
    for (let n = Math.min(3, words.length); n >= 1; n--) {
        for (let i = 0; i + n <= words.length; i++) {
            const piece = words.slice(i, i + n).join(' ');
            if (piece.length <= 2) continue; // "la", "ny" etc. only count as the whole answer
            const hit = lookupOne(piece);
            if (hit) return hit;
        }
    }
    return null;
}

// ---------- time math ----------
function wallParts(tz, ms) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long'
    });
    const p = {};
    for (const part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
    return {
        year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second, weekday: p.weekday
    };
}

// Minutes the zone is ahead of UTC at that moment (Tokyo = 540)
function offsetMinutes(tz, ms) {
    const t = Math.floor(ms / 1000) * 1000;
    const p = wallParts(tz, t);
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t) / 60000);
}

function formatOffset(mins) {
    const sign = mins < 0 ? '-' : '+';
    const a = Math.abs(mins);
    return sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}

const pad = n => String(n).padStart(2, '0');

// What to tell the AI about "now" for this user
function describeNow(tz, ms = Date.now()) {
    const p = wallParts(tz, ms);
    const offset = formatOffset(offsetMinutes(tz, ms));
    return {
        tz,
        offset,
        localIso: `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offset}`,
        localText: `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${p.weekday})`,
        year: p.year
    };
}

// Local wall time in a zone -> UTC ms
function localToUtc(tz, y, mo, d, h, mi, s) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
    const off1 = offsetMinutes(tz, guess);
    let ms = guess - off1 * 60000;
    const off2 = offsetMinutes(tz, ms);
    if (off2 !== off1) ms = guess - off2 * 60000;
    return ms;
}

// The AI's target_time -> UTC ms (NaN if unreadable).
// With an offset/Z it is exact; without one it is read as local time in tz.
function targetToUtc(text, tz) {
    if (typeof text !== 'string') return NaN;
    const s = text.trim();
    if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
    if (!m) return NaN;
    const zone = isValid(tz) ? tz : 'UTC';
    return localToUtc(zone, +m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

const PAST_GRACE_MS = 60 * 1000;
const MAX_AHEAD_MS = 2 * 366 * 24 * 60 * 60 * 1000;

// 'ok' | 'invalid' | 'past' | 'far' | 'year'
function checkTarget(ms, tz, now = Date.now()) {
    if (!Number.isFinite(ms)) return 'invalid';
    const zone = isValid(tz) ? tz : 'UTC';
    const thisYear = wallParts(zone, now).year;
    const year = wallParts(zone, ms).year;
    if (year !== thisYear && year !== thisYear + 1) return 'year';
    if (ms < now - PAST_GRACE_MS) return 'past';
    if (ms > now + MAX_AHEAD_MS) return 'far';
    return 'ok';
}

module.exports = {
    ensureTable, get, set, clearCache,
    isValid, canonical, resolve,
    offsetMinutes, formatOffset, describeNow, localToUtc, targetToUtc, checkTarget
};
