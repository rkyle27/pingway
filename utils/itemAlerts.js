// Item alerts (Ko-fi / Patreon members only; set up on the website's Retainers tab, table item_alerts).
// The bot only reads them: each item is watched on the regions / Data Centers / worlds the member ticked, and a new
// listing alerts when its price per unit is below the member's fixed Gil limit and/or below the median of that place
// (both set = it must be below both). marketMonitor.js sends the matches with the member's Item alert settings
// (DM and/or server channels, Alert timing). Items of members whose membership ended are skipped (paused, never deleted).
//
// Membership = the same rule as the website (lib/voice.js membershipInfo): a credited Ko-fi membership payment in the
// last 35 days, a membership set by the owner (voice_user_settings.member_until, also used by giveaway rewards),
// or a credited Patreon charge whose member_until is still ahead. Checked with a 5-minute cache, like Supporter Perks.

const { pool } = require('./db');

const MEMBER_ACTIVE_DAYS = 35;
const DAY_MS = 864e5;
const MEMBER_CACHE_MS = 5 * 60 * 1000;
const REPEAT_COOLDOWN_MS = 60 * 60 * 1000; // same item/place/quality: a new listing alerts again after 1 hour, a cheaper one any time
const SEEN_MAX = 50;                       // listings remembered per item/place/quality (the same listing never alerts twice)
const MAX_ITEMS = 100;                     // per member (the website enforces it; extra rows are ignored here too)

let now = () => Date.now();
const memberCache = new Map(); // userId -> { time, active }
let byItem = new Map();        // itemId -> [alert]
let worlds = new Set();        // every world any active item alert watches
const repeats = new Map();     // 'alertId:placeKey:quality' -> { time, price, seen: Set(listingKey) }
let lastSummary = '';

const missing = err => !!err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR' ||
    /doesn't exist|Unknown column|no such table/i.test(String(err.message)));

async function firstRow(sql, params) {
    try {
        const [rows] = await pool.execute(sql, params);
        return rows && rows[0] ? rows[0] : null;
    } catch (err) {
        if (missing(err)) return null;
        throw err;
    }
}

// Ko-fi (payments or the owner's console / giveaway membership) or Patreon active right now
async function isMember(userId) {
    const id = String(userId);
    const hit = memberCache.get(id);
    const time = now();
    if (hit && time - hit.time < MEMBER_CACHE_MS) return hit.active;
    let active = false;
    try {
        const kofi = await firstRow("SELECT created_at FROM kofi_payments WHERE user_id = ? AND status = 'credited' AND LOWER(type) = 'subscription' AND created_at > ? ORDER BY created_at DESC LIMIT 1",
            [id, time - MEMBER_ACTIVE_DAYS * DAY_MS]);
        if (kofi) active = true;
        if (!active) {
            const vs = await firstRow('SELECT member_until FROM voice_user_settings WHERE user_id = ?', [id]);
            if (vs && vs.member_until !== null && vs.member_until !== undefined && Number(vs.member_until) > time) active = true;
        }
        if (!active) {
            const p = await firstRow("SELECT member_until FROM patreon_payments WHERE user_id = ? AND status = 'credited' AND member_until > ? ORDER BY member_until DESC LIMIT 1", [id, time]);
            if (p) active = true;
        }
    } catch (err) {
        console.error('❌ [ITEM ALERTS] Membership check failed:', err.message);
        if (hit) return hit.active; // keep the last known answer on a database hiccup
    }
    memberCache.set(id, { time, active });
    return active;
}

function parsePlaces(value) {
    try {
        const list = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(list) ? list.filter(p => p && ['region', 'dc', 'world'].includes(p.type) && typeof p.name === 'string' && p.name) : [];
    } catch (e) {
        return [];
    }
}

// One saved place -> { key, type, name, scope (Universalis path for its median), worlds: Set(worldId) } or null
// geo = { dcWorlds: { dc: [worldId] }, dcRegion: { dc: region }, worldNames: { worldId: name } }
function resolvePlace(place, geo) {
    const lower = String(place.name).toLowerCase();
    if (place.type === 'world') {
        const id = Object.keys(geo.worldNames || {}).find(k => String(geo.worldNames[k]).toLowerCase() === lower);
        if (!id) return null;
        return { key: 'world:' + id, type: 'world', name: geo.worldNames[id], scope: String(id), worlds: new Set([Number(id)]) };
    }
    if (place.type === 'dc') {
        const dc = Object.keys(geo.dcWorlds || {}).find(d => d.toLowerCase() === lower);
        if (!dc) return null;
        return { key: 'dc:' + dc, type: 'dc', name: dc, scope: dc, worlds: new Set(geo.dcWorlds[dc].map(Number)) };
    }
    const dcs = Object.keys(geo.dcWorlds || {}).filter(dc => String((geo.dcRegion || {})[dc] || '').toLowerCase() === lower);
    if (!dcs.length) return null;
    const name = geo.dcRegion[dcs[0]];
    return { key: 'region:' + name, type: 'region', name, scope: name, worlds: new Set(dcs.flatMap(dc => geo.dcWorlds[dc].map(Number))) };
}

// Reads every item alert, skips members whose membership is not active (paused), and indexes them by item
async function load(geo) {
    let rows;
    try {
        [rows] = await pool.execute('SELECT id, user_id, item_id, item_name, quality, places, max_price, below_median FROM item_alerts ORDER BY user_id, id');
    } catch (err) {
        if (!missing(err)) console.error('❌ [ITEM ALERTS] Could not load item alerts:', err.message);
        byItem = new Map();
        worlds = new Set();
        return;
    }
    const next = new Map();
    const nextWorlds = new Set();
    const perUser = new Map();
    let paused = 0;
    let count = 0;
    for (const r of rows) {
        const userId = String(r.user_id);
        const n = (perUser.get(userId) || 0) + 1;
        perUser.set(userId, n);
        if (n > MAX_ITEMS) continue;
        if (!(await isMember(userId))) { paused++; continue; }
        const maxPrice = r.max_price !== null && r.max_price !== undefined && Number(r.max_price) > 0 ? Number(r.max_price) : null;
        const belowMedian = Number(r.below_median) === 1;
        if (!maxPrice && !belowMedian) continue; // no rule (never saved like this by the website)
        const places = parsePlaces(r.places).map(p => resolvePlace(p, geo)).filter(Boolean);
        if (!places.length) continue;
        const quality = ['nq', 'hq', 'both'].includes(r.quality) ? r.quality : 'nq';
        const alert = { id: Number(r.id), userId, itemId: Number(r.item_id), name: r.item_name || '', quality, places, maxPrice, belowMedian };
        if (!next.has(alert.itemId)) next.set(alert.itemId, []);
        next.get(alert.itemId).push(alert);
        for (const p of places) for (const w of p.worlds) nextWorlds.add(w);
        count++;
    }
    byItem = next;
    worlds = nextWorlds;
    // forget repeat state of removed items / places
    const live = new Set();
    for (const list of byItem.values()) for (const a of list) for (const p of a.places) live.add(a.id + ':' + p.key);
    for (const k of Array.from(repeats.keys())) {
        const base = k.slice(0, k.lastIndexOf(':'));
        if (!live.has(base) || now() - repeats.get(k).time > 24 * 60 * 60 * 1000) repeats.delete(k);
    }
    for (const [k, v] of memberCache) if (now() - v.time > MEMBER_CACHE_MS * 4) memberCache.delete(k);
    const summary = count + ' item alert(s) on ' + nextWorlds.size + ' world(s)' + (paused ? ', ' + paused + ' paused' : '');
    if (summary !== lastSummary) {
        console.log('🔔 [ITEM ALERTS] Watching ' + summary + '.');
        lastSummary = summary;
    }
}

function getWorlds() { return new Set(worlds); }
function hasAlerts() { return byItem.size > 0; }
function watchesItem(itemId) { return byItem.has(Number(itemId)); }

const validPrice = l => typeof l.pricePerUnit === 'number' && l.pricePerUnit > 0;
const listingKey = l => l.listingID ? String(l.listingID) : String(l.retainerName || '') + ':' + l.pricePerUnit + ':' + (l.quantity || 0);
const qualitiesOf = q => (q === 'both' ? ['nq', 'hq'] : [q]);

// Price rule: below the fixed Gil (if set) AND below the place's median (if "below median" is on)
function passesRule(price, alert, median) {
    if (alert.maxPrice && !(price < alert.maxPrice)) return false;
    if (alert.belowMedian && !(typeof median === 'number' && median > 0 && price < median)) return false;
    return true;
}

// The same listing alerts once; within an hour only a cheaper listing alerts again (afterwards any new one)
function takeRepeat(key, listing) {
    const time = now();
    const lk = listingKey(listing);
    const st = repeats.get(key);
    if (st && st.seen.has(lk)) return false;
    if (st && time - st.time < REPEAT_COOLDOWN_MS && !(listing.pricePerUnit < st.price)) return false;
    const seen = st ? st.seen : new Set();
    seen.add(lk);
    while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
    repeats.set(key, { time, price: listing.pricePerUnit, seen });
    return true;
}

// listings/add from Universalis. deps.getBaseline(itemId, scope) -> { nq: { median, count }, hq: {...} } | null (cached
// in marketMonitor, spaced like every lookup); deps.onMatch(match) collects the alert for sending.
async function onListingsAdd(message, deps) {
    if (!message || message.event !== 'listings/add') return 0;
    const itemId = Number(message.item);
    const worldId = Number(message.world);
    const alerts = byItem.get(itemId);
    if (!alerts || !worldId) return 0;
    const listings = Array.isArray(message.listings) ? message.listings : [];
    const cheapest = {};
    for (const l of listings) {
        if (!validPrice(l) || l.onMannequin) continue; // housing mannequin listings never alert
        const q = l.hq ? 'hq' : 'nq';
        if (!cheapest[q] || l.pricePerUnit < cheapest[q].pricePerUnit) cheapest[q] = l;
    }
    if (!cheapest.nq && !cheapest.hq) return 0;
    let found = 0;
    for (const alert of alerts) {
        for (const place of alert.places) {
            if (!place.worlds.has(worldId)) continue;
            for (const quality of qualitiesOf(alert.quality)) {
                const listing = cheapest[quality];
                if (!listing) continue;
                if (alert.maxPrice && !(listing.pricePerUnit < alert.maxPrice)) continue; // cheap check before any lookup
                let median = null;
                if (alert.belowMedian) {
                    const b = deps && deps.getBaseline ? await deps.getBaseline(itemId, place.scope) : null;
                    const q = b && b[quality];
                    median = q && q.count > 0 && typeof q.median === 'number' ? q.median : null;
                }
                if (!passesRule(listing.pricePerUnit, alert, median)) continue;
                if (!takeRepeat(alert.id + ':' + place.key + ':' + quality, listing)) continue;
                found++;
                if (deps && deps.onMatch) deps.onMatch({
                    userId: alert.userId, alertId: alert.id, itemId, name: alert.name, hq: quality === 'hq', worldId,
                    place: { key: place.key, type: place.type, name: place.name }, price: listing.pricePerUnit,
                    median: alert.belowMedian ? median : null, quantity: listing.quantity || 0
                });
            }
        }
    }
    return found;
}

module.exports = {
    MAX_ITEMS, REPEAT_COOLDOWN_MS, isMember, load, getWorlds, hasAlerts, watchesItem, onListingsAdd, passesRule, resolvePlace,
    _test: {
        setNow(fn) { now = typeof fn === 'function' ? fn : () => Date.now(); },
        reset() { memberCache.clear(); byItem = new Map(); worlds = new Set(); repeats.clear(); lastSummary = ''; },
        byItem: () => byItem, repeats: () => repeats
    }
};
