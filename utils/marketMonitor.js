const WebSocket = require('ws');
const { BSON } = require('bson');
const axios = require('axios');
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { pool } = require('./db');
const retainerWatch = require('./retainerWatch');
const dmStatus = require('./dmStatus');

const UNIVERSALIS_WS_URL = 'wss://universalis.app/api/ws';
const UNIVERSALIS_API = 'https://universalis.app/api/v2';

// Fallback Data Center -> World ID list (from Universalis, Oct 2026).
// The live list is loaded from Universalis on startup and replaces this.
let DC_WORLD_MAP = {
    'Aether': [73, 79, 54, 63, 40, 65, 99, 57],
    'Primal': [78, 93, 53, 35, 95, 55, 64, 77],
    'Crystal': [91, 34, 74, 62, 81, 75, 37, 41],
    'Dynamis': [408, 411, 406, 409, 407, 404, 410, 405],
    'Chaos': [80, 83, 71, 39, 401, 97, 400, 85],
    'Light': [402, 36, 66, 56, 403, 67, 33, 42],
    'Materia': [22, 21, 86, 87, 88],
    'Elemental': [90, 68, 45, 58, 94, 49, 72, 50],
    'Gaia': [43, 69, 92, 46, 59, 98, 76, 51],
    'Mana': [44, 23, 70, 47, 48, 96, 28, 61],
    'Meteor': [24, 82, 60, 29, 30, 52, 31, 32]
};
let WORLD_TO_DC = {};
const WORLD_NAMES = {};

// --- Alert Tuning ---
const DISCOUNT_THRESHOLD = -80;               // New listing must be at least 80% below the DC's average sale price (e.g. avg 100,000 -> alert at 20,000 or less)
const MIN_BASELINE_PRICE = 10000;             // Ignore items whose average sale price is under 10,000 Gil
const MIN_DAILY_SALES = 1;                    // Item must actually sell (at least 1 per day on the DC) - filters fake/troll averages
const MIN_SALES_FOR_MEDIAN = 5;               // Need at least 5 recent sales of that quality for a reliable median
const HISTORY_ENTRIES = 80;                   // Recent sales fetched per item/DC to compute the median
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // Median window like the Universalis website: last 7 days
const LISTING_CHECK_COUNT = 3;                // Check 2: compare against the average of the next 3 cheapest other listings
const FLUSH_INTERVAL_MS = 60 * 1000;          // Check every minute whether collected alerts are due
const ALERT_INTERVALS = [1, 2, 5, 10, 15, 30]; // DM interval choices in minutes (set on the website, default 1)
const MAX_ITEMS_PER_MESSAGE = 10;             // Up to 10 items per DM message (no limit on messages)
const MAX_MESSAGE_CHARS = 5800;               // Stay under Discord's 6,000 character limit per message
const BASELINE_CACHE_MS = 15 * 60 * 1000;     // Cache Universalis price baselines for 15 minutes
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;     // Same item/world/quality alerts a user at most once per hour
const SUBSCRIBER_REFRESH_MS = 5 * 60 * 1000;  // Re-check subscribers and their Data Centers every 5 minutes
const MAX_PENDING_LOOKUPS = 50;               // Skip evaluations while this many price lookups are queued
const LOOKUP_GAP_MS = 150;                    // Space Universalis REST calls (about 6 per second max)

let ws = null;
let reconnectTimer = null;
let pingInterval = null;
let refreshTimer = null;
let reconnectDelay = 10000;
let messageCount = 0;
let started = false;
let subscribedWorlds = new Set();
let subscribedRemoveWorlds = new Set(); // Retainer Watch: listings/remove channels
let subscribers = []; // [{ userId, dcs: ['Mana', ...] }]

const baselineCache = new Map();  // 'itemId:dc' -> { time, data }
const itemNameCache = new Map();  // itemId -> { name, time } (cleared after 24h, max 5,000 names)
const NAME_CACHE_MS = 24 * 60 * 60 * 1000;
const NAME_CACHE_MAX = 5000;
const alertCooldowns = new Map(); // 'user:item:world:quality' -> time
const pendingAlerts = new Map();  // userId -> Map('itemId:quality' -> { itemId, hq, rows: Map(worldId -> row) })
let flushTimer = null;
let flushing = false;
const alertIntervals = new Map(); // userId -> minutes (only users who chose something other than 1)
const lastSentAt = new Map();     // userId -> time of their last alert DM
let alertTargets = new Map();     // userId -> [{ guildId, channelId }] for users who chose "Server channel" (set on the website)
const targetWarned = new Map();   // 'userId:guildId' -> time (keeps the console quiet)
let pendingLookups = 0;
let nextLookupAt = 0;

function rebuildWorldIndex() {
    WORLD_TO_DC = {};
    for (const [dc, ids] of Object.entries(DC_WORLD_MAP)) {
        for (const id of ids) WORLD_TO_DC[id] = dc;
    }
}
rebuildWorldIndex();

async function loadWorldData() {
    try {
        const [dcRes, worldRes] = await Promise.all([
            axios.get(UNIVERSALIS_API + '/data-centers', { timeout: 10000 }),
            axios.get(UNIVERSALIS_API + '/worlds', { timeout: 10000 })
        ]);
        if (Array.isArray(dcRes.data) && dcRes.data.length > 0) {
            const map = {};
            for (const dc of dcRes.data) {
                if (dc && dc.name && Array.isArray(dc.worlds)) map[dc.name] = dc.worlds;
            }
            DC_WORLD_MAP = map;
            rebuildWorldIndex();
        }
        if (Array.isArray(worldRes.data)) {
            for (const w of worldRes.data) WORLD_NAMES[w.id] = w.name;
        }
        console.log('🗺️ [MARKET] Loaded live world list from Universalis (' + Object.keys(DC_WORLD_MAP).length + ' Data Centers).');
    } catch (err) {
        console.warn('⚠️ [MARKET] Could not load live world list, using built-in list:', err.message);
    }
}

function parseDCList(value) {
    if (!value) return [];
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

// Subscribers = users with market alert DMs enabled, using the Data Centers
// they saved with /datacenter (the same data /price uses).
// Users with no saved Data Centers are skipped (nothing is scanned for them).
async function loadSubscribers() {
    const [rows] = await pool.execute(
        'SELECT ma.user_id, ud.guild_id, ud.datacenters FROM market_alerts ma ' +
        'LEFT JOIN user_datacenters ud ON ud.user_id = ma.user_id ' +
        'WHERE ma.dm_enabled = 1'
    );
    // Personal /datacenter setting first; otherwise any one older per-server setting
    const chosen = new Map(); // userId -> { personal, datacenters }
    for (const row of rows) {
        const current = chosen.get(row.user_id);
        const isPersonal = row.guild_id === 'personal';
        if (!current || (isPersonal && !current.personal)) {
            chosen.set(row.user_id, { personal: isPersonal, datacenters: row.datacenters });
        }
    }
    const byUser = new Map();
    for (const [userId, c] of chosen) byUser.set(userId, new Set(parseDCList(c.datacenters)));
    await loadTargets();
    const list = [];
    for (const [userId, dcSet] of byUser) {
        // Can't DM them right now: don't collect alerts for nothing (unless their alerts go to a server channel)
        if (dmStatus.isBlocked(userId) && !alertTargets.has(userId)) continue;
        const dcs = Array.from(dcSet).filter(dc => DC_WORLD_MAP[dc]);
        if (dcs.length > 0) list.push({ userId, dcs });
    }
    return { list, enabledCount: byUser.size };
}

// Users who send market alerts to server channels instead of DMs (up to 3 servers they own or are admin in).
// Missing column/table (website not opened yet) = everyone gets DMs.
async function loadTargets() {
    const next = new Map();
    try {
        // Two simple queries instead of a JOIN: the two tables were created with different collations
        const [users] = await pool.execute("SELECT user_id FROM market_alerts WHERE alert_target = 'server'");
        const serverUsers = new Set(users.map(u => String(u.user_id)));
        const [rows] = serverUsers.size
            ? await pool.execute('SELECT user_id, guild_id, channel_id FROM market_alert_channels ORDER BY user_id, position')
            : [[]];
        for (const r of rows) {
            const id = String(r.user_id);
            if (!serverUsers.has(id)) continue;
            if (!next.has(id)) next.set(id, []);
            next.get(id).push({ guildId: String(r.guild_id), channelId: String(r.channel_id) });
        }
    } catch (err) {
        if (!/Unknown column|doesn't exist/i.test(err.message)) console.error('❌ [MARKET] Could not load alert channels:', err.message);
    }
    alertTargets = next;
}

// DM interval per user (market alerts + retainer undercuts). Missing column or error = everyone 1 minute.
async function loadIntervals() {
    try {
        const [rows] = await pool.execute('SELECT user_id, alert_interval FROM market_alerts WHERE alert_interval <> 1');
        alertIntervals.clear();
        for (const r of rows) {
            const m = Number(r.alert_interval);
            if (ALERT_INTERVALS.includes(m)) alertIntervals.set(String(r.user_id), m);
        }
    } catch (err) {
        if (!/Unknown column/i.test(err.message)) console.error('❌ [MARKET] Could not load DM intervals:', err.message);
    }
}

// Due when the user's last alert DM was at least their interval ago (5 seconds of slack for timer drift)
function isDue(userId, now) {
    const last = lastSentAt.get(userId);
    if (!last) return true;
    return now - last >= (alertIntervals.get(userId) || 1) * 60 * 1000 - 5000;
}

function getNeededWorlds() {
    const worlds = new Set();
    for (const sub of subscribers) {
        for (const dc of sub.dcs) DC_WORLD_MAP[dc].forEach(id => worlds.add(id));
    }
    for (const id of retainerWatch.getWorlds()) worlds.add(id); // worlds of watched retainers
    return worlds;
}

// Universalis only accepts BSON-encoded messages
function sendBson(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(BSON.serialize(payload));
}

function syncSubscriptions() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const needed = getNeededWorlds();
    let added = 0;
    let removed = 0;
    for (const id of Array.from(subscribedWorlds)) {
        if (!needed.has(id)) {
            sendBson({ event: 'unsubscribe', channel: 'listings/add{world=' + id + '}' });
            subscribedWorlds.delete(id);
            removed++;
        }
    }
    for (const id of needed) {
        if (!subscribedWorlds.has(id)) {
            sendBson({ event: 'subscribe', channel: 'listings/add{world=' + id + '}' });
            subscribedWorlds.add(id);
            added++;
        }
    }
    // Retainer Watch: also hear when listings are sold or pulled on watched worlds
    const removeNeeded = retainerWatch.getWorlds();
    for (const id of Array.from(subscribedRemoveWorlds)) {
        if (!removeNeeded.has(id)) {
            sendBson({ event: 'unsubscribe', channel: 'listings/remove{world=' + id + '}' });
            subscribedRemoveWorlds.delete(id);
        }
    }
    for (const id of removeNeeded) {
        if (!subscribedRemoveWorlds.has(id)) {
            sendBson({ event: 'subscribe', channel: 'listings/remove{world=' + id + '}' });
            subscribedRemoveWorlds.add(id);
        }
    }
    if (added || removed) {
        console.log('📡 [WS] Subscriptions updated: +' + added + ' / -' + removed + ' (watching ' + subscribedWorlds.size + ' worlds).');
    }
}

function cleanupSocket() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.removeAllListeners();
        ws.on('error', () => { }); // swallow errors from the socket being torn down
        ws.terminate();
        ws = null;
    }
    subscribedWorlds = new Set();
    subscribedRemoveWorlds = new Set();
}

function connect(client) {
    cleanupSocket();
    ws = new WebSocket(UNIVERSALIS_WS_URL);

    ws.on('open', () => {
        console.log('🌐 [WS] Successfully connected to Universalis WebSocket feed.');
        reconnectDelay = 10000;
        syncSubscriptions();
        pingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
        }, 30000);
    });

    ws.on('message', (data) => {
        messageCount++;
        if (messageCount % 500 === 0) {
            console.log('📥 [WS TRAFFIC] Received ' + messageCount + ' market messages from Universalis...');
        }
        let message;
        try {
            message = BSON.deserialize(data);
        } catch (error) {
            console.error('❌ [PARSE ERROR] Could not decode WS message:', error.message);
            return;
        }
        if (message && message.event === 'listings/remove') {
            retainerWatch.onListingsRemove(message).catch(err => console.error('❌ [RETAINER ERROR]:', err.message));
            return;
        }
        retainerWatch.onListingsAdd(message).catch(err => console.error('❌ [RETAINER ERROR]:', err.message));
        handleListingsAdd(client, message).catch(err => console.error('❌ [EVAL ERROR]:', err.message));
    });

    ws.on('close', (code, reason) => {
        cleanupSocket();
        if (subscribers.length === 0 && !retainerWatch.hasWatches()) return; // nothing to watch; the refresh loop reconnects when needed
        const reasonText = reason && reason.length ? reason.toString() : 'None';
        console.log('⚠️ [WS CLOSED] Code: ' + code + ', Reason: ' + reasonText + '. Reconnecting in ' + Math.round(reconnectDelay / 1000) + 's...');
        reconnectTimer = setTimeout(() => connect(client), reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 5 * 60 * 1000);
    });

    ws.on('error', (err) => {
        console.error('❌ [WS ERROR]:', err.message);
    });
}

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median of recent real sales per quality. A median ignores troll sales (1 gil or millions) that wreck plain averages.
function buildBaseline(data) {
    const history = Array.isArray(data.recentHistory) ? data.recentHistory : [];
    const result = {};
    for (const quality of ['nq', 'hq']) {
        const wantHq = quality === 'hq';
        const sales = history.filter(e => Boolean(e.hq) === wantHq && typeof e.pricePerUnit === 'number' && e.pricePerUnit > 0);
        // Like the Universalis website: median of the last 7 days. If fewer than 5 sales in 7 days, use all fetched sales.
        const cutoff = (Date.now() - RECENT_WINDOW_MS) / 1000; // Universalis history timestamps are in seconds
        const recent = sales.filter(e => typeof e.timestamp === 'number' && e.timestamp >= cutoff);
        const used = recent.length >= MIN_SALES_FOR_MEDIAN ? recent : sales;
        const prices = used.map(e => e.pricePerUnit);
        result[quality] = {
            median: prices.length ? median(prices) : null,
            count: prices.length,
            velocity: wantHq ? data.hqSaleVelocity : data.nqSaleVelocity
        };
    }
    return result;
}

// Real market baseline: median of the Data Center's recent sales from Universalis
async function getBaseline(itemId, dc) {
    const key = itemId + ':' + dc;
    const cached = baselineCache.get(key);
    if (cached && Date.now() - cached.time < BASELINE_CACHE_MS) return cached.data;
    if (pendingLookups >= MAX_PENDING_LOOKUPS) return null;

    pendingLookups++;
    try {
        const wait = Math.max(0, nextLookupAt - Date.now());
        nextLookupAt = Math.max(Date.now(), nextLookupAt) + LOOKUP_GAP_MS;
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));

        const res = await axios.get(UNIVERSALIS_API + '/' + encodeURIComponent(dc) + '/' + itemId, {
            params: { listings: 0, entries: HISTORY_ENTRIES },
            timeout: 8000
        });
        const data = res.data ? buildBaseline(res.data) : null;
        baselineCache.set(key, { time: Date.now(), data });
        return data;
    } catch (err) {
        return null;
    } finally {
        pendingLookups--;
    }
}

async function waitForLookupSlot() {
    const wait = Math.max(0, nextLookupAt - Date.now());
    nextLookupAt = Math.max(Date.now(), nextLookupAt) + LOOKUP_GAP_MS;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

// Check 2: the new listing must also be far below the next cheapest OTHER listings on the DC.
// Catches typos (missing zero) and wrong-item prices, but skips items several sellers already sell near that price.
async function passesListingCheck(itemId, dc, quality, listing) {
    try {
        await waitForLookupSlot();
        const res = await axios.get(UNIVERSALIS_API + '/' + encodeURIComponent(dc) + '/' + itemId, {
            params: { listings: 30, entries: 0, hq: quality === 'hq' ? 'true' : 'false' },
            timeout: 8000
        });
        const wantHq = quality === 'hq';
        const others = (res.data && Array.isArray(res.data.listings) ? res.data.listings : [])
            .filter(l => Boolean(l.hq) === wantHq)
            .filter(l => !l.onMannequin)                                                     // ignore mannequin listings
            .filter(l => !(listing.listingID && l.listingID === listing.listingID))       // not the new listing itself
            .filter(l => !(listing.retainerName && l.retainerName === listing.retainerName)) // not the same seller's copies
            .map(l => l.pricePerUnit)
            .filter(p => typeof p === 'number' && p > 0)
            .sort((a, b) => a - b)
            .slice(0, LISTING_CHECK_COUNT);

        if (others.length === 0) return true; // nothing to compare with: Check 1 decides

        const avgOthers = others.reduce((a, b) => a + b, 0) / others.length;
        const diff = ((listing.pricePerUnit - avgOthers) / avgOthers) * 100;
        if (diff <= DISCOUNT_THRESHOLD) return true;

        console.log('⏭️ [SKIP] Item #' + itemId + ' ' + quality.toUpperCase() + ' (' + dc + '): ' + listing.pricePerUnit +
            ' Gil is not far below other listings (avg of next ' + others.length + ': ' + Math.round(avgOthers) + ' Gil).');
        return false;
    } catch (err) {
        console.warn('⚠️ [LISTING CHECK] Could not check other listings for item #' + itemId + ': ' + err.message);
        return true; // Check 1 already passed
    }
}

async function getItemName(itemId) {
    const cachedName = itemNameCache.get(itemId);
    if (cachedName && Date.now() - cachedName.time < NAME_CACHE_MS) return cachedName.name;
    try {
        const res = await axios.get('https://v2.xivapi.com/api/sheet/Item/' + itemId, { timeout: 5000 });
        const name = res.data && res.data.fields && res.data.fields.Name ? res.data.fields.Name : null;
        if (name) {
            itemNameCache.delete(itemId);
            itemNameCache.set(itemId, { name, time: Date.now() });
            // Keep at most NAME_CACHE_MAX names (oldest are dropped first)
            while (itemNameCache.size > NAME_CACHE_MAX) itemNameCache.delete(itemNameCache.keys().next().value);
        }
        return name;
    } catch (e) {
        return null;
    }
}

async function handleListingsAdd(client, message) {
    if (!message || message.event !== 'listings/add') return;

    const itemId = message.item;
    const worldId = message.world;
    const listings = Array.isArray(message.listings) ? message.listings : [];
    if (!itemId || !worldId || listings.length === 0) return;

    const dc = WORLD_TO_DC[worldId];
    if (!dc) return;
    if (!subscribers.some(sub => sub.dcs.includes(dc))) return;

    // Cheapest new NQ and HQ listing in this update
    const cheapest = {};
    for (const l of listings) {
        if (typeof l.pricePerUnit !== 'number' || l.pricePerUnit <= 0) continue;
        if (l.onMannequin) continue; // housing mannequin listings (often gifts to alts) - never alert
        const quality = l.hq ? 'hq' : 'nq';
        if (!cheapest[quality] || l.pricePerUnit < cheapest[quality].pricePerUnit) cheapest[quality] = l;
    }
    if (!cheapest.nq && !cheapest.hq) return;

    const baseline = await getBaseline(itemId, dc);
    if (!baseline) return;

    for (const quality of ['nq', 'hq']) {
        const listing = cheapest[quality];
        if (!listing) continue;

        // Baseline = median of recent sales of this quality on the DC
        const q = baseline[quality];
        if (!q || q.count < MIN_SALES_FOR_MEDIAN) continue;
        const avg = q.median;
        if (!avg || avg < MIN_BASELINE_PRICE) continue;
        if (!q.velocity || q.velocity < MIN_DAILY_SALES) continue;

        const percentDiff = ((listing.pricePerUnit - avg) / avg) * 100;
        // Check 1 (median) and Check 2 (other current listings) must both pass
        if (percentDiff <= DISCOUNT_THRESHOLD && await passesListingCheck(itemId, dc, quality, listing)) {
            console.log('🚨 [MATCH] Item #' + itemId + ' ' + quality.toUpperCase() + ' on ' + (WORLD_NAMES[worldId] || worldId) + ' (' + dc + '): ' +
                listing.pricePerUnit + ' Gil vs median ' + Math.round(avg) + ' Gil (' + percentDiff.toFixed(1) + '%).');
            await notifySubscribedUsers(client, {
                itemId,
                worldId,
                dc,
                listingPrice: listing.pricePerUnit,
                baselinePrice: avg,
                percentDiff,
                hq: quality === 'hq',
                quantity: listing.quantity
            });
        }
    }
}

// Collect matches per user; they are sent together by flushAlerts() at each user's DM interval
function notifySubscribedUsers(client, alertData) {
    const now = Date.now();
    const quality = alertData.hq ? 'hq' : 'nq';
    for (const sub of subscribers) {
        if (!sub.dcs.includes(alertData.dc)) continue;
        const key = sub.userId + ':' + alertData.itemId + ':' + alertData.worldId + ':' + quality;
        const last = alertCooldowns.get(key);
        if (last && now - last < ALERT_COOLDOWN_MS) continue;
        alertCooldowns.set(key, now);

        if (!pendingAlerts.has(sub.userId)) pendingAlerts.set(sub.userId, new Map());
        const userItems = pendingAlerts.get(sub.userId);
        const itemKey = alertData.itemId + ':' + quality;
        if (!userItems.has(itemKey)) {
            userItems.set(itemKey, { itemId: alertData.itemId, hq: alertData.hq, rows: new Map() });
        }
        const entry = userItems.get(itemKey);
        const existing = entry.rows.get(alertData.worldId);
        if (!existing || alertData.listingPrice < existing.price) {
            entry.rows.set(alertData.worldId, {
                worldId: alertData.worldId,
                dc: alertData.dc,
                price: alertData.listingPrice,
                avg: alertData.baselinePrice,
                percent: alertData.percentDiff
            });
        }
    }
}

const CODE_FENCE = String.fromCharCode(96).repeat(3); // Discord code block fence for the aligned table
const ALERT_FOOTER = 'Data provided by Universalis Live Feed • Use /datacenter to change your Data Centers';

function padRight(text, width) {
    text = String(text);
    return text + ' '.repeat(Math.max(0, width - text.length));
}

function padLeft(text, width) {
    text = String(text);
    return ' '.repeat(Math.max(0, width - text.length)) + text;
}

// Lowest price on top, then the rest of its Data Center, then the next Data Center by its lowest price
function sortRows(rows) {
    const byDc = new Map();
    for (const row of rows) {
        if (!byDc.has(row.dc)) byDc.set(row.dc, []);
        byDc.get(row.dc).push(row);
    }
    const groups = Array.from(byDc.values()).map(list => list.sort((a, b) => a.price - b.price));
    groups.sort((a, b) => a[0].price - b[0].price);
    return groups.flat();
}

function bestPercent(entry) {
    return Math.min(...Array.from(entry.rows.values()).map(r => r.percent));
}

function buildItemEmbed(entry, itemName) {
    const rows = sortRows(Array.from(entry.rows.values()));
    const worldCells = rows.map(r => '[' + r.dc + '] ' + (WORLD_NAMES[r.worldId] || ('World ' + r.worldId)));
    const priceCells = rows.map(r => r.price.toLocaleString('en-US') + ' Gil');
    const avgCells = rows.map(r => Math.round(r.avg).toLocaleString('en-US') + ' Gil');

    const headers = ['World', 'Listed Price', 'DC Median Sale'];
    const w1 = Math.max(headers[0].length, ...worldCells.map(c => c.length));
    const w2 = Math.max(headers[1].length, ...priceCells.map(c => c.length));
    const w3 = Math.max(headers[2].length, ...avgCells.map(c => c.length));

    const lines = [
        padRight(headers[0], w1) + '  ' + padLeft(headers[1], w2) + '  ' + padLeft(headers[2], w3),
        '-'.repeat(w1 + w2 + w3 + 4)
    ];
    let length = lines.join('\n').length;
    let shown = 0;
    for (let i = 0; i < rows.length; i++) {
        const line = padRight(worldCells[i], w1) + '  ' + padLeft(priceCells[i], w2) + '  ' + padLeft(avgCells[i], w3);
        if (length + line.length + 60 > 3900) break; // Discord embed description limit is 4,096
        lines.push(line);
        length += line.length + 1;
        shown++;
    }
    if (shown < rows.length) lines.push('...and ' + (rows.length - shown) + ' more world(s)');

    const name = itemName ? itemName + ' (#' + entry.itemId + ')' : 'Item #' + entry.itemId;
    // Item name alone in its own box (Discord shows a copy button) for pasting into the in-game market board search
    const nameBox = itemName ? CODE_FENCE + '\n' + String(itemName).replace(/`/g, '') + '\n' + CODE_FENCE + '\n' : '';
    const title = '🚨 ' + name + ' — ' + (entry.hq ? 'HQ' : 'NQ') + ' (up to ' + bestPercent(entry).toFixed(1) + '%)';

    return new EmbedBuilder()
        .setTitle(title.slice(0, 256))
        .setURL('https://universalis.app/market/' + entry.itemId)
        .setColor('#e74c3c')
        .setDescription(nameBox + CODE_FENCE + '\n' + lines.join('\n') + '\n' + CODE_FENCE);
}

// Split embeds into messages: max 10 items each, and under Discord's character limit
function chunkEmbeds(embeds) {
    const messages = [];
    let current = [];
    let chars = 0;
    for (const embed of embeds) {
        const size = (embed.data.title || '').length + (embed.data.description || '').length;
        if (current.length >= MAX_ITEMS_PER_MESSAGE || (current.length > 0 && chars + size > MAX_MESSAGE_CHARS)) {
            messages.push(current);
            current = [];
            chars = 0;
        }
        current.push(embed);
        chars += size;
    }
    if (current.length) messages.push(current);
    return messages;
}

// "Server channel" mode: post the market alerts in each chosen channel (no pings). The user must still be the
// server's owner or an admin; otherwise that server is skipped.
async function postToChannels(client, userId, targets, embeds) {
    let sent = 0;
    for (const t of targets) {
        const guild = client.guilds.cache.get(t.guildId);
        const channel = guild && guild.channels.cache.get(t.channelId);
        const warnKey = userId + ':' + t.guildId;
        const warn = text => {
            if (Date.now() - (targetWarned.get(warnKey) || 0) < 6 * 60 * 60 * 1000) return;
            targetWarned.set(warnKey, Date.now());
            console.error('❌ [MARKET] ' + text);
        };
        if (!guild || !channel || !channel.isTextBased()) { warn('Alert channel for user ' + userId + ' not found (server ' + t.guildId + ').'); continue; }
        const member = guild.ownerId === userId ? null : await guild.members.fetch(userId).catch(() => null);
        if (guild.ownerId !== userId && !(member && member.permissions.has(PermissionFlagsBits.Administrator))) {
            warn('User ' + userId + ' is no longer owner/admin of ' + guild.name + ': market alerts not posted there.');
            continue;
        }
        for (const group of chunkEmbeds(embeds)) {
            group[group.length - 1].setFooter({ text: ALERT_FOOTER }).setTimestamp();
            try {
                await channel.send({ embeds: group, allowedMentions: { parse: [] } });
                sent++;
            } catch (err) {
                warn('Could not post market alerts in #' + channel.name + ' (' + guild.name + '): ' + err.message);
                break;
            }
        }
    }
    if (sent) console.log('✅ [ALERTS POSTED] Market alerts for user ' + userId + ' posted in ' + sent + ' message(s) to server channel(s).');
    return sent;
}

async function flushAlerts(client) {
    if (flushing || (pendingAlerts.size === 0 && !retainerWatch.hasPending())) return;
    flushing = true;
    const now = Date.now();
    const due = userId => isDue(userId, now);
    // Only users whose DM interval has passed; everyone else keeps collecting until their next DM
    const batch = new Map();
    for (const [userId, items] of Array.from(pendingAlerts)) {
        if (!due(userId)) continue;
        batch.set(userId, items);
        pendingAlerts.delete(userId);
    }
    const undercuts = retainerWatch.takePending(due); // Retainer Watch: same DM, sent first
    for (const userId of undercuts.keys()) if (!batch.has(userId)) batch.set(userId, new Map());

    try {
        for (const [userId, items] of batch) {
            // Biggest discount first
            let entries = Array.from(items.values()).sort((a, b) => bestPercent(a) - bestPercent(b));

            // "Server channel" mode: market alerts go to the channels; retainer undercuts still go to the DM below
            const targets = alertTargets.get(userId);
            if (targets && targets.length && entries.length) {
                const itemEmbeds = [];
                for (const entry of entries) itemEmbeds.push(buildItemEmbed(entry, await getItemName(entry.itemId)));
                await postToChannels(client, userId, targets, itemEmbeds);
                lastSentAt.set(userId, now);
                entries = [];
            }
            const hasUndercuts = undercuts.get(userId) && undercuts.get(userId).size;
            if (!entries.length && !hasUndercuts) continue;

            const embeds = [];
            const userUndercuts = undercuts.get(userId);
            if (userUndercuts && userUndercuts.size) {
                const names = new Map();
                for (const u of userUndercuts.values()) if (!names.has(u.itemId)) names.set(u.itemId, await getItemName(u.itemId));
                embeds.push(retainerWatch.buildUndercutEmbed(userUndercuts, names));
            }
            for (const entry of entries) {
                embeds.push(buildItemEmbed(entry, await getItemName(entry.itemId)));
            }

            // Split into messages: max 10 items each, and under Discord's character limit
            const messages = [];
            let current = [];
            let chars = 0;
            for (const embed of embeds) {
                const size = (embed.data.title || '').length + (embed.data.description || '').length;
                if (current.length >= MAX_ITEMS_PER_MESSAGE || (current.length > 0 && chars + size > MAX_MESSAGE_CHARS)) {
                    messages.push(current);
                    current = [];
                    chars = 0;
                }
                current.push(embed);
                chars += size;
            }
            if (current.length) messages.push(current);

            const userUndercuts0 = undercuts.get(userId);
            if (dmStatus.isBlocked(userId)) {
                if (userUndercuts0 && userUndercuts0.size) await retainerWatch.forgetAlerts(userUndercuts0);
                continue;
            }
            let user;
            try {
                user = await client.users.fetch(userId);
            } catch (err) {
                console.error('❌ [DM FAILED] Could not find user ' + userId + ': ' + err.message);
                if (err && err.code === 10013) await dmStatus.markFailed(userId, 'unknown_user');
                if (userUndercuts0 && userUndercuts0.size) await retainerWatch.forgetAlerts(userUndercuts0);
                continue;
            }

            for (const group of messages) {
                group[group.length - 1].setFooter({ text: entries.length ? ALERT_FOOTER : 'Data provided by Universalis Live Feed' }).setTimestamp();
                try {
                    await user.send({ embeds: group });
                    lastSentAt.set(userId, now);
                    console.log('✅ [DM SENT] Alert message (' + group.length + ' embed(s)) sent to user ' + userId);
                    await dmStatus.markOk(userId);
                } catch (err) {
                    console.error('❌ [DM FAILED] Could not send DM to user ' + userId + '. Reason: ' + err.message + ' (Check direct message privacy settings)');
                    // 50007 = DMs closed or no server shared with Pingway: pause this user's alerts for a while
                    if (err && err.code === 50007) await dmStatus.markFailed(userId, 'dm_closed');
                    if (userUndercuts0 && userUndercuts0.size) await retainerWatch.forgetAlerts(userUndercuts0); // alert again later
                    break;
                }
            }
        }
    } finally {
        flushing = false;
    }
}

async function refresh(client) {
    try {
        await dmStatus.load();
        const { list, enabledCount } = await loadSubscribers();
        subscribers = list;
        await loadIntervals();
        await retainerWatch.load();

        // Prune old cache entries
        const now = Date.now();
        for (const [k, v] of baselineCache) {
            if (now - v.time > BASELINE_CACHE_MS) baselineCache.delete(k);
        }
        for (const [k, t] of alertCooldowns) {
            if (now - t > ALERT_COOLDOWN_MS) alertCooldowns.delete(k);
        }
        for (const [k, v] of itemNameCache) {
            if (now - v.time > NAME_CACHE_MS) itemNameCache.delete(k);
        }
        for (const [k, t] of lastSentAt) {
            if (now - t > 60 * 60 * 1000) lastSentAt.delete(k);
        }

        if (subscribers.length === 0 && !retainerWatch.hasWatches()) {
            if (ws || reconnectTimer) {
                console.log('ℹ️ [MARKET] No subscribers with saved Data Centers. Closing feed and standing by...');
                cleanupSocket();
            }
            return { enabledCount, ready: 0 };
        }

        if (!ws) {
            if (!reconnectTimer) connect(client);
        } else {
            syncSubscriptions();
        }
        return { enabledCount, ready: subscribers.length, retainers: retainerWatch.getWorlds().size };
    } catch (err) {
        console.error('❌ [MARKET] Failed to refresh subscribers:', err.message);
        return null;
    }
}

async function initMarketMonitor(client) {
    if (started) return;
    started = true;

    console.log('🔍 [INIT] Loading market alert subscribers...');
    await loadWorldData();
    const result = await refresh(client);
    if (result) {
        if (result.retainers) console.log('🏷️ [INIT] Retainer Watch active on ' + result.retainers + ' world(s).');
        if (result.ready === 0) {
            console.log('⚠️ [INIT] ' + result.enabledCount + ' user(s) have market alerts on, but none have Data Centers saved with /datacenter. Monitor standing by...');
        } else {
            const skipped = result.enabledCount - result.ready;
            console.log('✅ [INIT] ' + result.ready + ' subscriber(s) with saved Data Centers.' + (skipped > 0 ? ' (' + skipped + ' skipped: no /datacenter saved)' : ''));
        }
    }
    refreshTimer = setInterval(() => refresh(client), SUBSCRIBER_REFRESH_MS);
    flushTimer = setInterval(() => {
        flushAlerts(client).catch(err => console.error('❌ [DM ERROR] Failed to send collected alerts:', err.message));
    }, FLUSH_INTERVAL_MS);
}

module.exports = { initMarketMonitor };
