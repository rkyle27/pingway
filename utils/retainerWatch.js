// Retainer Watch: DMs a user when someone undercuts one of their retainers' market listings.
// Retainers are set up on the Pingway website (table retainer_watch). The bot only reads them.
// Undercuts are sent in the same 5-minute DM as market alerts (see marketMonitor.js flushAlerts).

const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { pool } = require('./db');
const dmStatus = require('./dmStatus');

const UNIVERSALIS_API = 'https://universalis.app/api/v2';
const UNDERCUT_COOLDOWN_MS = 60 * 60 * 1000;      // Same item/quality/retainer alerts at most once per hour
const STALE_ITEM_MS = 30 * 24 * 60 * 60 * 1000;   // Forget items not seen for 30 days
const LOOKUP_GAP_MS = 250;                         // Space Universalis REST checks (4 per second max)
const MAX_PENDING_CHECKS = 30;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;          // Re-check every tracked item every 30 minutes

let watchesByWorld = new Map();   // worldId -> Map(retainerNameLower -> { watchId, userId, retainerName, worldName })
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
            map.get(worldId).set(String(r.retainer_name).toLowerCase(), {
                watchId: Number(r.id), userId: String(r.user_id), retainerName: r.retainer_name, worldName: r.world_name
            });
        }
        watchesByWorld = map;
        tablesMissing = false;
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

        const now = Date.now();
        for (const [k, t] of cooldowns) if (now - t > UNDERCUT_COOLDOWN_MS) cooldowns.delete(k);
        await pool.execute('DELETE FROM retainer_items WHERE last_seen < ?', [now - STALE_ITEM_MS]);
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
const nameOf = l => String(l.retainerName || '').toLowerCase();

// Lowest own price and lowest competitor price for one quality.
// Competitors exclude mannequins and any retainer this same user watches on that world.
function compare(listings, watch, worldWatches, hq) {
    let mine = null;
    let theirs = null;
    for (const l of listings) {
        if (!validPrice(l) || Boolean(l.hq) !== hq || l.onMannequin) continue;
        const n = nameOf(l);
        if (n === watch.retainerName.toLowerCase()) {
            if (mine === null || l.pricePerUnit < mine) mine = l.pricePerUnit;
            continue;
        }
        const other = worldWatches.get(n);
        if (other && other.userId === watch.userId) continue; // the user's own other retainer
        if (theirs === null || l.pricePerUnit < theirs) theirs = l.pricePerUnit;
    }
    return { mine, theirs };
}

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
    const now = Date.now();
    const { mine, theirs } = compare(listings, watch, worldWatches, hq);

    if (mine === null) { // sold or pulled
        await pool.execute('DELETE FROM retainer_items WHERE watch_id = ? AND item_id = ? AND hq = ?', [watch.watchId, itemId, hq ? 1 : 0]);
        return;
    }
    await saveItem(watch.watchId, itemId, hq, mine, now);
    await pool.execute('UPDATE retainer_watch SET last_seen_at = ? WHERE id = ?', [now, watch.watchId]);

    if (theirs === null || theirs >= mine) {
        // Not undercut (or the user repriced): allow a new alert next time
        await pool.execute('UPDATE retainer_items SET last_alert_price = NULL WHERE watch_id = ? AND item_id = ? AND hq = ?', [watch.watchId, itemId, hq ? 1 : 0]);
        return;
    }

    const [[row]] = await pool.execute('SELECT last_alert_price FROM retainer_items WHERE watch_id = ? AND item_id = ? AND hq = ?', [watch.watchId, itemId, hq ? 1 : 0]);
    if (row && row.last_alert_price !== null && Number(row.last_alert_price) <= theirs) return; // already told about this price
    const key = watch.watchId + ':' + itemId + ':' + (hq ? 1 : 0);
    const last = cooldowns.get(key);
    if (last && now - last < UNDERCUT_COOLDOWN_MS) return;
    cooldowns.set(key, now);
    await pool.execute('UPDATE retainer_items SET last_alert_price = ? WHERE watch_id = ? AND item_id = ? AND hq = ?', [Math.round(theirs), watch.watchId, itemId, hq ? 1 : 0]);

    if (!pending.has(watch.userId)) pending.set(watch.userId, new Map());
    pending.get(watch.userId).set(key, {
        itemId, hq, worldId, worldName: watch.worldName, retainerName: watch.retainerName, mine, theirs
    });
    console.log('🏷️ [UNDERCUT] ' + watch.retainerName + ' (' + watch.worldName + ') item #' + itemId + (hq ? ' HQ' : '') + ': ' + mine + ' -> ' + theirs + ' Gil.');
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
    const now = Date.now();

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
        await saveItem(o.watch.watchId, itemId, o.hq, o.price, now);
        await pool.execute('UPDATE retainer_watch SET last_seen_at = ? WHERE id = ?', [now, o.watch.watchId]);
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
function takePending(isDue) {
    const batch = new Map();
    for (const [userId, items] of Array.from(pending)) {
        if (isDue && !isDue(userId)) continue;
        batch.set(userId, items);
        pending.delete(userId);
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
function buildUndercutEmbed(items, names) {
    const rows = Array.from(items.values()).sort((a, b) => (a.theirs / a.mine) - (b.theirs / b.mine));
    const fence = String.fromCharCode(96).repeat(3);
    const cells = rows.map(r => [
        ((names.get(r.itemId) || ('Item #' + r.itemId)) + (r.hq ? ' HQ' : '')).slice(0, 34),
        r.retainerName + ' (' + r.worldName + ')',
        r.mine.toLocaleString('en-US'),
        r.theirs.toLocaleString('en-US')
    ]);
    const headers = ['Item', 'Retainer', 'Yours', 'Lowest'];
    const w = headers.map((h, i) => Math.max(h.length, ...cells.map(c => c[i].length)));
    const lines = [
        headers.map((h, i) => pad(h, w[i], i >= 2)).join('  '),
        '-'.repeat(w.reduce((a, b) => a + b, 0) + 6)
    ];
    let length = lines.join('\n').length;
    let shown = 0;
    for (const c of cells) {
        const line = c.map((v, i) => pad(v, w[i], i >= 2)).join('  ');
        if (length + line.length + 60 > 3900) break;
        lines.push(line);
        length += line.length + 1;
        shown++;
    }
    if (shown < cells.length) lines.push('...and ' + (cells.length - shown) + ' more');
    return new EmbedBuilder()
        .setTitle('🏷️ Your retainers were undercut (' + rows.length + ')')
        .setColor('#f39c12')
        .setDescription(fence + '\n' + lines.join('\n') + '\n' + fence + '\nPrices are per unit in Gil. Manage retainers on the Pingway website.');
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
        const loaded = Boolean(worldWatches && worldWatches.get(String(r.retainer_name).toLowerCase()));
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
                    const watch = { watchId: Number(r.id), userId: String(r.user_id), retainerName: r.retainer_name };
                    const { mine, theirs } = compare(listings, watch, worldWatches || new Map(), hq);
                    live = ' | now: yours ' + gil(mine) + ', lowest other ' + gil(theirs) +
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

module.exports = { forgetAlerts, describeUser, load, getWorlds, hasWatches, hasPending, pendingUsers, onListingsAdd, onListingsRemove, takePending, buildUndercutEmbed, _compare: compare };
