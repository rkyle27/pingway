// Tests for Retainer Watch (utils/retainerWatch.js): own retainers are never competitors, repricing grace,
// re-check before the DM, and who undercut. Plain node, no network and no database (fakes):
//   node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------------ module fakes
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}

// Fake Universalis: answers per 'worldId/itemId' from `market`, or throws when `failNext` is set
const market = new Map();
const http = { calls: [], fail: false };
const fakeAxios = {
    async get(url) {
        http.calls.push(url);
        if (http.fail) throw new Error('fake network error');
        const m = String(url).match(/\/api\/v2\/(\d+)\/(\d+)$/);
        if (!m) throw new Error('unexpected url ' + url);
        return { data: { listings: (market.get(m[1] + '/' + m[2]) || []).map(l => ({ ...l })) } };
    }
};
class FakeEmbed {
    constructor() { this.data = {}; }
    setTitle(v) { this.data.title = v; return this; }
    setColor(v) { this.data.color = v; return this; }
    setDescription(v) { this.data.description = v; return this; }
}
const shims = { axios: fakeAxios, 'discord.js': { EmbedBuilder: FakeEmbed } };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (shims[request]) return 'shim:' + request;
    return origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);

// Fake database (in memory): retainer_watch + retainer_items
const db = { watches: [], items: new Map() }; // items: 'watch:item:hq' -> row
const ik = (w, i, h) => Number(w) + ':' + Number(i) + ':' + Number(h);
const pool = {
    async execute(sql, a = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (/^SELECT id, user_id, world_id, world_name, retainer_name FROM retainer_watch WHERE status = 'found' AND active = 1$/.test(q)) {
            return [db.watches.filter(w => w.status === 'found' && w.active === 1).map(w => ({ ...w }))];
        }
        if (/^SELECT user_id, world_id, retainer_name FROM retainer_watch$/.test(q)) return [db.watches.map(w => ({ ...w }))];
        if (/^DELETE FROM retainer_items WHERE last_seen < \?$/.test(q)) {
            for (const [k, r] of db.items) if (r.last_seen < a[0]) db.items.delete(k);
            return [{}];
        }
        if (/^SELECT item_id, hq FROM retainer_items WHERE watch_id = \?$/.test(q)) {
            return [Array.from(db.items.values()).filter(r => r.watch_id === Number(a[0])).map(r => ({ item_id: r.item_id, hq: r.hq }))];
        }
        if (/^INSERT INTO retainer_items \(watch_id, item_id, hq, price, last_seen\)/.test(q)) {
            const k = ik(a[0], a[1], a[2]);
            const r = db.items.get(k);
            if (r) Object.assign(r, { price: a[3], last_seen: a[4] });
            else db.items.set(k, { watch_id: Number(a[0]), item_id: Number(a[1]), hq: Number(a[2]), price: a[3], last_seen: a[4], last_alert_price: null });
            return [{}];
        }
        if (/^UPDATE retainer_watch SET last_seen_at = \? WHERE id = \?$/.test(q)) return [{}];
        if (/^DELETE FROM retainer_items WHERE watch_id = \? AND item_id = \? AND hq = \?$/.test(q)) {
            db.items.delete(ik(a[0], a[1], a[2]));
            return [{}];
        }
        if (/^SELECT price, last_alert_price FROM retainer_items WHERE watch_id = \? AND item_id = \? AND hq = \?$/.test(q)) {
            const r = db.items.get(ik(a[0], a[1], a[2]));
            return [r ? [{ price: r.price, last_alert_price: r.last_alert_price }] : []];
        }
        if (/^UPDATE retainer_items SET last_alert_price = NULL WHERE watch_id = \? AND item_id = \? AND hq = \?$/.test(q)) {
            const r = db.items.get(ik(a[0], a[1], a[2]));
            if (r) r.last_alert_price = null;
            return [{}];
        }
        if (/^UPDATE retainer_items SET last_alert_price = \? WHERE watch_id = \? AND item_id = \? AND hq = \?$/.test(q)) {
            const r = db.items.get(ik(a[1], a[2], a[3]));
            if (r) r.last_alert_price = a[0];
            return [{}];
        }
        if (/^SELECT watch_id, hq, price FROM retainer_items WHERE item_id = \? AND watch_id IN \(/.test(q)) {
            const ids = a.slice(1).map(Number);
            return [Array.from(db.items.values()).filter(r => r.item_id === Number(a[0]) && ids.includes(r.watch_id)).map(r => ({ ...r }))];
        }
        throw new Error('fake db: unexpected query ' + q);
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });
inject(path.join(ROOT, 'utils', 'dmStatus.js'), { isBlocked: () => false, load: async () => {}, markFailed: async () => {}, markOk: async () => {} });

const RW = require(path.join(ROOT, 'utils', 'retainerWatch.js'));

// ------------------------------------------------------------------ helpers (fake users, names and worlds only)
const WORLD = 99;
const ITEM = 5000;
const USER = '100000000000000001';
const OTHER_USER = '100000000000000002';
const T0 = Date.parse('2027-01-01T00:00:00Z');
let clock = T0;
RW._test.setNow(() => clock);

const listing = (retainerName, pricePerUnit, extra = {}) => ({ retainerName, pricePerUnit, hq: false, quantity: 1, ...extra });
const logs = [];
const origLog = console.log;

async function setup({ price = 1999, watches } = {}) {
    RW._test.reset();
    market.clear();
    http.calls.length = 0;
    http.fail = false;
    clock = T0;
    logs.length = 0;
    db.watches = watches || [
        { id: 1, user_id: USER, world_id: WORLD, world_name: 'Testworld', retainer_name: "Mojo'rolvasch", status: 'found', active: 1 },
        { id: 2, user_id: USER, world_id: WORLD, world_name: 'Testworld', retainer_name: 'Second Seller', status: 'pending', active: 0 },
        { id: 3, user_id: OTHER_USER, world_id: WORLD, world_name: 'Testworld', retainer_name: 'Rival', status: 'found', active: 1 }
    ];
    db.items = new Map();
    console.log = (...args) => { logs.push(args.join(' ')); };
    await RW.load();
    // tracked item of the user's retainer (added after load so the first check does not run on it)
    if (price !== null) db.items.set(ik(1, ITEM, 0), { watch_id: 1, item_id: ITEM, hq: 0, price, last_seen: T0, last_alert_price: null });
}
test.afterEach(() => { console.log = origLog; RW._test.reset(); });

const addMsg = listings => ({ event: 'listings/add', world: WORLD, item: ITEM, listings });
const removeMsg = listings => ({ event: 'listings/remove', world: WORLD, item: ITEM, listings });

// ------------------------------------------------------------------ tests
test('(a) own retainer with other apostrophe / case / spaces is never a competitor', async () => {
    await setup();
    const n = RW._test.normName;
    assert.equal(n(' MOJO’ROLVASCH '), n("Mojo'rolvasch"));
    assert.equal(n('Mojo`rol vasch'), n("mojo'rolvasch"));
    const watch = { watchId: 1, userId: USER, retainerName: "Mojo'rolvasch", worldId: WORLD };
    const c = RW._compare([
        listing('MOJO’ROLVASCH', 1000),     // the user's own retainer, curly apostrophe + caps
        listing('second  seller', 900),     // the user's other retainer (not found / off on the website)
        listing('Someone Else', 1500)
    ], watch, new Map(), false);
    assert.equal(c.mine, 1000);
    assert.equal(c.theirs, 1500);
    assert.equal(c.theirsName, 'Someone Else');
    assert.equal(c.ownLowest, 900);
});

test('(b) user reprices: own lower listing in listings/add sends no alert', async () => {
    await setup();
    market.set(WORLD + '/' + ITEM, [listing('Mojo’rolvasch', 1000), listing('Rival', 1200)]);
    await RW.onListingsAdd(addMsg([listing('Mojo’rolvasch', 1000)]));
    assert.equal(RW.hasPending(), false);
    assert.equal(db.items.get(ik(1, ITEM, 0)).price, 1000, 'own new price stored');
    clock += RW.REPRICE_GRACE_MS + 1000;
    const batch = await RW.takeChecked(() => true);
    assert.equal(batch.size, 0);
});

test('(c) cheaper piece while repricing: held during grace, then dropped by the fresh re-check (no DM)', async () => {
    await setup();
    // Universalis still shows the old price (lag) and a cheaper listing from someone else
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1999), listing('Undercutter', 1500)]);
    // user pulls the old listing (repricing) -> grace starts
    await RW.onListingsRemove(removeMsg([listing("Mojo'rolvasch", 1999)]));
    await RW.onListingsAdd(addMsg([listing('Undercutter', 1500)]));
    assert.equal(RW.hasPending(), true, 'queued');
    assert.equal(db.items.get(ik(1, ITEM, 0)).last_alert_price, 1500);

    clock += 60 * 1000; // 1 minute later: still in grace
    let batch = await RW.takeChecked(() => true);
    assert.equal(batch.size, 0, 'held during grace');
    assert.equal(RW.hasPending(), true, 'still waiting');
    assert.ok(logs.some(l => /Holding/.test(l)), 'hold logged');

    // grace over; fresh data: the user's new price 1,000 is lowest
    clock += RW.REPRICE_GRACE_MS;
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1000), listing('Undercutter', 1500)]);
    batch = await RW.takeChecked(() => true);
    assert.equal(batch.size, 0, 'no DM');
    assert.equal(RW.hasPending(), false);
    assert.ok(logs.some(l => /Dropped/.test(l)), 'drop logged');
    assert.equal(db.items.get(ik(1, ITEM, 0)).price, 1000, 'fresh own price stored');
});

test('(d) real undercut by someone else: alert includes who undercut', async () => {
    await setup();
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1999), listing('Undercutter', 1000)]);
    await RW.onListingsAdd(addMsg([listing('Undercutter', 1000)]));
    clock += 60 * 1000;
    const batch = await RW.takeChecked(() => true);
    assert.equal(batch.size, 1);
    const [u] = Array.from(batch.get(USER).values());
    assert.equal(u.mine, 1999);
    assert.equal(u.theirs, 1000);
    assert.equal(u.theirsName, 'Undercutter');
    assert.ok(logs.some(l => /\[UNDERCUT\].*by Undercutter/.test(l)), 'log names the seller');
    const embed = RW.buildUndercutEmbed(batch.get(USER), new Map([[ITEM, 'Test Hammer']]), 'en');
    assert.match(embed.data.description, /↳ lowest by Undercutter/);
    // other languages have the text too
    for (const lang of ['fr', 'de', 'ja']) assert.match(RW.buildUndercutEmbed(batch.get(USER), new Map(), lang).data.description, /Undercutter/);
});

test('(e) re-check request fails: the alert is kept', async () => {
    await setup();
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1999), listing('Undercutter', 1000)]);
    await RW.onListingsAdd(addMsg([listing('Undercutter', 1000)]));
    http.fail = true;
    const batch = await RW.takeChecked(() => true);
    assert.equal(batch.size, 1);
    const [u] = Array.from(batch.get(USER).values());
    assert.equal(u.theirs, 1000);
    assert.equal(u.theirsName, 'Undercutter');
});

test('(f) dropped alert resets last_alert_price so a later real undercut alerts again', async () => {
    await setup();
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1999), listing('Undercutter', 1500)]);
    await RW.onListingsAdd(addMsg([listing('Undercutter', 1500)]));
    assert.equal(db.items.get(ik(1, ITEM, 0)).last_alert_price, 1500);
    // by the time of the DM the user had already repriced below (REST shows it, feed piece was missed)
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1400), listing('Undercutter', 1500)]);
    const batch = await RW.takeChecked(() => true);
    assert.equal(batch.size, 0);
    assert.equal(db.items.get(ik(1, ITEM, 0)).last_alert_price, null, 'reset');
    // a real undercut later at the same price is not blocked (no cooldown, no last_alert_price)
    clock += RW.REPRICE_GRACE_MS + 1000;
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1400), listing('Undercutter', 1300)]);
    await RW.onListingsAdd(addMsg([listing('Undercutter', 1300)]));
    const later = await RW.takeChecked(() => true);
    assert.equal(later.size, 1);
    assert.equal(Array.from(later.get(USER).values())[0].theirs, 1300);
});

test('cheapest listing on another of the user\'s own retainers is not an undercut', async () => {
    await setup();
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1999), listing('Second Seller', 900), listing('Undercutter', 1500)]);
    await RW.onListingsAdd(addMsg([listing('Undercutter', 1500)]));
    assert.equal(RW.hasPending(), false);
});

test('another user\'s retainer still counts as a competitor', async () => {
    await setup();
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1999), listing('Rival', 1000)]);
    await RW.onListingsAdd(addMsg([listing('Rival', 1000)]));
    const batch = await RW.takeChecked(() => true);
    assert.equal(Array.from(batch.get(USER).values())[0].theirsName, 'Rival');
});

test('not due yet: undercut waits and is not re-checked', async () => {
    await setup();
    market.set(WORLD + '/' + ITEM, [listing("Mojo'rolvasch", 1999), listing('Undercutter', 1000)]);
    await RW.onListingsAdd(addMsg([listing('Undercutter', 1000)]));
    const before = http.calls.length;
    const batch = await RW.takeChecked(() => false);
    assert.equal(batch.size, 0);
    assert.equal(http.calls.length, before);
    assert.equal(RW.hasPending(), true);
});
