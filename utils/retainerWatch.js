// Retainer Watch: DMs a user when someone undercuts one of their retainers' market listings.
// Retainers are set up on the Pingway website (table retainer_watch). The bot only reads them.
// Undercuts are sent in the same 5-minute DM as market alerts (see marketMonitor.js flushAlerts).

const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { pool } = require('./db');
const dmStatus = require('./dmStatus');
const { t, localeOf } = require('./i18n');

const UNIVERSALIS_API = 'https://universalis.app/api/v2';
const UNDERCUT_COOLDOWN_MS = 60 * 60 * 1000;      // Same item/quality/retainer alerts at most once per hour
const STALE_ITEM_MS = 30 * 24 * 60 * 60 * 1000;   // Forget items not seen for 30 days
const LOOKUP_GAP_MS = 250;                         // Space Universalis REST checks (4 per second max)
const MAX_PENDING_CHECKS = 30;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;          // Re-check every tracked item every 30 minutes
const REPRICE_GRACE_MS = 5 * 60 * 1000;            // After the user's own listings change, hold undercut alerts 5 minutes (repricing)

let now = () => Date.now();       // clock (tests replace it through _test.setNow)

// Retainer names compared the same way everywhere: lowercase, trimmed, one kind of apostrophe, no spaces.
// The stored names are kept as they are for display.
function normName(name) {
    return String(name || '').toLowerCase().trim().replace(/[’‘ʼ`´]/g, "'").replace(/\s+/g, '');
}

let watchesByWorld = new Map();   // worldId -> Map(normName -> { watchId, userId, retainerName, worldName, worldId })
let ownByWorld = new Map();       // worldId -> Map(normName -> Set(userId)): every retainer each user set up (any status), never a competitor
const lastOwnChange = new Map();  // 'userId:worldId' -> time the user's own listings last changed
let tablesMissing = false;
const cooldowns = new Map();      // 'watchId:itemId:hq' -> time
const pending = new Map();        // userId -> Map('watchId:itemId:hq' -> undercut)
let nextCheckAt = 0;
let pendingChecks = 0;
let lastSummary = '';
let knownWatchIds = new Set();   // watches already given their first check
let sweepTimer = null;
let checking = false;
const checkQueue = [];           // [{ watchId, worldId }] waiting for a full check

async function load() {
    try {
        const [rows] = await pool.execute(
            "SELECT id, user_id, world_id, world_name, retainer_name FROM retainer_watch WHERE status = 'found' AND active = 1"
        );
        const map = new Map();
        for (const r of rows) {
            if (dmStatus.isBlocked(r.user_id)) continue; // can't DM them right now: don't watch for nothing
            const worldId = Number(r.world_id);
            if (!map.has(worldId)) map.set(worldId, new Map());
            map.get(worldId).set(normName(r.retainer_name), {
                watchId: Number(r.id), userId: String(r.user_id), retainerName: r.retainer_name, worldName: r.world_name, worldId
            });
        }
        watchesByWorld = map;
        tablesMissing = false;
        // All retainers each user set up (found or not, on or off): their listings are never "someone else's"
        try {
            const [allRows] = await pool.execute('SELECT user_id, world_id, retainer_name FROM retainer_watch');
            const own = new Map();
            for (const r of allRows) {
                if (r.world_id === null || r.world_id === undefined || !r.retainer_name) continue;
                const worldId = Number(r.world_id);
                const n = normName(r.retainer_name);
                if (!own.has(worldId)) own.set(worldId, new Map());
                if (!own.get(worldId).has(n)) own.get(worldId).set(n, new Set());
                own.get(worldId).get(n).add(String(r.user_id));
            }
            ownByWorld = own;
        } catch (err) {
            console.error('❌ [RETAINERS] Could not load all retainer names:', err.message);
        }
        // New (or, after a restart, all) watches: check their items once, so undercuts that already exist are found
        const currentIds = new Set();
        for (const [worldId, list] of map) {
            for (const w of list.values()) {
                currentIds.add(w.watchId);
                if (!knownWatchIds.has(w.watchId)) checkQueue.push({ watchId: w.watchId, worldId });
            }
        }
        knownWatchIds = currentIds;
        if (!sweepTimer) sweepTimer = setInterval(queueAllWatches, SWEEP_INTERVAL_MS);
        runCheckQueue().catch(err => console.error('❌ [RETAINERS] Check failed:', err.message));

        // Log only when the watch list changes
        let watchCount = 0;
        for (const list of map.values()) watchCount += list.size;
        const summary = watchCount + ' retainer(s) on ' + map.size + ' world(s)';
        if (summary !== lastSummary) {
            console.log('🏷️ [RETAINERS] Retainer Watch: watching ' + summary + '.');
            lastSummary = summary;
        }

        const time = now();
        for (const [k, t] of cooldowns) if (time - t > UNDERCUT_COOLDOWN_MS) cooldowns.delete(k);
        for (const [k, t] of lastOwnChange) if (time - t > REPRICE_GRACE_MS) lastOwnChange.delete(k);
        await pool.execute('DELETE FROM retainer_items WHERE last_seen < ?', [time - STALE_ITEM_MS]);
    } catch (err) {
        if (err && err.code === 'ER_NO_SUCH_TABLE') {
            if (!tablesMissing) console.log('ℹ️ [RETAINERS] Retainer Watch tables not created yet (they appear after the first website visit).');
            tablesMissing = true;
            watchesByWorld = new Map();
        } else {
            console.error('❌ [RETAINERS] Could not load watched retainers:', err.message);
        }
    }
}

function getWorlds() { return new Set(watchesByWorld.keys()); }
function hasWatches() { return watchesByWorld.size > 0; }
function hasPending() { return pending.size > 0; }

async function waitForSlot() {
    const wait = Math.max(0, nextCheckAt - Date.now());
    nextCheckAt = Math.max(Date.now(), nextCheckAt) + LOOKUP_GAP_MS;
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
}

// Current listings for one item on one world (fresh from Universalis)
async function fetchListings(worldId, itemId) {
    if (pendingChecks >= MAX_PENDING_CHECKS) return null;
    pendingChecks++;
    try {
        await waitForSlot();
        const res = await axios.get(UNIVERSALIS_API + '/' + worldId + '/' + itemId, { params: { listings: 100, entries: 0 }, timeout: 8000 });
        return res.data && Array.isArray(res.data.listings) ? res.data.listings : null;
    } catch (err) {
        return null;
    } finally {
        pendingChecks--;
    }
}

const validPrice = l => typeof l.pricePerUnit === 'number' && l.pricePerUnit > 0;
const nameOf = l => normName(l.retainerName);

// Normalized names of every retainer this user has on the watch's world (watched now, or set up on the website)
function ownNamesOf(watch, worldWatches) {
    const names = new Set();
    if (worldWatches) for (const w of worldWatches.values()) if (w.userId === watch.userId) names.add(normName(w.retainerName));
    const byName = ownByWorld.get(Number(watch.worldId));
    if (byName) for (const [n, users] of byName) if (users.has(String(watch.userId))) names.add(n);
    return names;
}

// Users who own a retainer with this normalized name on this world
function ownersOf(worldId, n, worldWatches) {
    const users = new Set();
    const w = worldWatches && worldWatches.get(n);
    if (w) users.add(w.userId);
    const byName = ownByWorld.get(Number(worldId));
    if (byName && byName.has(n)) for (const u of byName.get(n)) users.add(u);
    return users;
}

// Repricing grace: the user's own listings on this world changed just now
function markOwnChange(userId, worldId) { lastOwnChange.set(String(userId) + ':' + Number(worldId), now()); }
function graceLeft(userId, worldId) {
    const last = lastOwnChange.get(String(userId) + ':' + Number(worldId));
    return last === undefined ? 0 : Math.max(0, last + REPRICE_GRACE_MS - now());
}

// Lowest own price and lowest competitor price for one quality, plus who the cheapest competitor is.
// Competitors exclude mannequins and any retainer this same user has on that world.
// ownLowest = cheapest listing of any of the user's own retainers (this one included).
function compare(listings, watch, worldWatches, hq) {
    const self = normName(watch.retainerName);
    const own = ownNamesOf(watch, worldWatches);
    let mine = null;
    let theirs = null;
    let theirsName = null;
    let ownLowest = null;
    for (const l of listings) {
        if (!validPrice(l) || Boolean(l.hq) !== hq || l.onMannequin) continue;
        const n = nameOf(l);
        if (n === self) {
            if (mine === null || l.pricePerUnit < mine) mine = l.pricePerUnit;
            if (ownLowest === null || l.pricePerUnit < ownLowest) ownLowest = l.pricePerUnit;
            continue;
        }
        if (own.has(n)) { // the user's own other retainer
            if (ownLowest === null || l.pricePerUnit < ownLowest) ownLowest = l.pricePerUnit;
            continue;
        }
        if (theirs === null || l.pricePerUnit < theirs) {
            theirs = l.pricePerUnit;
            theirsName = String(l.retainerName || '').trim() || null;
        }
    }
    return { mine, theirs, theirsName, ownLowest };
}

// Undercut = listed, someone else is cheaper, and the cheapest listing is not one of the user's own
const isUndercut = c => c.mine !== null && c.theirs !== null && c.theirs < c.mine && !(c.ownLowest !== null && c.ownLowest <= c.theirs);

async function saveItem(watchId, itemId, hq, price, now) {
    await pool.execute(
        `INSERT INTO retainer_items (watch_id, item_id, hq, price, last_seen) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE price = VALUES(price), last_seen = VALUES(last_seen)`,
        [watchId, itemId, hq ? 1 : 0, Math.round(price), now]
    );
}

// Check one watched item against fresh listings and queue an alert if it was undercut
async function checkItem(watch, worldId, itemId, hq, worldWatches) {
    const listings = await fetchListings(worldId, itemId);
    if (!listings) return;
    const time = now();
    const c = compare(listings, watch, worldWatches, hq);
    const { mine, theirs, theirsName } = c;
    const key = watch.watchId + ':' + itemId + ':' + (hq ? 1 : 0);

    if (mine === null) { // sold or pulled
        await pool.execute('DELETE FROM retainer_items WHERE watch_id = ? AND item_id = ? AND hq = ?', [watch.watchId, itemId, hq ? 1 : 0]);
        return;
    }
    const [[row]] = await pool.execute('SELECT price, last_alert_price FROM retainer_items WHERE watch_id = ? AND item_id = ? AND hq = ?', [watch.watchId, itemId, hq ? 1 : 0]);
    if (row && row.price !== null && row.price !== undefined && Number(row.price) !== Math.round(mine)) markOwnChange(watch.userId, worldId); // the user repriced
    await saveItem(watch.watchId, itemId, hq, mine, time);
    await pool.execute('UPDATE retainer_watch SET last_seen_at = ? WHERE id = ?', [time, watch.watchId]);

    if (!isUndercut(c)) {
        // Not undercut (or the user repriced): allow a new alert next time, and drop a waiting one
        await pool.execute('UPDATE retainer_items SET last_alert_price = NULL WHERE watch_id = ? AND item_id = ? AND hq = ?', [watch.watchId, itemId, hq ? 1 : 0]);
        const waiting = pending.get(watch.userId);
        if (waiting && waiting.delete(key)) {
            cooldowns.delete(key);
            if (waiting.size === 0) pending.delete(watch.userId);
            console.log('🧹 [UNDERCUT] Dropped ' + watch.retainerName + ' (' + watch.worldName + ') item #' + itemId + (hq ? ' HQ' : '') + ': no longer undercut.');
        }
        return;
    }

    if (row && row.last_alert_price !== null && row.last_alert_price !== undefined && Number(row.last_alert_price) <= theirs) return; // already told about this price
    const last = cooldowns.get(key);
    if (last && time - last < UNDERCUT_COOLDOWN_MS) return;
    cooldowns.set(key, time);
    await pool.execute('UPDATE retainer_items SET last_alert_price = ? WHERE watch_id = ? AND item_id = ? AND hq = ?', [Math.round(theirs), watch.watchId, itemId, hq ? 1 : 0]);

    if (!pending.has(watch.userId)) pending.set(watch.userId, new Map());
    pending.get(watch.userId).set(key, {
        itemId, hq, worldId, worldName: watch.worldName, retainerName: watch.retainerName, mine, theirs, theirsName,
        watchId: watch.watchId, userId: watch.userId
    });
    console.log('🏷️ [UNDERCUT] ' + watch.retainerName + ' (' + watch.worldName + ') item #' + itemId + (hq ? ' HQ' : '') + ': ' + mine + ' -> ' + theirs + ' Gil' + (theirsName ? ' by ' + theirsName : '') + '.');
}

// Every 30 minutes: queue every active watch for a full check
function queueAllWatches() {
    for (const [worldId, list] of watchesByWorld) {
        for (const w of list.values()) checkQueue.push({ watchId: w.watchId, worldId });
    }
    runCheckQueue().catch(err => console.error('❌ [RETAINERS] Check failed:', err.message));
}

// Checks queued watches one item at a time (spaced by waitForSlot), never two runs at once
async function runCheckQueue() {
    if (checking) return;
    checking = true;
    let items = 0;
    let undercuts = 0;
    try {
        const seen = new Set();
        while (checkQueue.length) {
            const { watchId, worldId } = checkQueue.shift();
            if (seen.has(watchId)) continue;
            seen.add(watchId);
            const worldWatches = watchesByWorld.get(worldId);
            const watch = worldWatches && Array.from(worldWatches.values()).find(w => w.watchId === watchId);
            if (!watch) continue; // removed or paused meanwhile
            const [rows] = await pool.execute('SELECT item_id, hq FROM retainer_items WHERE watch_id = ?', [watchId]);
            for (const row of rows) {
                const before = pending.has(watch.userId) ? pending.get(watch.userId).size : 0;
                await checkItem(watch, worldId, Number(row.item_id), Number(row.hq) === 1, worldWatches);
                const after = pending.has(watch.userId) ? pending.get(watch.userId).size : 0;
                if (after > before) undercuts++;
                items++;
            }
        }
    } finally {
        checking = false;
    }
    if (items) console.log('🔁 [RETAINERS] Checked ' + items + ' tracked item(s)' + (undercuts ? ', found ' + undercuts + ' undercut(s).' : ', no new undercuts.'));
}

// listings/add on a watched world
async function onListingsAdd(message) {
    if (tablesMissing || !message || message.event !== 'listings/add') return;
    const worldId = Number(message.world);
    const itemId = Number(message.item);
    const worldWatches = watchesByWorld.get(worldId);
    if (!worldWatches || !itemId) return;
    const listings = Array.isArray(message.listings) ? message.listings : [];
    if (listings.length === 0) return;
    const time = now();

    // 0) A new listing from one of a user's own retainers = they are (re)pricing: start the grace
    for (const userId of new Set(listings.filter(validPrice).flatMap(l => Array.from(ownersOf(worldId, nameOf(l), worldWatches))))) {
        markOwnChange(userId, worldId);
    }

    // 1) The user's own new listings: start tracking them
    const ownSeen = new Map(); // watchId:hq -> { watch, hq, price }
    for (const l of listings) {
        if (!validPrice(l) || l.onMannequin) continue;
        const watch = worldWatches.get(nameOf(l));
        if (!watch) continue;
        const k = watch.watchId + ':' + (l.hq ? 1 : 0);
        const cur = ownSeen.get(k);
        if (!cur || l.pricePerUnit < cur.price) ownSeen.set(k, { watch, hq: Boolean(l.hq), price: l.pricePerUnit });
    }
    for (const o of ownSeen.values()) {
        await saveItem(o.watch.watchId, itemId, o.hq, o.price, time);
        await pool.execute('UPDATE retainer_watch SET last_seen_at = ? WHERE id = ?', [time, o.watch.watchId]);
    }

    // 2) Someone else's new listing: is it cheaper than a tracked item of a watched retainer?
    const watchIds = Array.from(new Set(Array.from(worldWatches.values()).map(w => w.watchId)));
    if (watchIds.length === 0) return;
    const [tracked] = await pool.execute(
        'SELECT watch_id, hq, price FROM retainer_items WHERE item_id = ? AND watch_id IN (' + watchIds.map(() => '?').join(',') + ')',
        [itemId, ...watchIds]
    );
    if (tracked.length === 0) return;
    const byId = new Map(Array.from(worldWatches.values()).map(w => [w.watchId, w]));
    for (const t of tracked) {
        const watch = byId.get(Number(t.watch_id));
        if (!watch) continue;
        const hq = Number(t.hq) === 1;
        const { theirs } = compare(listings, watch, worldWatches, hq);
        if (theirs !== null && theirs < Number(t.price)) {
            // Confirm with fresh data (also refreshes the user's own price)
            await checkItem(watch, worldId, itemId, hq, worldWatches);
        }
    }
}

// listings/remove on a watched world: the user's listing may have sold or been pulled
async function onListingsRemove(message) {
    if (tablesMissing || !message || message.event !== 'listings/remove') return;
    const worldId = Number(message.world);
    const itemId = Number(message.item);
    const worldWatches = watchesByWorld.get(worldId);
    if (!worldWatches || !itemId) return;
    const listings = Array.isArray(message.listings) ? message.listings : [];
    // A listing of a user's own retainer went away (sold, pulled or repriced): start the grace
    for (const userId of new Set(listings.flatMap(l => Array.from(ownersOf(worldId, nameOf(l), worldWatches))))) {
        markOwnChange(userId, worldId);
    }
    const done = new Set();
    for (const l of listings) {
        const watch = worldWatches.get(nameOf(l));
        if (!watch) continue;
        const k = watch.watchId + ':' + (l.hq ? 1 : 0);
        if (done.has(k)) continue;
        done.add(k);
        await checkItem(watch, worldId, itemId, Boolean(l.hq), worldWatches);
    }
}

// A DM with these undercuts could not be delivered: forget them, so they alert again once DMs work
async function forgetAlerts(items) {
    for (const [key, u] of items) {
        cooldowns.delete(key);
        const watchId = Number(String(key).split(':')[0]);
        try {
            await pool.execute('UPDATE retainer_items SET last_alert_price = NULL WHERE watch_id = ? AND item_id = ? AND hq = ?', [watchId, u.itemId, u.hq ? 1 : 0]);
        } catch (err) {
            console.error('❌ [RETAINERS] Could not reset alert:', err.message);
        }
    }
}

// Take the collected undercuts. With isDue, only take users whose DM interval has passed (the rest wait).
// Undercuts on a world where the user is repricing (grace) stay pending until the grace is over.
function takePending(isDue) {
    const batch = new Map();
    for (const [userId, items] of Array.from(pending)) {
        if (isDue && !isDue(userId)) continue;
        const ready = new Map();
        for (const [key, u] of Array.from(items)) {
            const left = graceLeft(userId, u.worldId);
            if (left > 0) {
                if (!u.held) {
                    u.held = true;
                    console.log('⏸️ [UNDERCUT] Holding ' + u.retainerName + ' (' + u.worldName + ') item #' + u.itemId + (u.hq ? ' HQ' : '') + ': repricing, re-check in ' + Math.ceil(left / 60000) + ' min.');
                }
                continue;
            }
            ready.set(key, u);
            items.delete(key);
        }
        if (items.size === 0) pending.delete(userId);
        if (ready.size) batch.set(userId, ready);
    }
    return batch;
}

// Fresh Universalis check of one waiting undercut. Returns 'keep' (values updated), 'drop' (reason in u.dropReason) or 'failed'.
async function recheck(u) {
    const listings = await fetchListings(u.worldId, u.itemId);
    if (!listings) return 'failed';
    const worldWatches = watchesByWorld.get(Number(u.worldId)) || new Map();
    const watch = { watchId: u.watchId, userId: u.userId, retainerName: u.retainerName, worldName: u.worldName, worldId: u.worldId };
    const c = compare(listings, watch, worldWatches, u.hq);
    let reason = null;
    if (c.mine === null) reason = 'your listing is gone';
    else if (c.theirs === null) reason = 'no cheaper listing';
    else if (c.mine <= c.theirs) reason = 'yours is lowest';
    else if (c.ownLowest !== null && c.ownLowest <= c.theirs) reason = 'cheapest listing is yours';
    if (c.mine !== null) {
        try { await saveItem(u.watchId, u.itemId, u.hq, c.mine, now()); } catch (err) { console.error('❌ [RETAINERS] Could not save price:', err.message); }
    }
    if (reason) { u.dropReason = reason; return 'drop'; }
    u.mine = c.mine;
    u.theirs = c.theirs;
    u.theirsName = c.theirsName;
    try {
        await pool.execute('UPDATE retainer_items SET last_alert_price = ? WHERE watch_id = ? AND item_id = ? AND hq = ?', [Math.round(c.theirs), u.watchId, u.itemId, u.hq ? 1 : 0]);
    } catch (err) {
        console.error('❌ [RETAINERS] Could not save alert price:', err.message);
    }
    return 'keep';
}

// Like takePending, but every undercut is checked again with fresh Universalis data first (spaced like all checks).
// False alerts (the user repriced, their listing is gone, or the cheapest is theirs) are dropped and forgotten,
// so they never block a later real alert. A failed check keeps the alert. Users with nothing left are not returned.
async function takeChecked(isDue) {
    const batch = takePending(isDue);
    for (const [userId, items] of Array.from(batch)) {
        const dropped = new Map();
        for (const [key, u] of Array.from(items)) {
            let result;
            try { result = await recheck(u); } catch (err) { result = 'failed'; }
            if (result === 'drop') {
                items.delete(key);
                dropped.set(key, u);
                console.log('🧹 [UNDERCUT] Dropped ' + u.retainerName + ' (' + u.worldName + ') item #' + u.itemId + (u.hq ? ' HQ' : '') + ': ' + u.dropReason + '.');
            } else if (graceLeft(userId, u.worldId) > 0) {
                // The user started repricing during the check: wait for the grace again
                items.delete(key);
                if (!pending.has(userId)) pending.set(userId, new Map());
                if (!pending.get(userId).has(key)) pending.get(userId).set(key, u);
            }
        }
        if (dropped.size) await forgetAlerts(dropped);
        if (items.size === 0) batch.delete(userId);
    }
    return batch;
}

function pendingUsers() { return Array.from(pending.keys()); }

function pad(text, width, left) {
    text = String(text);
    const space = ' '.repeat(Math.max(0, width - text.length));
    return left ? space + text : text + space;
}

// One embed listing all undercuts for a user. names: Map(itemId -> name)
function buildUndercutEmbed(items, names, lang = 'en') {
    const rows = Array.from(items.values()).sort((a, b) => (a.theirs / a.mine) - (b.theirs / b.mine));
    const fence = String.fromCharCode(96).repeat(3);
    const cells = rows.map(r => [
        ((names.get(r.itemId) || (t(lang, 'alerts.itemFallback', { id: r.itemId }))) + (r.hq ? ' HQ' : '')).slice(0, 34),
        r.retainerName + ' (' + r.worldName + ')',
        r.mine.toLocaleString(localeOf(lang)),
        r.theirs.toLocaleString(localeOf(lang))
    ]);
    const headers = [t(lang, 'alerts.undercut.item'), t(lang, 'alerts.undercut.retainer'), t(lang, 'alerts.undercut.yours'), t(lang, 'alerts.undercut.lowest')];
    const w = headers.map((h, i) => Math.max(h.length, ...cells.map(c => c[i].length)));
    const lines = [
        headers.map((h, i) => pad(h, w[i], i >= 2)).join('  '),
        '-'.repeat(w.reduce((a, b) => a + b, 0) + 6)
    ];
    let length = lines.join('\n').length;
    let shown = 0;
    for (let n = 0; n < cells.length; n++) {
        let line = cells[n].map((v, i) => pad(v, w[i], i >= 2)).join('  ');
        // Who is cheaper: on its own short line under the row (keeps rows narrow on phones)
        const by = rows[n].theirsName ? String(rows[n].theirsName).replace(/`/g, '') : '';
        if (by) line += '\n  ↳ ' + t(lang, 'alerts.undercut.by', { name: by });
        if (length + line.length + 60 > 3900) break;
        lines.push(line);
        length += line.length + 1;
        shown++;
    }
    if (shown < cells.length) lines.push(t(lang, 'alerts.undercut.more', { count: cells.length - shown }));
    return new EmbedBuilder()
        .setTitle(t(lang, 'alerts.undercut.title', { count: rows.length }))
        .setColor('#f39c12')
        .setDescription(fence + '\n' + lines.join('\n') + '\n' + fence + t(lang, 'alerts.undercut.note'));
}

// ---------- Console: "retainers <id>" ----------
const fmtTime = ts => ts ? new Date(Number(ts)).toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).slice(0, 16) + ' JST' : 'never';
const gil = n => n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US');

async function itemName(itemId) {
    try {
        const res = await axios.get('https://v2.xivapi.com/api/sheet/Item/' + itemId, { timeout: 5000 });
        return (res.data && res.data.fields && res.data.fields.Name) || ('Item #' + itemId);
    } catch (e) {
        return 'Item #' + itemId;
    }
}

// Prints what the bot watches for one user, with live prices from Universalis (read only, max 20 items)
async function describeUser(userId) {
    let rows;
    try {
        [rows] = await pool.execute('SELECT * FROM retainer_watch WHERE user_id = ? ORDER BY created_at, id', [userId]);
    } catch (err) {
        if (err && err.code === 'ER_NO_SUCH_TABLE') { console.log('[RETAINERS] Retainer Watch tables do not exist yet.'); return; }
        throw err;
    }
    console.log('\n🏷️ [RETAINERS] ' + userId);
    if (rows.length === 0) { console.log('  No retainers set up on the website.\n'); return; }
    let checked = 0;
    for (const r of rows) {
        const worldId = Number(r.world_id);
        const worldWatches = watchesByWorld.get(worldId);
        const loaded = Boolean(worldWatches && worldWatches.get(normName(r.retainer_name)));
        const sw = r.enabled === undefined || r.enabled === null ? (Number(r.active) === 1 ? 1 : 2) : Number(r.enabled);
        const state = sw === 0 ? 'OFF (switched off by user)' : sw === 2 ? 'PAUSED (needs more points)' : loaded ? 'Watching' : 'ON, loads within 5 minutes';
        console.log('  ' + r.retainer_name + ' (' + r.world_name + ') - ' + state + ' | check item: ' + r.check_item_name + ' | last seen: ' + fmtTime(r.last_seen_at));
        const [items] = await pool.execute('SELECT item_id, hq, price, last_seen, last_alert_price FROM retainer_items WHERE watch_id = ? ORDER BY last_seen DESC', [r.id]);
        if (items.length === 0) { console.log('    No items tracked yet (items are learned when Universalis shows this retainer\'s listings).'); continue; }
        for (const it of items) {
            const hq = Number(it.hq) === 1;
            let live = '';
            if (checked < 20) {
                checked++;
                const listings = await fetchListings(worldId, Number(it.item_id));
                if (listings) {
                    const watch = { watchId: Number(r.id), userId: String(r.user_id), retainerName: r.retainer_name, worldId };
                    const { mine, theirs, theirsName } = compare(listings, watch, worldWatches || new Map(), hq);
                    live = ' | now: yours ' + gil(mine) + ', lowest other ' + gil(theirs) + (theirsName ? ' by ' + theirsName : '') +
                        (mine === null ? ' (not listed anymore)' : theirs !== null && theirs < mine ? ' -> UNDERCUT' : ' -> OK');
                } else {
                    live = ' | now: could not check Universalis';
                }
            }
            console.log('    • ' + (await itemName(it.item_id)) + (hq ? ' HQ' : '') + ': tracked price ' + gil(it.price) + ' | seen ' + fmtTime(it.last_seen) +
                (it.last_alert_price !== null && it.last_alert_price !== undefined ? ' | last alert at ' + gil(it.last_alert_price) : '') + live);
        }
    }
    console.log('');
}

module.exports = {
    forgetAlerts, describeUser, load, getWorlds, hasWatches, hasPending, pendingUsers, onListingsAdd, onListingsRemove, takePending, takeChecked,
    buildUndercutEmbed, REPRICE_GRACE_MS, _compare: compare,
    // Tests only: clock and state reset
    _test: {
        normName,
        setNow(fn) { now = typeof fn === 'function' ? fn : () => Date.now(); },
        reset() {
            if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
            watchesByWorld = new Map(); ownByWorld = new Map(); tablesMissing = false;
            cooldowns.clear(); pending.clear(); lastOwnChange.clear(); knownWatchIds = new Set();
            checkQueue.length = 0; nextCheckAt = 0; lastSummary = '';
        },
        idle() { return !checking && checkQueue.length === 0; }
    }
};
