// Internet radio search through the free Radio Browser API (https://www.radio-browser.info).
// Server list: DNS SRV record _api._tcp.radio-browser.info (the documented way), with a fixed fallback.
// We send a plain User-Agent (no email), and call /json/url/<uuid> when a station is picked
// (Radio Browser asks clients to do this so its click counts stay useful).

const dns = require('dns');
const { USER_AGENT } = require('./urlSafety');

const FALLBACK_SERVERS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info'];
const SERVER_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

let serverCache = { list: null, at: 0 };

async function discoverServers({ resolveSrv = dns.promises.resolveSrv, now = Date.now() } = {}) {
    if (serverCache.list && now - serverCache.at < SERVER_TTL_MS) return serverCache.list;
    let list = [];
    try {
        const recs = await resolveSrv('_api._tcp.radio-browser.info');
        list = recs.map(r => r.name).filter(n => /^[a-z0-9.-]+\.radio-browser\.info$/i.test(n));
    } catch {
        list = [];
    }
    if (!list.length) list = FALLBACK_SERVERS.slice();
    // shuffle so load is spread like the docs ask
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    serverCache = { list, at: now };
    return list;
}

function _resetServerCache() {
    serverCache = { list: null, at: 0 };
}

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

/** Raw Radio Browser JSON -> up to `limit` playable stations (no HLS, http(s) only, de-duplicated). */
function parseStations(json, limit = 10) {
    if (!Array.isArray(json)) return [];
    const out = [];
    const seen = new Set();
    for (const s of json) {
        if (!s || typeof s !== 'object') continue;
        const uuid = clean(s.stationuuid, 64);
        const url = clean(s.url_resolved || s.url, 2000);
        if (!uuid || !/^[0-9a-f-]{8,64}$/i.test(uuid) || !/^https?:\/\//i.test(url)) continue;
        if (Number(s.hls) === 1 || /\.m3u8(\?|$)/i.test(url)) continue;
        if (Number(s.lastcheckok) === 0) continue;
        const name = clean(s.name, 100) || 'Unnamed station';
        const key = name.toLowerCase() + '|' + url;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            uuid,
            name,
            url,
            country: clean(s.countrycode || s.country, 40),
            bitrate: Number.isFinite(Number(s.bitrate)) ? Number(s.bitrate) : 0,
            codec: clean(s.codec, 12)
        });
        if (out.length >= limit) break;
    }
    return out;
}

async function getJson(fetchImpl, url) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error('radio-browser HTTP ' + res.status);
    return res.json();
}

/** Search stations by name. Tries up to 3 servers. */
async function searchStations(query, { fetchImpl = globalThis.fetch, servers, limit = 10 } = {}) {
    const q = clean(query, 100);
    if (!q) return [];
    const list = servers || await discoverServers();
    const params = new URLSearchParams({ name: q, limit: '30', hidebroken: 'true', order: 'clickcount', reverse: 'true' });
    let lastErr;
    for (const host of list.slice(0, 3)) {
        try {
            const json = await getJson(fetchImpl, `https://${host}/json/stations/search?${params}`);
            return parseStations(json, limit);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('radio-browser unavailable');
}

/** Counts the click and returns the station's current stream URL (or the cached one on failure). */
async function clickStation(uuid, fallbackUrl, { fetchImpl = globalThis.fetch, servers } = {}) {
    try {
        const list = servers || await discoverServers();
        const json = await getJson(fetchImpl, `https://${list[0]}/json/url/${encodeURIComponent(uuid)}`);
        if (json && json.ok !== false && /^https?:\/\//i.test(json.url || '')) return json.url;
    } catch {
        // click counting is best effort
    }
    return fallbackUrl;
}

/** Select-menu option label/description for a station (Discord limit 100, we keep <= 80). */
function stationOption(st) {
    const parts = [st.country, st.bitrate ? st.bitrate + ' kbps' : null, st.codec || null].filter(Boolean);
    return {
        label: clean(st.name, 80) || 'Station',
        description: clean(parts.join(' · ') || 'Internet radio', 80),
        value: st.uuid
    };
}

module.exports = { FALLBACK_SERVERS, discoverServers, parseStations, searchStations, clickStation, stationOption, _resetServerCache };
