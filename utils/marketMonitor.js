const WebSocket = require('ws');
const { BSON } = require('bson');
const axios = require('axios');
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { pool } = require('./db');
const retainerWatch = require('./retainerWatch');
const itemAlerts = require('./itemAlerts');
const { ensureAlertSplit } = require('./alertSplitDdl');
const dmStatus = require('./dmStatus');
const { t, localeOf } = require('./i18n');
const userLanguage = require('./userLanguage');
const { ownerHasMembership } = require('./membership');

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
// Data Center -> Universalis region (Item alerts can watch a whole region); replaced by the live list on startup
let DC_REGION = {
    Aether: 'North-America', Primal: 'North-America', Crystal: 'North-America', Dynamis: 'North-America',
    Chaos: 'Europe', Light: 'Europe', Materia: 'Oceania',
    Elemental: 'Japan', Gaia: 'Japan', Mana: 'Japan', Meteor: 'Japan'
};

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
const IMMEDIATE = 0;                          // alert_interval 0 = Alert timing "Immediate": sent as soon as found
const MAX_ITEMS_PER_MESSAGE = 10;             // Up to 10 items per DM message (no limit on messages)
const MAX_MESSAGE_CHARS = 5800;               // Stay under Discord's 6,000 character limit per message
const BASELINE_CACHE_MS = 15 * 60 * 1000;     // Cache Universalis price baselines for 15 minutes
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;     // Same item/world/quality alerts a user at most once per hour
const SUBSCRIBER_REFRESH_MS = 5 * 60 * 1000;  // Re-check subscribers and their Data Centers every 5 minutes
const MAX_PENDING_LOOKUPS = 50;               // Skip evaluations while this many price lookups are queued
const LOOKUP_GAP_MS = 150;                    // Space Universalis REST calls (about 6 per second max)
const BOUGHT_CHECK_MS = 10000;                // "Already bought" check: hold each match 10 s before it can be sent (Immediate too)
const BOUGHT_SALE_SLACK_MS = 60 * 1000;       // a sale counts when its timestamp is at most 60 s before the listing was first seen

let ws = null;
let reconnectTimer = null;
let pingInterval = null;
let refreshTimer = null;
let reconnectDelay = 10000;
let messageCount = 0;
let started = false;
let subscribedWorlds = new Set();
let subscribedRemoveWorlds = new Set(); // listings/remove channels (Retainer Watch + the "already bought" check)
let subscribedSalesWorlds = new Set();  // sales/add channels ("already bought" check of market alerts / Item alerts)
let subscribers = []; // [{ userId, dcs: ['Mana', ...] }] (the market alert Data Centers set on the website)

const baselineCache = new Map();  // 'itemId:dc' -> { time, data }
const itemNameCache = new Map();  // itemId -> { name, time } (cleared after 24h, max 5,000 names)
const NAME_CACHE_MS = 24 * 60 * 60 * 1000;
const NAME_CACHE_MAX = 5000;
const alertCooldowns = new Map(); // 'user:item:world:quality' -> time
const pendingAlerts = new Map();  // userId -> Map('itemId:quality' -> { itemId, hq, rows: Map(worldId -> row) })
let flushTimer = null;
let flushing = false;
const alertIntervals = new Map(); // userId -> minutes (only users who chose something other than 1; 0 = Immediate)
const immediateQueue = new Set(); // Immediate users waiting for their quick flush
let immediateScheduled = false;
let quickFlushRunning = false;    // the running flush is an Immediate quick flush
let timerFlushWaiting = false;    // the 60-second timer came during a quick flush: run it right after (interval users keep their timing)
const minMedians = new Map();     // userId -> Gil: only alert when the DC median is higher (set on the website; none = no extra limit)
const lastSentAt = new Map();     // userId -> time of their last alert DM
let alertTargets = new Map();     // userId -> [{ guildId, channelId, roleId }] server channels (set on the website)
let dmOff = new Set();            // users with server channels whose market alert DMs are off (DM switch on the website)
// Server channels per user: 3 free, 10 with Supporter Perks (same limits as the website; extra saved rows wait unused)
const CHANNEL_LIMITS = { free: 3, perks: 10 };
const targetWarned = new Map();   // 'userId:guildId' -> time (keeps the console quiet)
let pendingLookups = 0;
let nextLookupAt = 0;
// Retainer undercut alerts and Item alerts have their own settings (website; tables alert_settings / alert_channels):
// DM switch, Alert timing and server channels (3 free / 10 with Supporter Perks, counted per kind)
const KIND_KEYS = ['retainer', 'item'];
const kinds = {};
for (const k of KIND_KEYS) kinds[k] = { intervals: new Map(), dmOff: new Set(), targets: new Map(), lastSent: new Map() };
const pendingItems = new Map();   // userId -> Map('alertId:quality' -> { itemId, name, hq, rows: Map(placeKey:worldId -> row) })
let splitReady = false;           // tables + one-time copy done (alertSplitDdl.js)

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
            const regions = {};
            for (const dc of dcRes.data) {
                if (dc && dc.name && Array.isArray(dc.worlds)) map[dc.name] = dc.worlds;
                if (dc && dc.name && dc.region) regions[dc.name] = dc.region;
            }
            DC_WORLD_MAP = map;
            if (Object.keys(regions).length) DC_REGION = regions;
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

// Subscribers = users with market alerts on, using the market alert Data Centers they set on the website
// (market_alert_dcs; /price and /datacenter keep their own list). The first start copied everyone's /datacenter
// list there once (alertSplitDdl.js). Users with no market alert Data Centers are skipped (nothing is scanned for them).
async function loadSubscribers() {
    // Two simple queries instead of a JOIN (tables made at different times can have different collations)
    const [users] = await pool.execute('SELECT user_id FROM market_alerts WHERE dm_enabled = 1');
    let dcRows = [];
    try {
        [dcRows] = await pool.execute('SELECT user_id, datacenters FROM market_alert_dcs');
    } catch (err) {
        if (!/doesn't exist/i.test(err.message)) throw err; // table not created yet: nobody has market Data Centers
    }
    const dcsOf = new Map(dcRows.map(r => [String(r.user_id), r.datacenters]));
    const byUser = new Map();
    for (const u of users) byUser.set(String(u.user_id), new Set(parseDCList(dcsOf.get(String(u.user_id)))));
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

// Users who post market alerts in server channels (servers they own or are admin in, Pingway in them):
// 3 channels free, 10 with Supporter Perks, each with an optional role ping (website Retainers tab -> Market alerts).
// alert_target 'server' = channels in use. The DM switch is market_dm (NULL = older row: channels replaced the DM).
// Missing column/table (website not opened yet) = everyone gets DMs.
async function loadTargets() {
    const next = new Map();
    const off = new Set();
    try {
        // Two simple queries instead of a JOIN: the two tables were created with different collations
        const [users] = await pool.execute("SELECT user_id FROM market_alerts WHERE alert_target = 'server'");
        const serverUsers = new Set(users.map(u => String(u.user_id)));
        let dmRows = [];
        try {
            [dmRows] = await pool.execute("SELECT user_id, market_dm FROM market_alerts WHERE alert_target = 'server' AND market_dm IS NOT NULL");
        } catch (err) {
            if (!/Unknown column/i.test(err.message)) throw err; // column not added yet: older rows only
        }
        const dmChoice = new Map(dmRows.map(r => [String(r.user_id), Number(r.market_dm) === 1]));
        for (const id of serverUsers) if (!(dmChoice.get(id) === true)) off.add(id); // NULL (older row) = channels only
        let rows = [[]];
        if (serverUsers.size) {
            try {
                rows = await pool.execute('SELECT user_id, guild_id, channel_id, role_id FROM market_alert_channels ORDER BY user_id, position');
            } catch (err) {
                if (!/Unknown column/i.test(err.message)) throw err;
                rows = await pool.execute('SELECT user_id, guild_id, channel_id FROM market_alert_channels ORDER BY user_id, position');
            }
        }
        for (const r of rows[0]) {
            const id = String(r.user_id);
            if (!serverUsers.has(id)) continue;
            if (!next.has(id)) next.set(id, []);
            next.get(id).push({ guildId: String(r.guild_id), channelId: String(r.channel_id), roleId: r.role_id ? String(r.role_id) : '' });
        }
        // More than the free channels saved: the rest only run while the user has Supporter Perks
        for (const [id, list] of next) {
            if (list.length <= CHANNEL_LIMITS.free) continue;
            const max = (await ownerHasMembership(id)) ? CHANNEL_LIMITS.perks : CHANNEL_LIMITS.free;
            if (list.length > max) next.set(id, list.slice(0, max));
        }
    } catch (err) {
        if (!/Unknown column|doesn't exist/i.test(err.message)) console.error('❌ [MARKET] Could not load alert channels:', err.message);
    }
    alertTargets = next;
    dmOff = off;
}

// DM interval per user (market alerts; retainer undercuts and Item alerts have their own, see loadKindSettings).
// 0 = Immediate. Missing column or error = everyone 1 minute.
async function loadIntervals() {
    try {
        const [rows] = await pool.execute('SELECT user_id, alert_interval FROM market_alerts WHERE alert_interval <> 1');
        alertIntervals.clear();
        for (const r of rows) {
            const m = Number(r.alert_interval);
            if (m === IMMEDIATE || ALERT_INTERVALS.includes(m)) alertIntervals.set(String(r.user_id), m);
        }
    } catch (err) {
        if (!/Unknown column/i.test(err.message)) console.error('❌ [MARKET] Could not load DM intervals:', err.message);
    }
}

// Minimum DC median per user (website Retainers tab -> Market alerts). Missing column = nobody has one.
async function loadMinMedians() {
    try {
        const [rows] = await pool.execute('SELECT user_id, min_median FROM market_alerts WHERE min_median IS NOT NULL');
        minMedians.clear();
        for (const r of rows) {
            const n = Number(r.min_median);
            if (n > 0) minMedians.set(String(r.user_id), n);
        }
    } catch (err) {
        if (!/Unknown column/i.test(err.message)) console.error('❌ [MARKET] Could not load minimum medians:', err.message);
    }
}

// Retainer undercut / Item alert settings of every user (no row = DM on, every 1 minute, no channels).
// Channels over the free 3 only run while the user has Supporter Perks (like market alert channels).
async function loadKindSettings(kind) {
    const k = kinds[kind];
    const intervals = new Map();
    const dmOffNext = new Set();
    const targets = new Map();
    try {
        const [rows] = await pool.execute('SELECT user_id, dm, alert_interval FROM alert_settings WHERE kind = ?', [kind]);
        for (const r of rows) {
            const id = String(r.user_id);
            const m = Number(r.alert_interval);
            if (m !== 1 && (m === IMMEDIATE || ALERT_INTERVALS.includes(m))) intervals.set(id, m);
            if (Number(r.dm) === 0) dmOffNext.add(id);
        }
        const [chans] = await pool.execute('SELECT user_id, guild_id, channel_id, role_id FROM alert_channels WHERE kind = ? ORDER BY user_id, position', [kind]);
        for (const r of chans) {
            const id = String(r.user_id);
            if (!targets.has(id)) targets.set(id, []);
            targets.get(id).push({ guildId: String(r.guild_id), channelId: String(r.channel_id), roleId: r.role_id ? String(r.role_id) : '' });
        }
        for (const [id, list] of targets) {
            if (list.length <= CHANNEL_LIMITS.free) continue;
            const max = (await ownerHasMembership(id)) ? CHANNEL_LIMITS.perks : CHANNEL_LIMITS.free;
            if (list.length > max) targets.set(id, list.slice(0, max));
        }
    } catch (err) {
        if (!/doesn't exist|Unknown column/i.test(err.message)) console.error('❌ [MARKET] Could not load ' + kind + ' alert settings:', err.message);
        return; // keep what was loaded before
    }
    k.intervals = intervals;
    k.dmOff = dmOffNext;
    k.targets = targets;
}

const isImmediate = userId => alertIntervals.get(String(userId)) === IMMEDIATE;
const kindImmediate = (kind, userId) => kinds[kind].intervals.get(String(userId)) === IMMEDIATE;
// Due for this kind (retainer / item): its own interval since its own last alert (5 seconds of slack)
function kindDue(kind, userId, now) {
    const k = kinds[kind];
    if (kindImmediate(kind, userId)) return true;
    const last = k.lastSent.get(String(userId));
    if (!last) return true;
    return now - last >= (k.intervals.get(String(userId)) || 1) * 60 * 1000 - 5000;
}
// Where this kind's alerts can go: DM (switch on and DMs work) or a server channel
const kindCanSend = (kind, userId) => {
    const id = String(userId);
    const channels = kinds[kind].targets.get(id);
    return Boolean(channels && channels.length) || (!kinds[kind].dmOff.has(id) && !dmStatus.isBlocked(id));
};

// Due when the user's last alert DM was at least their interval ago (5 seconds of slack for timer drift).
// Immediate users are always due.
function isDue(userId, now) {
    if (isImmediate(userId)) return true;
    const last = lastSentAt.get(userId);
    if (!last) return true;
    return now - last >= (alertIntervals.get(userId) || 1) * 60 * 1000 - 5000;
}

// Worlds of market alerts and Item alerts (these also get the "already bought" channels)
function getAlertWorlds() {
    const worlds = new Set();
    for (const sub of subscribers) {
        for (const dc of sub.dcs) DC_WORLD_MAP[dc].forEach(id => worlds.add(id));
    }
    for (const id of itemAlerts.getWorlds()) worlds.add(id);    // worlds of Item alerts
    return worlds;
}

function getNeededWorlds() {
    const worlds = getAlertWorlds();
    for (const id of retainerWatch.getWorlds()) worlds.add(id); // worlds of watched retainers
    return worlds;
}

// Subscribe / unsubscribe one channel kind so exactly the `needed` worlds are subscribed
function syncChannel(name, current, needed) {
    for (const id of Array.from(current)) {
        if (!needed.has(id)) {
            sendBson({ event: 'unsubscribe', channel: name + '{world=' + id + '}' });
            current.delete(id);
        }
    }
    for (const id of needed) {
        if (!current.has(id)) {
            sendBson({ event: 'subscribe', channel: name + '{world=' + id + '}' });
            current.add(id);
        }
    }
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
    // Retainer Watch + the "already bought" check: hear when listings are sold or pulled (retainer worlds and alert worlds),
    // and the sales uploaded by buyers (alert worlds)
    const alertWorlds = getAlertWorlds();
    const removeNeeded = retainerWatch.getWorlds();
    for (const id of alertWorlds) removeNeeded.add(id);
    syncChannel('listings/remove', subscribedRemoveWorlds, removeNeeded);
    syncChannel('sales/add', subscribedSalesWorlds, alertWorlds);
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
    subscribedSalesWorlds = new Set();
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
            boughtOnRemove(message);
            retainerWatch.onListingsRemove(message).catch(err => console.error('❌ [RETAINER ERROR]:', err.message));
            return;
        }
        if (message && message.event === 'sales/add') {
            boughtOnSale(message);
            return;
        }
        retainerWatch.onListingsAdd(message).catch(err => console.error('❌ [RETAINER ERROR]:', err.message));
        handleListingsAdd(client, message).catch(err => console.error('❌ [EVAL ERROR]:', err.message));
        handleItemAlerts(client, message).catch(err => console.error('❌ [ITEM ALERT ERROR]:', err.message));
    });

    ws.on('close', (code, reason) => {
        cleanupSocket();
        if (subscribers.length === 0 && !retainerWatch.hasWatches() && !itemAlerts.hasAlerts()) return; // nothing to watch; the refresh loop reconnects when needed
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

// lang: the reader's language (XIVAPI has item names in en, fr, de and ja); cached per language
async function getItemName(itemId, lang = 'en') {
    const cacheKey = lang === 'en' ? itemId : lang + ':' + itemId;
    const cachedName = itemNameCache.get(cacheKey);
    if (cachedName && Date.now() - cachedName.time < NAME_CACHE_MS) return cachedName.name;
    try {
        const res = await axios.get('https://v2.xivapi.com/api/sheet/Item/' + itemId + (lang === 'en' ? '' : '?language=' + lang), { timeout: 5000 });
        const name = res.data && res.data.fields && res.data.fields.Name ? res.data.fields.Name : null;
        if (name) {
            itemNameCache.delete(cacheKey);
            itemNameCache.set(cacheKey, { name, time: Date.now() });
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
            const alertData = {
                itemId,
                worldId,
                dc,
                listingPrice: listing.pricePerUnit,
                baselinePrice: avg,
                percentDiff,
                hq: quality === 'hq',
                quantity: listing.quantity
            };
            // "Already bought" check first; the cooldown is only used when it goes into the send queue
            holdForBoughtCheck('m:' + itemId + ':' + worldId + ':' + quality, itemId, worldId, listing, () => notifySubscribedUsers(client, alertData));
        }
    }
}

// Immediate users: send their collected alerts right away instead of waiting for the 60-second timer.
// Several matches found at the same moment go out together. If a flush is running, the next one starts
// as soon as it ends (flushAlerts calls this again), so nothing is lost or held back a full minute.
function requestImmediateFlush(client, userId) {
    if (!client) return;
    immediateQueue.add(String(userId));
    scheduleImmediateFlush(client);
}

function scheduleImmediateFlush(client) {
    if (immediateScheduled) return;
    immediateScheduled = true;
    setImmediate(() => {
        immediateScheduled = false;
        if (flushing || immediateQueue.size === 0) return; // the running flush starts the next one when it ends
        const users = new Set(immediateQueue);
        immediateQueue.clear();
        flushAlerts(client, users).catch(err => console.error('❌ [DM ERROR] Failed to send immediate alerts:', err.message));
    });
}

// Retainer undercuts of users whose retainer Alert timing is Immediate: send them as soon as they are found
// (flushAlerts still re-checks them with fresh data first)
function watchRetainerUndercuts(client) {
    retainerWatch.onPending(userId => { if (kindImmediate('retainer', userId)) requestImmediateFlush(client, userId); });
}

// Item alerts: check a new listing against the members' items (median lookups use the shared cache and spacing)
async function handleItemAlerts(client, message) {
    if (!message || message.event !== 'listings/add' || !itemAlerts.watchesItem(message.item)) return;
    await itemAlerts.onListingsAdd(message, {
        getBaseline,
        deferCommit: true, // the repeat / cooldown state is only set when the alert goes into the send queue
        onMatch: m => holdForBoughtCheck('i:' + m.alertId + ':' + m.place.key + ':' + (m.hq ? 'hq' : 'nq'), m.itemId, m.worldId, m.listing, () => {
            if (m.commit()) notifyItemMatch(client, m);
        })
    });
}

// ---------- "Already bought" check (market alerts + Item alerts) ----------
// A cheap listing is often bought by the person who uploaded it: their game re-uploads within seconds to a minute
// (listings/remove of that listing + a sales/add with the same price and quantity). So every match waits
// BOUGHT_CHECK_MS first and is dropped when that happens; then ONE live check of the world's listings (spaced like
// every lookup): gone = dropped, check failed = sent anyway. Entries are removed as soon as they resolve.
let clock = () => Date.now();
let schedule = (fn, ms) => setTimeout(fn, ms);
const held = new Map();          // holdKey -> { itemId, worldId, listingID, hq, price, quantity, firstSeen, release, dropped }
const recheckShared = new Map(); // 'worldId/itemId' -> { time, promise } (holds released together share one live check)

function holdForBoughtCheck(key, itemId, worldId, listing, release) {
    const lid = listing && listing.listingID ? String(listing.listingID) : '';
    const holdKey = key + ':' + (lid || (listing ? listing.pricePerUnit + 'x' + (listing.quantity || 0) : ''));
    if (held.has(holdKey)) return; // the same listing is already waiting
    const h = { itemId: Number(itemId), worldId: Number(worldId), listingID: lid, hq: Boolean(listing && listing.hq),
        price: listing ? listing.pricePerUnit : 0, quantity: listing ? listing.quantity || 0 : 0, firstSeen: clock(), release, dropped: null };
    held.set(holdKey, h);
    schedule(() => finishHold(holdKey).catch(err => console.error('❌ [BOUGHT] Check failed:', err.message)), BOUGHT_CHECK_MS);
}

function dropHold(holdKey, h, reason) {
    if (h.dropped) return;
    h.dropped = reason;
    held.delete(holdKey);
    console.log('🛒 [BOUGHT] Item #' + h.itemId + ' on ' + (WORLD_NAMES[h.worldId] || h.worldId) + ': dropped (' + reason + ').');
}

function boughtOnRemove(message) {
    if (!held.size || !message || !Array.isArray(message.listings)) return;
    const ids = new Set(message.listings.map(l => l && l.listingID ? String(l.listingID) : '').filter(Boolean));
    if (!ids.size) return;
    for (const [k, h] of Array.from(held)) {
        if (h.listingID && ids.has(h.listingID)) dropHold(k, h, 'listing removed');
    }
}

function boughtOnSale(message) {
    if (!held.size || !message || !Array.isArray(message.sales)) return;
    const itemId = Number(message.item);
    const worldId = Number(message.world);
    for (const [k, h] of Array.from(held)) {
        if (h.itemId !== itemId || h.worldId !== worldId) continue;
        const sold = message.sales.some(s => s && Boolean(s.hq) === h.hq && s.pricePerUnit === h.price && (s.quantity || 0) === h.quantity &&
            typeof s.timestamp === 'number' && s.timestamp * 1000 >= h.firstSeen - BOUGHT_SALE_SLACK_MS); // old history sales don't count
        if (sold) dropHold(k, h, 'sold to a buyer');
    }
}

// Current listings of the item on that world (null = the check failed)
function liveListings(worldId, itemId) {
    const key = worldId + '/' + itemId;
    const hit = recheckShared.get(key);
    if (hit && clock() - hit.time < 5000) return hit.promise;
    const promise = (async () => {
        try {
            await waitForLookupSlot();
            const res = await axios.get(UNIVERSALIS_API + '/' + worldId + '/' + itemId, { params: { listings: 100, entries: 0 }, timeout: 8000 });
            return res.data && Array.isArray(res.data.listings) ? res.data.listings : null;
        } catch (err) {
            return null;
        }
    })();
    recheckShared.set(key, { time: clock(), promise });
    for (const [k, v] of recheckShared) if (clock() - v.time > 60000) recheckShared.delete(k);
    return promise;
}

async function finishHold(holdKey) {
    const h = held.get(holdKey);
    if (!h || h.dropped) return;
    if (h.listingID) {
        const listings = await liveListings(h.worldId, h.itemId);
        if (h.dropped) return; // dropped by a remove / sale while checking
        if (listings && !listings.some(l => l && String(l.listingID) === h.listingID)) {
            dropHold(holdKey, h, 'gone at re-check');
            return;
        }
    }
    held.delete(holdKey);
    h.release();
}

// Collect one Item alert match; sent by flushAlerts at the member's Item alert timing (Immediate: right away)
function notifyItemMatch(client, m) {
    if (!kindCanSend('item', m.userId)) return;
    const userId = String(m.userId);
    if (!pendingItems.has(userId)) pendingItems.set(userId, new Map());
    const userItems = pendingItems.get(userId);
    const key = m.alertId + ':' + (m.hq ? 'hq' : 'nq');
    if (!userItems.has(key)) userItems.set(key, { itemId: m.itemId, name: m.name, hq: m.hq, rows: new Map() });
    const entry = userItems.get(key);
    const rowKey = m.place.key + ':' + m.worldId;
    const existing = entry.rows.get(rowKey);
    if (!existing || m.price < existing.price) {
        entry.rows.set(rowKey, { worldId: m.worldId, place: m.place, price: m.price, median: m.median });
    }
    if (kindImmediate('item', userId)) requestImmediateFlush(client, userId);
}

// Collect matches per user; they are sent together by flushAlerts() at each user's DM interval
// (Immediate users: right away, see requestImmediateFlush)
function notifySubscribedUsers(client, alertData) {
    const now = Date.now();
    const quality = alertData.hq ? 'hq' : 'nq';
    for (const sub of subscribers) {
        if (!sub.dcs.includes(alertData.dc)) continue;
        // The user's minimum DC median (checked before the cooldown, so a skipped item doesn't use it up)
        const minMedian = minMedians.get(sub.userId);
        if (minMedian && !(alertData.baselinePrice > minMedian)) continue;
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
        if (isImmediate(sub.userId)) requestImmediateFlush(client, sub.userId);
    }
}

const CODE_FENCE = String.fromCharCode(96).repeat(3); // Discord code block fence for the aligned table
const ALERT_FOOTER = t('en', 'alerts.footer');

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

function buildItemEmbed(entry, itemName, lang = 'en') {
    const rows = sortRows(Array.from(entry.rows.values()));
    const worldCells = rows.map(r => '[' + r.dc + '] ' + (WORLD_NAMES[r.worldId] || (t(lang, 'alerts.worldFallback', { id: r.worldId }))));
    const priceCells = rows.map(r => t(lang, 'alerts.gil', { n: r.price.toLocaleString(localeOf(lang)) }));
    const avgCells = rows.map(r => t(lang, 'alerts.gil', { n: Math.round(r.avg).toLocaleString(localeOf(lang)) }));

    const headers = [t(lang, 'alerts.headers.world'), t(lang, 'alerts.headers.price'), t(lang, 'alerts.headers.median')];
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
    if (shown < rows.length) lines.push(t(lang, 'alerts.moreWorlds', { count: rows.length - shown }));

    const name = itemName ? itemName + ' (#' + entry.itemId + ')' : t(lang, 'alerts.itemFallback', { id: entry.itemId });
    // Item name alone in its own box (Discord shows a copy button) for pasting into the in-game market board search
    const nameBox = itemName ? CODE_FENCE + '\n' + String(itemName).replace(/`/g, '') + '\n' + CODE_FENCE + '\n' : '';
    const title = t(lang, 'alerts.title', { name, quality: entry.hq ? 'HQ' : 'NQ', percent: bestPercent(entry).toFixed(1) });

    return new EmbedBuilder()
        .setTitle(title.slice(0, 256))
        .setURL('https://universalis.app/market/' + entry.itemId)
        .setColor('#e74c3c')
        .setDescription(nameBox + CODE_FENCE + '\n' + lines.join('\n') + '\n' + CODE_FENCE);
}

// One Item alert: the item (NQ/HQ), then World | Price | Median (the median column only when "below median" is used)
function buildItemAlertEmbed(entry, itemName, lang = 'en') {
    const rows = Array.from(entry.rows.values()).sort((a, b) => a.price - b.price);
    const withMedian = rows.some(r => typeof r.median === 'number');
    const worldCell = r => {
        const world = WORLD_NAMES[r.worldId] || t(lang, 'alerts.worldFallback', { id: r.worldId });
        return r.place.type === 'world' ? world : world + ' (' + r.place.name + ')';
    };
    const cells = rows.map(r => [worldCell(r), t(lang, 'alerts.gil', { n: r.price.toLocaleString(localeOf(lang)) }),
        typeof r.median === 'number' ? t(lang, 'alerts.gil', { n: Math.round(r.median).toLocaleString(localeOf(lang)) }) : '-']);
    const headers = [t(lang, 'alerts.headers.world'), t(lang, 'alerts.headers.price'), t(lang, 'alerts.item.median')];
    const cols = withMedian ? 3 : 2;
    const w = headers.slice(0, cols).map((h, i) => Math.max(h.length, ...cells.map(c => c[i].length)));
    const line = c => c.slice(0, cols).map((v, i) => (i === 0 ? padRight(v, w[i]) : padLeft(v, w[i]))).join('  ');
    const lines = [line(headers), '-'.repeat(w.reduce((a, b) => a + b, 0) + 2 * (cols - 1))];
    let length = lines.join('\n').length;
    let shown = 0;
    for (const c of cells) {
        const l = line(c);
        if (length + l.length + 60 > 3900) break;
        lines.push(l);
        length += l.length + 1;
        shown++;
    }
    if (shown < cells.length) lines.push(t(lang, 'alerts.moreWorlds', { count: cells.length - shown }));
    const shownName = itemName || entry.name;
    const name = shownName ? shownName + ' (#' + entry.itemId + ')' : t(lang, 'alerts.itemFallback', { id: entry.itemId });
    const nameBox = shownName ? CODE_FENCE + '\n' + String(shownName).replace(/`/g, '') + '\n' + CODE_FENCE + '\n' : '';
    return new EmbedBuilder()
        .setTitle(t(lang, 'alerts.item.title', { name, quality: entry.hq ? 'HQ' : 'NQ' }).slice(0, 256))
        .setURL('https://universalis.app/market/' + entry.itemId)
        .setColor('#3498db')
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

// Server channels: post the market alerts in each chosen channel (pings only the role picked for that channel, if any).
// The user must still be the server's owner or an admin; otherwise that server is skipped.
// embedsFor(lang): the alert embeds in that language (each server channel gets its server's language)
// footerKey: the footer text (market alerts by default; retainer undercuts and Item alerts use the short one)
async function postToChannels(client, userId, targets, embedsFor, footerKey = 'alerts.footer') {
    let sent = 0;
    for (const target of targets) {
        const guild = client.guilds.cache.get(target.guildId);
        const channel = guild && guild.channels.cache.get(target.channelId);
        const warnKey = userId + ':' + target.guildId;
        const warn = text => {
            if (Date.now() - (targetWarned.get(warnKey) || 0) < 6 * 60 * 60 * 1000) return;
            targetWarned.set(warnKey, Date.now());
            console.error('❌ [MARKET] ' + text);
        };
        if (!guild || !channel || !channel.isTextBased()) { warn('Alert channel for user ' + userId + ' not found (server ' + target.guildId + ').'); continue; }
        const member = guild.ownerId === userId ? null : await guild.members.fetch(userId).catch(() => null);
        if (guild.ownerId !== userId && !(member && member.permissions.has(PermissionFlagsBits.Administrator))) {
            warn('User ' + userId + ' is no longer owner/admin of ' + guild.name + ': market alerts not posted there.');
            continue;
        }
        const lang = userLanguage.forGuild(guild); // public post: the server's language
        let first = true;
        for (const group of chunkEmbeds(await embedsFor(lang))) {
            group[group.length - 1].setFooter({ text: t(lang, footerKey) }).setTimestamp();
            // the role ping goes on the first message only
            const ping = first && target.roleId && /^\d{15,22}$/.test(target.roleId) ? target.roleId : '';
            first = false;
            try {
                await channel.send(ping
                    ? { content: '<@&' + ping + '>', embeds: group, allowedMentions: { parse: [], roles: [ping] } }
                    : { embeds: group, allowedMentions: { parse: [] } });
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

// onlyUsers (optional): a Set of user IDs to send for (the Immediate quick flush); otherwise every due user.
// Market alerts, retainer undercuts and Item alerts each follow their own settings (DM switch, Alert timing, channels);
// what is due at the same moment goes out in one DM.
async function flushAlerts(client, onlyUsers) {
    if (flushing && !onlyUsers && quickFlushRunning) timerFlushWaiting = true;
    if (flushing || (pendingAlerts.size === 0 && !retainerWatch.hasPending() && pendingItems.size === 0)) return;
    flushing = true;
    quickFlushRunning = Boolean(onlyUsers);
    const now = Date.now();
    const asked = userId => !onlyUsers || onlyUsers.has(String(userId));
    const due = userId => asked(userId) && isDue(userId, now);
    // Only users whose DM interval has passed; everyone else keeps collecting until their next DM
    const batch = new Map();
    for (const [userId, items] of Array.from(pendingAlerts)) {
        if (!due(userId)) continue;
        batch.set(userId, items);
        pendingAlerts.delete(userId);
    }
    // Retainer Watch (its own timing), sent first. Each undercut is checked again with fresh data (false alerts are dropped).
    let undercuts;
    try {
        undercuts = await retainerWatch.takeChecked(userId => asked(userId) && kindDue('retainer', userId, now));
    } catch (err) {
        console.error('❌ [RETAINERS] Could not re-check undercuts:', err.message);
        undercuts = new Map();
    }
    for (const userId of undercuts.keys()) if (!batch.has(userId)) batch.set(userId, new Map());
    // Item alerts (their own timing)
    const itemBatch = new Map();
    for (const [userId, items] of Array.from(pendingItems)) {
        if (!(asked(userId) && kindDue('item', userId, now))) continue;
        itemBatch.set(userId, items);
        pendingItems.delete(userId);
        if (!batch.has(userId)) batch.set(userId, new Map());
    }

    try {
        for (const [userId, items] of batch) {
            // Biggest discount first
            let entries = Array.from(items.values()).sort((a, b) => bestPercent(a) - bestPercent(b));
            const userUndercuts0 = undercuts.get(userId);
            const hasUndercuts0 = Boolean(userUndercuts0 && userUndercuts0.size);
            const itemEntries0 = itemBatch.has(userId) ? Array.from(itemBatch.get(userId).values()) : [];
            let undercutsPosted = false;

            // Server channels: each kind goes to its own channels; also to the DM below only when that kind's DM switch is on.
            const targets = alertTargets.get(userId);
            if (targets && targets.length && entries.length) {
                const channelEntries = entries;
                const embedsFor = async lang => {
                    const itemEmbeds = [];
                    for (const entry of channelEntries) itemEmbeds.push(buildItemEmbed(entry, await getItemName(entry.itemId, lang), lang));
                    return itemEmbeds;
                };
                await postToChannels(client, userId, targets, embedsFor);
                lastSentAt.set(userId, now);
            }
            const retTargets = kinds.retainer.targets.get(userId);
            if (retTargets && retTargets.length && hasUndercuts0) {
                const embedsFor = async lang => {
                    const names = new Map();
                    for (const u of userUndercuts0.values()) if (!names.has(u.itemId)) names.set(u.itemId, await getItemName(u.itemId, lang));
                    return [retainerWatch.buildUndercutEmbed(userUndercuts0, names, lang)];
                };
                if (await postToChannels(client, userId, retTargets, embedsFor, 'alerts.footerShort')) undercutsPosted = true;
                kinds.retainer.lastSent.set(userId, now);
            }
            const itemTargets = kinds.item.targets.get(userId);
            if (itemTargets && itemTargets.length && itemEntries0.length) {
                const embedsFor = async lang => {
                    const list = [];
                    for (const entry of itemEntries0) list.push(buildItemAlertEmbed(entry, await getItemName(entry.itemId, lang), lang));
                    return list;
                };
                await postToChannels(client, userId, itemTargets, embedsFor, 'alerts.footerShort');
                kinds.item.lastSent.set(userId, now);
            }
            if (dmOff.has(userId)) entries = []; // DM switch off: market alerts only in the channels
            const userUndercuts = hasUndercuts0 && !kinds.retainer.dmOff.has(userId) ? userUndercuts0 : null;
            const itemEntries = kinds.item.dmOff.has(userId) ? [] : itemEntries0;
            // Undercuts that reach no one (DM off, no channel post): forget them, so they alert again later
            if (hasUndercuts0 && !userUndercuts && !undercutsPosted) await retainerWatch.forgetAlerts(userUndercuts0);
            const hasUndercuts = Boolean(userUndercuts);
            if (!entries.length && !hasUndercuts && !itemEntries.length) continue;

            const lang = await userLanguage.forUser(userId); // DM: the user's language
            const embeds = [];
            if (hasUndercuts) {
                const names = new Map();
                for (const u of userUndercuts.values()) if (!names.has(u.itemId)) names.set(u.itemId, await getItemName(u.itemId, lang));
                embeds.push(retainerWatch.buildUndercutEmbed(userUndercuts, names, lang));
            }
            for (const entry of entries) {
                embeds.push(buildItemEmbed(entry, await getItemName(entry.itemId, lang), lang));
            }
            for (const entry of itemEntries) {
                embeds.push(buildItemAlertEmbed(entry, await getItemName(entry.itemId, lang), lang));
            }

            // Split into messages: max 10 items each, and under Discord's character limit
            const messages = chunkEmbeds(embeds);

            const forgetUndercuts = async () => { if (hasUndercuts && !undercutsPosted) await retainerWatch.forgetAlerts(userUndercuts); };
            if (dmStatus.isBlocked(userId)) {
                await forgetUndercuts();
                continue;
            }
            let user;
            try {
                user = await client.users.fetch(userId);
            } catch (err) {
                console.error('❌ [DM FAILED] Could not find user ' + userId + ': ' + err.message);
                if (err && err.code === 10013) await dmStatus.markFailed(userId, 'unknown_user');
                await forgetUndercuts();
                continue;
            }

            for (const group of messages) {
                group[group.length - 1].setFooter({ text: entries.length ? t(lang, 'alerts.footer') : t(lang, 'alerts.footerShort') }).setTimestamp();
                try {
                    await user.send({ embeds: group });
                    if (entries.length) lastSentAt.set(userId, now);
                    if (hasUndercuts) kinds.retainer.lastSent.set(userId, now);
                    if (itemEntries.length) kinds.item.lastSent.set(userId, now);
                    console.log('✅ [DM SENT] Alert message (' + group.length + ' embed(s)) sent to user ' + userId);
                    await dmStatus.markOk(userId);
                } catch (err) {
                    console.error('❌ [DM FAILED] Could not send DM to user ' + userId + '. Reason: ' + err.message + ' (Check direct message privacy settings)');
                    // 50007 = DMs closed or no server shared with Pingway: pause this user's alerts for a while
                    if (err && err.code === 50007) await dmStatus.markFailed(userId, 'dm_closed');
                    await forgetUndercuts(); // alert again later
                    break;
                }
            }
        }
    } finally {
        flushing = false;
        quickFlushRunning = false;
        if (timerFlushWaiting) {
            timerFlushWaiting = false;
            setImmediate(() => flushAlerts(client).catch(err => console.error('❌ [DM ERROR] Failed to send collected alerts:', err.message)));
        }
        // Immediate users whose alerts came in during this flush: send them now
        if (immediateQueue.size) scheduleImmediateFlush(client);
    }
}

// Separate alert settings / Item alerts tables + the one-time copy of the old settings (alertSplitDdl.js).
// Tried again at the next refresh if the database was not reachable.
async function ensureSplit() {
    if (splitReady) return;
    try {
        const copied = await ensureAlertSplit(pool, Date.now());
        if (copied) console.log('🔀 [MARKET] Alert settings split: copied ' + copied.dcs + ' market alert Data Center list(s) and ' + copied.retainers + ' retainer alert setting(s).');
        splitReady = true;
    } catch (err) {
        console.error('❌ [MARKET] Could not prepare the alert settings tables:', err.message);
    }
}

async function refresh(client) {
    try {
        await dmStatus.load();
        await ensureSplit();
        await loadKindSettings('retainer');
        await loadKindSettings('item');
        const { list, enabledCount } = await loadSubscribers();
        subscribers = list;
        await loadIntervals();
        await loadMinMedians();
        // Retainers of users whose undercut alerts can't go anywhere (DM off or DMs blocked, and no channel) are not watched
        await retainerWatch.load({ canSend: userId => kindCanSend('retainer', userId) });
        await itemAlerts.load({ dcWorlds: DC_WORLD_MAP, dcRegion: DC_REGION, worldNames: WORLD_NAMES });

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
        for (const k of KIND_KEYS) {
            for (const [id, t] of kinds[k].lastSent) if (now - t > 60 * 60 * 1000) kinds[k].lastSent.delete(id);
        }

        if (subscribers.length === 0 && !retainerWatch.hasWatches() && !itemAlerts.hasAlerts()) {
            if (ws || reconnectTimer) {
                console.log('ℹ️ [MARKET] No subscribers with saved Data Centers, watched retainers or Item alerts. Closing feed and standing by...');
                cleanupSocket();
            }
            return { enabledCount, ready: 0 };
        }

        if (!ws) {
            if (!reconnectTimer) connect(client);
        } else {
            syncSubscriptions();
        }
        return { enabledCount, ready: subscribers.length, retainers: retainerWatch.getWorlds().size, items: itemAlerts.getWorlds().size };
    } catch (err) {
        console.error('❌ [MARKET] Failed to refresh subscribers:', err.message);
        return null;
    }
}

async function initMarketMonitor(client) {
    if (started) return;
    started = true;

    watchRetainerUndercuts(client);
    console.log('🔍 [INIT] Loading market alert subscribers...');
    await loadWorldData();
    const result = await refresh(client);
    if (result) {
        if (result.retainers) console.log('🏷️ [INIT] Retainer Watch active on ' + result.retainers + ' world(s).');
        if (result.items) console.log('🔔 [INIT] Item alerts active on ' + result.items + ' world(s).');
        if (result.ready === 0) {
            console.log('⚠️ [INIT] ' + result.enabledCount + ' user(s) have market alerts on, but none have market alert Data Centers saved. Monitor standing by...');
        } else {
            const skipped = result.enabledCount - result.ready;
            console.log('✅ [INIT] ' + result.ready + ' subscriber(s) with saved Data Centers.' + (skipped > 0 ? ' (' + skipped + ' skipped: no market alert Data Centers saved)' : ''));
        }
    }
    refreshTimer = setInterval(() => refresh(client), SUBSCRIBER_REFRESH_MS);
    flushTimer = setInterval(() => {
        flushAlerts(client).catch(err => console.error('❌ [DM ERROR] Failed to send collected alerts:', err.message));
    }, FLUSH_INTERVAL_MS);
}

module.exports = { initMarketMonitor, CHANNEL_LIMITS,
    _test: { loadTargets, postToChannels, targets: () => alertTargets, dmOff: () => dmOff,
        loadMinMedians, notifySubscribedUsers, minMedians: () => minMedians, pending: () => pendingAlerts, cooldowns: () => alertCooldowns,
        setSubscribers: list => { subscribers = list; },
        loadIntervals, isDue, intervals: () => alertIntervals, flushAlerts, requestImmediateFlush, watchRetainerUndercuts, lastSentAt: () => lastSentAt,
        isFlushing: () => flushing,
        // separate retainer / item alert settings, market alert Data Centers, Item alerts
        loadKindSettings, kinds: () => kinds, kindDue, kindCanSend, loadSubscribers, ensureSplit, resetSplit: () => { splitReady = false; },
        notifyItemMatch, pendingItems: () => pendingItems, handleItemAlerts, buildItemAlertEmbed, refresh,
        // "already bought" check
        BOUGHT_CHECK_MS, held: () => held, holdForBoughtCheck, boughtOnRemove, boughtOnSale, finishHold, handleListingsAdd,
        setClock: (nowFn, scheduleFn) => { clock = nowFn || (() => Date.now()); schedule = scheduleFn || ((fn, ms) => setTimeout(fn, ms)); recheckShared.clear(); },
        syncSubscriptions, subscriptions: () => ({ add: subscribedWorlds, remove: subscribedRemoveWorlds, sales: subscribedSalesWorlds }),
        setGeo: (dcWorlds, dcRegion, names) => { DC_WORLD_MAP = dcWorlds; DC_REGION = dcRegion; Object.assign(WORLD_NAMES, names || {}); rebuildWorldIndex(); },
        baselineCache: () => baselineCache } };
