// Alert timing "Immediate" (market_alerts.alert_interval = 0): market alerts and retainer undercut DMs are sent
// as soon as they are found instead of at the 60-second flush; users with 1..30 minutes keep their interval.
// Since the alert settings split, retainer undercuts use their own timing (alert_settings kind 'retainer').
// Also: /marketalert shows "Alert timing: Immediate". Plain node, no Discord / database / network (fakes):
//   node --test test/alert-timing.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}

// ---------- stand-ins ----------
class FakeEmbed {
    constructor() { this.data = {}; }
    setTitle(v) { this.data.title = v; return this; }
    setColor(v) { this.data.color = v; return this; }
    setDescription(v) { this.data.description = v; return this; }
    setFooter(v) { this.data.footer = v; return this; }
    setTimestamp() { return this; }
    setURL(v) { this.data.url = v; return this; }
    addFields() { return this; }
}
const builder = () => new Proxy({}, { get: (o, k) => (k === 'then' ? undefined : () => builder()) });
// Fake Universalis for Retainer Watch: listings per 'worldId/itemId'; everything else (item names) fails
const market = new Map();
const fakeAxios = {
    async get(url) {
        const m = String(url).match(/universalis\.app\/api\/v2\/(\d+)\/(\d+)$/);
        if (!m) throw new Error('no network in tests');
        return { data: { listings: (market.get(m[1] + '/' + m[2]) || []).map(l => ({ ...l })) } };
    }
};
const shims = {
    ws: function () {}, bson: { BSON: { serialize: () => Buffer.alloc(0), deserialize: () => ({}) } },
    axios: fakeAxios,
    'discord.js': {
        EmbedBuilder: FakeEmbed, PermissionFlagsBits: { Administrator: 8n },
        SlashCommandBuilder: function () { return builder(); }, ActionRowBuilder: function () { return builder(); }, ButtonBuilder: function () { return builder(); },
        ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 }, MessageFlags: { Ephemeral: 64 }
    }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (shims[request]) return 'shim:' + request;
    return origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);

// Fake database: market_alerts.alert_interval, retainer_watch + retainer_items, alert_settings (retainer timing)
const db = { intervals: new Map(), retainerIntervals: new Map(), watches: [], items: new Map() };
const ik = (w, i, h) => Number(w) + ':' + Number(i) + ':' + Number(h);
const pool = {
    async execute(sql, a = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (q === 'SELECT user_id, alert_interval FROM market_alerts WHERE alert_interval <> 1') {
            return [[...db.intervals].filter(([, m]) => m !== 1).map(([user_id, alert_interval]) => ({ user_id, alert_interval }))];
        }
        if (q === 'SELECT alert_interval FROM market_alerts WHERE user_id = ?') {
            return [db.intervals.has(a[0]) ? [{ alert_interval: db.intervals.get(a[0]) }] : []];
        }
        if (/^SHOW COLUMNS FROM market_alerts LIKE/.test(q)) return [[{ Field: 'x' }]];
        if (q === 'SELECT user_id, dm, alert_interval FROM alert_settings WHERE kind = ?') {
            return [a[0] === 'retainer' ? [...db.retainerIntervals].map(([user_id, alert_interval]) => ({ user_id, dm: 1, alert_interval })) : []];
        }
        if (q === 'SELECT user_id, guild_id, channel_id, role_id FROM alert_channels WHERE kind = ? ORDER BY user_id, position') return [[]];
        if (q === 'SELECT datacenters FROM market_alert_dcs WHERE user_id = ?') return [[{ datacenters: '["Mana"]' }]];
        if (q === 'SELECT dm_enabled, alert_target, market_dm FROM market_alerts WHERE user_id = ?') return [[{ dm_enabled: 1, alert_target: 'dm', market_dm: 1 }]];
        if (q === 'SELECT datacenters FROM user_datacenters WHERE user_id = ? ORDER BY (guild_id = ?) DESC LIMIT 1') return [[{ datacenters: '["Mana"]' }]];
        if (q === "SELECT id, user_id, world_id, world_name, retainer_name FROM retainer_watch WHERE status = 'found' AND active = 1") {
            return [db.watches.map(w => ({ ...w }))];
        }
        if (q === 'SELECT user_id, world_id, retainer_name FROM retainer_watch') return [db.watches.map(w => ({ ...w }))];
        if (q === 'DELETE FROM retainer_items WHERE last_seen < ?') return [{}];
        if (q === 'SELECT item_id, hq FROM retainer_items WHERE watch_id = ?') return [[]]; // no start-up check in these tests
        if (/^INSERT INTO retainer_items \(watch_id, item_id, hq, price, last_seen\)/.test(q)) {
            const k = ik(a[0], a[1], a[2]);
            const r = db.items.get(k);
            if (r) Object.assign(r, { price: a[3], last_seen: a[4] });
            else db.items.set(k, { watch_id: Number(a[0]), item_id: Number(a[1]), hq: Number(a[2]), price: a[3], last_seen: a[4], last_alert_price: null });
            return [{}];
        }
        if (q === 'UPDATE retainer_watch SET last_seen_at = ? WHERE id = ?') return [{}];
        if (q === 'SELECT price, last_alert_price FROM retainer_items WHERE watch_id = ? AND item_id = ? AND hq = ?') {
            const r = db.items.get(ik(a[0], a[1], a[2]));
            return [r ? [{ price: r.price, last_alert_price: r.last_alert_price }] : []];
        }
        if (q === 'UPDATE retainer_items SET last_alert_price = ? WHERE watch_id = ? AND item_id = ? AND hq = ?') {
            const r = db.items.get(ik(a[1], a[2], a[3]));
            if (r) r.last_alert_price = a[0];
            return [{}];
        }
        if (q === 'UPDATE retainer_items SET last_alert_price = NULL WHERE watch_id = ? AND item_id = ? AND hq = ?') return [{}];
        if (/^SELECT watch_id, hq, price FROM retainer_items WHERE item_id = \? AND watch_id IN \(/.test(q)) {
            const ids = a.slice(1).map(Number);
            return [[...db.items.values()].filter(r => r.item_id === Number(a[0]) && ids.includes(r.watch_id)).map(r => ({ ...r }))];
        }
        throw new Error('Fake pool: unexpected SQL: ' + q);
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });
inject(path.join(ROOT, 'utils', 'membership.js'), { ownerHasMembership: async () => false, sponsorHasPerks: async () => false, findPerksAdmin: async () => null });
inject(path.join(ROOT, 'utils', 'dmStatus.js'), { isBlocked: () => false, load: async () => {}, markOk: async () => {}, markFailed: async () => {} });
let lang = 'en';
inject(path.join(ROOT, 'utils', 'userLanguage.js'), { forUser: async () => 'en', forGuild: () => 'en', forInteraction: async () => lang });

const RW = require('../utils/retainerWatch');
const MM = require('../utils/marketMonitor');
const marketalert = require('../commands/marketalert');
const { t } = require('../utils/i18n');
const T = MM._test;

const NOW_USER = '100000000000000001';  // Alert timing: Immediate
const FIVE_USER = '100000000000000002'; // every 5 minutes
const ONE_USER = '100000000000000003';  // default 1 minute

// Fake Discord client: records every DM; `hold` makes user.send wait until released
function fakeClient() {
    const dms = [];
    let gate = null;
    const client = {
        dms,
        hold() { let release; gate = new Promise(r => { release = r; }); return () => { gate = null; release(); }; },
        users: { fetch: async id => ({ send: async p => { if (gate) await gate; dms.push({ id, embeds: p.embeds }); } }) },
        guilds: { cache: new Map() }
    };
    return client;
}
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
// Retainer Watch spaces its Universalis checks (250 ms each): wait for a condition, at most `ms`
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); };
const match = (itemId, extra = {}) => ({ itemId, worldId: 44, dc: 'Mana', listingPrice: 1000, baselinePrice: 100000, percentDiff: -99, hq: false, quantity: 1, ...extra });

// Keep the console quiet (DM SENT lines etc.)
const origLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = origLog; });

async function setup() {
    db.intervals = new Map([[NOW_USER, 0], [FIVE_USER, 5], [ONE_USER, 1]]);
    await T.loadIntervals();
    T.pending().clear();
    T.cooldowns().clear();
    T.lastSentAt().clear();
    T.setSubscribers([NOW_USER, FIVE_USER].map(userId => ({ userId, dcs: ['Mana'] })));
}

// ---------- loading ----------
test('loadIntervals keeps 0 as Immediate; 1..30 minutes stay as they are; unknown values are ignored', async () => {
    db.intervals = new Map([[NOW_USER, 0], [FIVE_USER, 5], [ONE_USER, 1], ['100000000000000009', 7]]);
    await T.loadIntervals();
    const I = T.intervals();
    assert.equal(I.get(NOW_USER), 0, 'Immediate loaded');
    assert.equal(I.get(FIVE_USER), 5);
    assert.equal(I.has(ONE_USER), false, '1 minute = default, not stored');
    assert.equal(I.has('100000000000000009'), false, 'not a valid choice');
});

test('isDue: Immediate users are always due; a 5-minute user still waits its 5 minutes', async () => {
    await setup();
    const now = Date.now();
    T.lastSentAt().set(NOW_USER, now);
    T.lastSentAt().set(FIVE_USER, now);
    T.lastSentAt().set(ONE_USER, now - 30 * 1000);
    assert.equal(T.isDue(NOW_USER, now + 1), true, 'Immediate: due right after a DM');
    assert.equal(T.isDue(FIVE_USER, now + 60 * 1000), false, '5 minutes: not after 1 minute');
    assert.equal(T.isDue(FIVE_USER, now + 5 * 60 * 1000), true, '5 minutes: due after 5');
    assert.equal(T.isDue(ONE_USER, now), false, '1 minute: not after 30 seconds');
});

// ---------- market alerts ----------
test('an Immediate user\'s match is sent right away (no 60-second timer); a 5-minute user keeps collecting', async () => {
    await setup();
    T.lastSentAt().set(FIVE_USER, Date.now()); // the 5-minute user just got a DM
    const client = fakeClient();
    T.notifySubscribedUsers(client, match(5001));
    await ticks();
    assert.deepEqual(client.dms.map(d => d.id), [NOW_USER], 'only the Immediate user got a DM');
    assert.match(client.dms[0].embeds[0].data.title, /#5001/);
    assert.equal(T.pending().has(NOW_USER), false, 'nothing left waiting for the Immediate user');
    assert.equal(T.pending().has(FIVE_USER), true, '5-minute user still collecting');
    // the 1-hour cooldown is unchanged: the same item/world/quality again sends nothing
    T.notifySubscribedUsers(client, match(5001));
    await ticks();
    assert.equal(client.dms.length, 1);
});

test('a match found while a flush is running is sent right after it ends (not lost, not a minute later)', async () => {
    await setup();
    T.lastSentAt().set(FIVE_USER, Date.now());
    const client = fakeClient();
    const release = client.hold();
    T.notifySubscribedUsers(client, match(5001));
    await ticks();
    assert.equal(T.isFlushing(), true, 'first flush is waiting on Discord');
    T.notifySubscribedUsers(client, match(5002)); // comes in during the flush
    await ticks();
    assert.equal(client.dms.length, 0);
    release();
    await ticks(40);
    assert.equal(client.dms.length, 2, 'both items sent');
    assert.match(client.dms[0].embeds[0].data.title, /#5001/);
    assert.match(client.dms[1].embeds[0].data.title, /#5002/);
    assert.equal(T.pending().has(NOW_USER), false);
    assert.equal(T.isFlushing(), false);
});

test('the 60-second timer during a quick flush runs right after it, so interval users keep their timing', async () => {
    await setup();
    const client = fakeClient();
    T.lastSentAt().set(FIVE_USER, Date.now() - 5 * 60 * 1000); // the 5-minute user is due now
    const release = client.hold();
    T.setSubscribers([{ userId: NOW_USER, dcs: ['Mana'] }]);
    T.notifySubscribedUsers(client, match(5001)); // quick flush for the Immediate user only
    await ticks();
    T.setSubscribers([{ userId: FIVE_USER, dcs: ['Mana'] }]);
    T.notifySubscribedUsers(client, match(5003)); // the 5-minute user's item (waits for the timer)
    await T.flushAlerts(client);                   // the timer fires while the quick flush runs
    release();
    await ticks(40);
    assert.deepEqual(client.dms.map(d => d.id).sort(), [NOW_USER, FIVE_USER].sort(), 'the timer flush was not skipped');
    assert.equal(T.pending().size, 0);
});

// ---------- retainer undercuts ----------
test('retainer undercuts: sent right away (after the fresh re-check) for Immediate users; 5-minute users wait', async () => {
    await setup();
    db.retainerIntervals = new Map([[NOW_USER, 0], [FIVE_USER, 5]]); // the retainer alert timing (its own setting)
    await T.loadKindSettings('retainer');
    RW._test.reset();
    const WORLD = 44, ITEM = 7000;
    db.watches = [
        { id: 1, user_id: NOW_USER, world_id: WORLD, world_name: 'Testworld', retainer_name: 'Quickseller', status: 'found', active: 1 },
        { id: 2, user_id: FIVE_USER, world_id: WORLD, world_name: 'Testworld', retainer_name: 'Slowseller', status: 'found', active: 1 }
    ];
    db.items = new Map();
    try {
        await RW.load();
        await ticks();
        db.items.set(ik(1, ITEM, 0), { watch_id: 1, item_id: ITEM, hq: 0, price: 2000, last_seen: 0, last_alert_price: null });
        db.items.set(ik(2, ITEM, 0), { watch_id: 2, item_id: ITEM, hq: 0, price: 2000, last_seen: 0, last_alert_price: null });
        market.set(WORLD + '/' + ITEM, [
            { retainerName: 'Quickseller', pricePerUnit: 2000, hq: false },
            { retainerName: 'Slowseller', pricePerUnit: 2000, hq: false },
            { retainerName: 'Undercutter', pricePerUnit: 1500, hq: false }
        ]);
        T.kinds().retainer.lastSent.set(FIVE_USER, Date.now());
        const client = fakeClient();
        T.watchRetainerUndercuts(client);
        await RW.onListingsAdd({ event: 'listings/add', world: WORLD, item: ITEM, listings: [{ retainerName: 'Undercutter', pricePerUnit: 1500, hq: false }] });
        const started = Date.now();
        await waitFor(() => client.dms.length > 0, 5000);
        assert.deepEqual(client.dms.map(d => d.id), [NOW_USER], 'Immediate user DMed right away');
        assert.ok(Date.now() - started < 5000, 'well before the 60-second timer');
        await ticks(20);
        assert.equal(client.dms.length, 1);
        assert.equal(client.dms[0].embeds[0].data.title, t('en', 'alerts.undercut.title', { count: 1 }));
        assert.deepEqual(RW.pendingUsers(), [FIVE_USER], '5-minute user still waiting');
    } finally {
        RW._test.reset();
    }
});

// ---------- /marketalert ----------
test('/marketalert shows "Alert timing: Immediate" for 0, and "every X minutes" otherwise (4 languages)', async () => {
    const show = async (userId, l) => {
        lang = l;
        let content = '';
        await marketalert.execute({ user: { id: userId }, reply: async p => { content = p.content; } });
        return content;
    };
    db.intervals = new Map([[NOW_USER, 0], [FIVE_USER, 5], [ONE_USER, 1]]);
    for (const l of ['en', 'fr', 'de', 'ja']) {
        const imm = await show(NOW_USER, l);
        assert.ok(imm.includes(t(l, 'marketalert.immediate')), l + ': Immediate shown');
        assert.ok(!imm.includes('{'), l + ': no placeholders left');
        const five = await show(FIVE_USER, l);
        assert.ok(five.includes(t(l, 'marketalert.every', { interval: t(l, 'marketalert.minutes', { n: 5 }) })), l + ': every 5 minutes');
        assert.ok(!five.includes(t(l, 'marketalert.immediate')));
        const one = await show(ONE_USER, l);
        assert.ok(one.includes(t(l, 'marketalert.every', { interval: t(l, 'marketalert.minute', { n: 1 }) })), l + ': every 1 minute');
    }
    lang = 'en';
    assert.match(await show(NOW_USER, 'en'), /\*\*Alert timing:\*\* Immediate/);
});
