// Separate alert settings + Item alerts (bot side). Plain node, no Discord / database / network (fakes):
//   node --test test/alert-split.test.js
// - the one-time copy (utils/alertSplitDdl.js): runs once (also when the website runs it at the same time), never overwrites
// - retainer undercut alerts follow their own DM switch, Alert timing and server channels (not the market alert timing)
// - market alerts scan the market alert Data Centers (market_alert_dcs), not the /datacenter list
// - Item alerts: membership (Ko-fi, console / giveaway, Patreon), paused when it ends, price rule (Gil / median / both),
//   the same listing alerts once, a cheaper one again, 1-hour cooldown; their own channels (3 free / 10 with perks)
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
const market = new Map(); // 'worldId/itemId' -> listings (Retainer Watch re-checks)
const baselines = new Map(); // 'scope/itemId' -> Universalis history answer
const http = [];
const shims = {
    ws: function () {}, bson: { BSON: { serialize: () => Buffer.alloc(0), deserialize: () => ({}) } },
    axios: {
        async get(url, opts) {
            http.push(String(url));
            const m = String(url).match(/universalis\.app\/api\/v2\/([^/]+)\/(\d+)$/);
            if (!m) throw new Error('no network in tests');
            if (opts && opts.params && opts.params.listings === 0) {
                const b = baselines.get(decodeURIComponent(m[1]) + '/' + m[2]);
                if (!b) throw new Error('no baseline');
                return { data: b };
            }
            return { data: { listings: (market.get(m[1] + '/' + m[2]) || []).map(l => ({ ...l })) } };
        }
    },
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

// ---------- fake database (only the queries these features use) ----------
function freshDb() {
    return {
        tables: new Set(['market_alerts', 'user_datacenters', 'retainer_watch', 'retainer_items']),
        noInterval: false,
        market_alerts: [], user_datacenters: [], retainer_watch: [],
        alert_settings: new Map(), alert_channels: [], market_alert_dcs: new Map(), item_alerts: [], alert_migrations: new Map(),
        kofi: [], vset: new Map(), patreon: [], perks: new Set(), sql: []
    };
}
let db = freshDb();
const noTable = name => { const e = new Error("Table 'x." + name + "' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; return e; };
const need = name => { if (!db.tables.has(name)) throw noTable(name); };

async function run(sql, a = [], conn) {
    const q = sql.replace(/\s+/g, ' ').trim();
    db.sql.push(q);
    let m;
    if ((m = q.match(/^CREATE TABLE IF NOT EXISTS (\w+)/))) { db.tables.add(m[1]); return [{}]; }
    if (/^INSERT IGNORE INTO alert_migrations/.test(q)) {
        need('alert_migrations');
        if (db.alert_migrations.has(a[0])) return [{ affectedRows: 0 }];
        db.alert_migrations.set(a[0], a[1]);
        conn.undo.push(() => db.alert_migrations.delete(a[0]));
        return [{ affectedRows: 1 }];
    }
    if (q === 'SELECT user_id, guild_id, datacenters FROM user_datacenters') { need('user_datacenters'); return [db.user_datacenters.map(r => ({ ...r }))]; }
    if (q === 'SELECT user_id FROM market_alerts') { need('market_alerts'); return [db.market_alerts.map(r => ({ user_id: r.user_id }))]; }
    if (q === 'SELECT user_id, alert_interval FROM market_alerts') {
        if (db.noInterval) { const e = new Error("Unknown column 'alert_interval' in 'field list'"); e.code = 'ER_BAD_FIELD_ERROR'; throw e; }
        return [db.market_alerts.map(r => ({ user_id: r.user_id, alert_interval: r.alert_interval === undefined ? 1 : r.alert_interval }))];
    }
    if (q === 'SELECT DISTINCT user_id FROM retainer_watch') { need('retainer_watch'); return [[...new Set(db.retainer_watch.map(w => w.user_id))].map(user_id => ({ user_id }))]; }
    if ((m = q.match(/^INSERT IGNORE INTO market_alert_dcs \(user_id, datacenters, updated_at\) VALUES (.*)$/))) {
        for (let i = 0; i < a.length; i += 3) {
            if (db.market_alert_dcs.has(a[i])) continue;
            db.market_alert_dcs.set(a[i], { user_id: a[i], datacenters: a[i + 1] });
            const id = a[i]; conn.undo.push(() => db.market_alert_dcs.delete(id));
        }
        return [{}];
    }
    if (/^INSERT IGNORE INTO alert_settings \(user_id, kind, dm, alert_interval, updated_at\) VALUES/.test(q)) {
        for (let i = 0; i < a.length; i += 5) {
            const k = a[i] + ':' + a[i + 1];
            if (db.alert_settings.has(k)) continue;
            db.alert_settings.set(k, { user_id: a[i], kind: a[i + 1], dm: a[i + 2], alert_interval: a[i + 3] });
            conn.undo.push(() => db.alert_settings.delete(k));
        }
        return [{}];
    }
    if (q === 'SELECT user_id, dm, alert_interval FROM alert_settings WHERE kind = ?') {
        need('alert_settings');
        return [[...db.alert_settings.values()].filter(r => r.kind === a[0]).map(r => ({ ...r }))];
    }
    if (q === 'SELECT user_id, guild_id, channel_id, role_id FROM alert_channels WHERE kind = ? ORDER BY user_id, position') {
        need('alert_channels');
        return [db.alert_channels.filter(r => r.kind === a[0]).sort((x, y) => (x.user_id > y.user_id ? 1 : x.user_id < y.user_id ? -1 : x.position - y.position)).map(r => ({ ...r }))];
    }
    if (q === 'SELECT user_id FROM market_alerts WHERE dm_enabled = 1') return [db.market_alerts.filter(r => r.dm_enabled === 1).map(r => ({ user_id: r.user_id }))];
    if (q === 'SELECT user_id, datacenters FROM market_alert_dcs') { need('market_alert_dcs'); return [[...db.market_alert_dcs.values()]]; }
    if (q === "SELECT user_id FROM market_alerts WHERE alert_target = 'server'") return [db.market_alerts.filter(r => r.alert_target === 'server').map(r => ({ user_id: r.user_id }))];
    if (q === "SELECT user_id, market_dm FROM market_alerts WHERE alert_target = 'server' AND market_dm IS NOT NULL") return [[]];
    if (q === 'SELECT user_id, alert_interval FROM market_alerts WHERE alert_interval <> 1') return [db.market_alerts.filter(r => r.alert_interval !== undefined && r.alert_interval !== 1)];
    if (q === 'SELECT user_id, min_median FROM market_alerts WHERE min_median IS NOT NULL') return [[]];
    if (q === 'SELECT state, cycle_end FROM supporter_perks WHERE user_id = ?') return [db.perks.has(a[0]) ? [{ state: 'active', cycle_end: Date.now() + 864e5 }] : []];
    // Retainer Watch
    if (q === "SELECT id, user_id, world_id, world_name, retainer_name FROM retainer_watch WHERE status = 'found' AND active = 1") return [db.retainer_watch.map(w => ({ ...w }))];
    if (q === 'SELECT user_id, world_id, retainer_name FROM retainer_watch') return [db.retainer_watch.map(w => ({ ...w }))];
    if (q === 'DELETE FROM retainer_items WHERE last_seen < ?') return [{}];
    if (q === 'SELECT item_id, hq FROM retainer_items WHERE watch_id = ?') return [[]];
    // Item alerts + membership
    if (q === 'SELECT id, user_id, item_id, item_name, quality, places, max_price, below_median FROM item_alerts ORDER BY user_id, id') { need('item_alerts'); return [db.item_alerts.map(r => ({ ...r }))]; }
    if (/^SELECT created_at FROM kofi_payments WHERE user_id = \?/.test(q)) {
        if (!db.tables.has('kofi_payments')) throw noTable('kofi_payments');
        return [db.kofi.filter(p => p.user_id === a[0] && p.created_at > a[1])];
    }
    if (q === 'SELECT member_until FROM voice_user_settings WHERE user_id = ?') { return [db.vset.has(a[0]) ? [{ member_until: db.vset.get(a[0]) }] : []]; }
    if (/^SELECT member_until FROM patreon_payments WHERE user_id = \?/.test(q)) {
        if (!db.tables.has('patreon_payments')) throw noTable('patreon_payments');
        return [db.patreon.filter(p => p.user_id === a[0] && p.member_until > a[1])];
    }
    throw new Error('Fake pool: unexpected SQL: ' + q);
}
const pool = {
    execute: (sql, a) => run(sql, a, { undo: [] }),
    async getConnection() {
        const conn = {
            undo: [],
            beginTransaction: async () => {},
            execute: (sql, a) => run(sql, a, conn),
            commit: async () => { conn.undo = []; },
            rollback: async () => { while (conn.undo.length) conn.undo.pop()(); },
            release: () => {}
        };
        return conn;
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });
inject(path.join(ROOT, 'utils', 'membership.js'), { ownerHasMembership: async id => db.perks.has(String(id)), sponsorHasPerks: async () => false, findPerksAdmin: async () => null });
let blocked = new Set();
inject(path.join(ROOT, 'utils', 'dmStatus.js'), { isBlocked: id => blocked.has(String(id)), load: async () => {}, markOk: async () => {}, markFailed: async () => {} });
inject(path.join(ROOT, 'utils', 'userLanguage.js'), { forUser: async () => 'en', forGuild: () => 'en', forInteraction: async () => 'en' });

const DDL = require('../utils/alertSplitDdl');
const RW = require('../utils/retainerWatch');
const IA = require('../utils/itemAlerts');
const MM = require('../utils/marketMonitor');
const { t } = require('../utils/i18n');
const T = MM._test;

const U1 = '100000000000000001';
const U2 = '100000000000000002';
const U3 = '100000000000000003';
const G1 = '200000000000000001';
const C1 = '300000000000000001';

const origLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => { console.log = origLog; });
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); };

// Fake Discord client: DMs and channel posts are recorded
function fakeClient(guilds = []) {
    const dms = [];
    const posts = [];
    const cache = new Map();
    for (const g of guilds) {
        const channels = new Map([[g.channelId, { id: g.channelId, name: 'alerts', isTextBased: () => true, send: async p => { posts.push({ guildId: g.id, ...p }); } }]]);
        cache.set(g.id, { id: g.id, name: 'Guild', ownerId: g.ownerId, channels: { cache: channels }, members: { fetch: async () => null } });
    }
    return { dms, posts, users: { fetch: async id => ({ send: async p => { dms.push({ id, embeds: p.embeds }); } }) }, guilds: { cache } };
}

// Small geo: Mana (Japan) = worlds 44 Anima, 49 Masamune; Aether (NA) = 73 Adamantoise
const GEO = { dcWorlds: { Mana: [44, 49], Aether: [73] }, dcRegion: { Mana: 'Japan', Aether: 'North-America' }, worldNames: { 44: 'Anima', 49: 'Masamune', 73: 'Adamantoise' } };

// ================= one-time copy =================
test('migration: copies /datacenter -> market alert Data Centers and the market timing -> retainer settings (DM on), once', async () => {
    db = freshDb();
    db.market_alerts = [{ user_id: U1, dm_enabled: 1, alert_interval: 5 }, { user_id: U2, dm_enabled: 1, alert_interval: 0 }];
    db.user_datacenters = [
        { user_id: U1, guild_id: 'personal', datacenters: '["Mana","Gaia"]' },
        { user_id: U1, guild_id: G1, datacenters: '["Aether"]' },
        { user_id: U2, guild_id: G1, datacenters: '["Light"]' },          // market user, only an older per-server list
        { user_id: U3, guild_id: 'personal', datacenters: '["Chaos"]' },  // /datacenter only, no market_alerts row
        { user_id: '100000000000000004', guild_id: G1, datacenters: '["Primal"]' } // per-server only, no market alerts: not copied
    ];
    db.retainer_watch = [{ id: 1, user_id: U1 }, { id: 2, user_id: U1 }, { id: 3, user_id: U3 }];
    const out = await DDL.ensureAlertSplit(pool, 1000);
    assert.deepEqual(out, { dcs: 3, retainers: 2 });
    assert.deepEqual(JSON.parse(db.market_alert_dcs.get(U1).datacenters), ['Mana', 'Gaia'], 'personal list first');
    assert.deepEqual(JSON.parse(db.market_alert_dcs.get(U2).datacenters), ['Light'], 'market user without a personal list: the older list');
    assert.deepEqual(JSON.parse(db.market_alert_dcs.get(U3).datacenters), ['Chaos']);
    assert.equal(db.market_alert_dcs.has('100000000000000004'), false);
    assert.deepEqual(db.alert_settings.get(U1 + ':retainer'), { user_id: U1, kind: 'retainer', dm: 1, alert_interval: 5 });
    assert.deepEqual(db.alert_settings.get(U3 + ':retainer'), { user_id: U3, kind: 'retainer', dm: 1, alert_interval: 1 }, 'no market row: 1 minute');
    assert.equal(db.alert_settings.has(U2 + ':retainer'), false, 'no Retainer Watch: nothing copied');
    assert.equal(db.alert_channels.length, 0, 'no retainer channels');

    // later user changes are never overwritten, and it never runs twice
    db.market_alert_dcs.set(U1, { user_id: U1, datacenters: '["Meteor"]' });
    db.alert_settings.get(U1 + ':retainer').dm = 0;
    db.user_datacenters[0].datacenters = '["Elemental"]';
    assert.equal(await DDL.ensureAlertSplit(pool, 2000), null, 'already done');
    assert.equal(JSON.parse(db.market_alert_dcs.get(U1).datacenters)[0], 'Meteor');
    assert.equal(db.alert_settings.get(U1 + ':retainer').dm, 0);
    assert.equal(db.alert_migrations.get(DDL.MIGRATION), 1000);
});

test('migration: copy uses INSERT IGNORE (a row saved before it ran is kept); a failed copy rolls back and runs again', async () => {
    db = freshDb();
    db.market_alerts = [{ user_id: U1, dm_enabled: 1, alert_interval: 10 }];
    db.user_datacenters = [{ user_id: U1, guild_id: 'personal', datacenters: '["Mana"]' }];
    db.retainer_watch = [{ id: 1, user_id: U1 }];
    await DDL.createTables(pool);
    db.alert_settings.set(U1 + ':retainer', { user_id: U1, kind: 'retainer', dm: 0, alert_interval: 2 }); // saved on the website first
    // the first try fails in the middle (database hiccup): nothing stays half done, the marker is rolled back
    db.noInterval = true;
    let failOnce = true;
    const exec = pool.getConnection;
    pool.getConnection = async () => {
        const c = await exec();
        const e = c.execute;
        c.execute = async (sql, a) => {
            if (failOnce && /INSERT IGNORE INTO alert_settings/.test(sql)) { failOnce = false; throw new Error('Lost connection'); }
            return e(sql, a);
        };
        return c;
    };
    await assert.rejects(DDL.migrateOnce(pool, 5), /Lost connection/);
    assert.equal(db.alert_migrations.size, 0, 'marker rolled back');
    assert.equal(db.market_alert_dcs.size, 0, 'copy rolled back');
    const out = await DDL.migrateOnce(pool, 6);
    pool.getConnection = exec;
    assert.ok(out);
    assert.deepEqual(db.alert_settings.get(U1 + ':retainer'), { user_id: U1, kind: 'retainer', dm: 0, alert_interval: 2 }, 'kept as saved');
    assert.ok(db.market_alert_dcs.has(U1));
});

test('migration: the bot and the website starting together copy only once (second waits for the row lock, then skips)', async () => {
    db = freshDb();
    db.market_alerts = [{ user_id: U1, dm_enabled: 1, alert_interval: 5 }];
    db.user_datacenters = [{ user_id: U1, guild_id: 'personal', datacenters: '["Mana"]' }];
    db.retainer_watch = [{ id: 1, user_id: U1 }];
    await DDL.createTables(pool);
    const [a, b] = await Promise.all([DDL.migrateOnce(pool, 10), DDL.migrateOnce(pool, 11)]);
    assert.equal([a, b].filter(Boolean).length, 1, 'exactly one copy');
    assert.equal(db.sql.filter(q => q.startsWith('INSERT IGNORE INTO market_alert_dcs')).length, 1);
});

test('migration: missing old tables / columns (fresh install) -> nothing to copy, still marked done', async () => {
    db = freshDb();
    db.tables.delete('retainer_watch');
    db.tables.delete('user_datacenters');
    assert.deepEqual(await DDL.ensureAlertSplit(pool, 1), { dcs: 0, retainers: 0 });
    assert.equal(await DDL.ensureAlertSplit(pool, 2), null);
});

// ================= market alert Data Centers =================
test('market alerts scan the market alert Data Centers, not the /datacenter list', async () => {
    db = freshDb();
    await DDL.createTables(pool);
    db.market_alerts = [{ user_id: U1, dm_enabled: 1 }, { user_id: U2, dm_enabled: 1 }, { user_id: U3, dm_enabled: 0 }];
    db.user_datacenters = [{ user_id: U1, guild_id: 'personal', datacenters: '["Aether"]' }, { user_id: U2, guild_id: 'personal', datacenters: '["Mana"]' }];
    db.market_alert_dcs.set(U1, { user_id: U1, datacenters: '["Mana"]' });
    db.market_alert_dcs.set(U3, { user_id: U3, datacenters: '["Mana"]' });
    T.setGeo({ Mana: [44, 49], Aether: [73] }, GEO.dcRegion, GEO.worldNames);
    const { list, enabledCount } = await T.loadSubscribers();
    assert.equal(enabledCount, 2);
    assert.deepEqual(list, [{ userId: U1, dcs: ['Mana'] }], 'U2 has only /datacenter: not scanned; U3 is off');
    assert.ok(!db.sql.some(q => /user_datacenters/.test(q)), 'the /datacenter table is not read');
});

// ================= retainer undercut settings =================
async function undercutSetup(settings, channels = []) {
    db = freshDb();
    await DDL.createTables(pool);
    for (const [id, s] of Object.entries(settings)) db.alert_settings.set(id + ':retainer', { user_id: id, kind: 'retainer', ...s });
    db.alert_channels = channels;
    await T.loadKindSettings('retainer');
    await T.loadKindSettings('item');
    T.pending().clear();
    T.lastSentAt().clear();
    T.kinds().retainer.lastSent.clear();
    RW._test.reset();
}
const undercutAt = async (users) => {
    const WORLD = 44, ITEM = 7000;
    db.retainer_watch = users.map((u, i) => ({ id: i + 1, user_id: u, world_id: WORLD, world_name: 'Anima', retainer_name: 'Seller' + i, status: 'found', active: 1 }));
    await RW.load({ canSend: id => T.kindCanSend('retainer', id) });
    const loaded = RW.getWorlds().size;
    // the undercut, straight into the pending list (re-checked with fresh data on send)
    market.set(WORLD + '/' + ITEM, [...users.map((u, i) => ({ retainerName: 'Seller' + i, pricePerUnit: 2000, hq: false })), { retainerName: 'Other', pricePerUnit: 1500, hq: false }]);
    const fakeExec = pool.execute;
    pool.execute = async (sql, a) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (/^SELECT watch_id, hq, price FROM retainer_items WHERE item_id = \?/.test(q)) return [db.retainer_watch.filter(w => RW.getWorlds().has(w.world_id)).map(w => ({ watch_id: w.id, hq: 0, price: 2000 }))];
        if (/^INSERT INTO retainer_items/.test(q) || /^UPDATE retainer_/.test(q)) return [{}];
        if (/^SELECT price, last_alert_price FROM retainer_items/.test(q)) return [[{ price: 2000, last_alert_price: null }]];
        return fakeExec(sql, a);
    };
    try {
        await RW.onListingsAdd({ event: 'listings/add', world: WORLD, item: ITEM, listings: [{ retainerName: 'Other', pricePerUnit: 1500, hq: false }] });
    } finally { pool.execute = fakeExec; }
    return loaded;
};

test('retainer undercuts: own Alert timing (Immediate here) even when the market alert timing is 30 minutes', async () => {
    await undercutSetup({ [U1]: { dm: 1, alert_interval: 0 } });
    db.market_alerts = [{ user_id: U1, dm_enabled: 1, alert_interval: 30 }];
    await T.loadIntervals();
    T.lastSentAt().set(U1, Date.now()); // market alert DM just sent: the market timing must not hold undercuts back
    const client = fakeClient();
    T.watchRetainerUndercuts(client);
    const prevExec = pool.execute;
    pool.execute = async (sql, a) => (/^(INSERT INTO retainer_items|UPDATE retainer_)/.test(sql.replace(/\s+/g, ' ').trim()) ? [{}] : prevExec(sql, a));
    try {
        await undercutAt([U1]);
        await waitFor(() => client.dms.length > 0, 4000);
    } finally { pool.execute = prevExec; }
    assert.equal(client.dms.length, 1, 'sent right away');
    assert.equal(client.dms[0].embeds[0].data.title, t('en', 'alerts.undercut.title', { count: 1 }));
    RW._test.reset();
});

test('retainer undercuts: a 10-minute retainer timing waits; DM off + a channel = posted in the channel only; DM off and no channel = not watched', async () => {
    await undercutSetup({ [U1]: { dm: 1, alert_interval: 10 }, [U2]: { dm: 0, alert_interval: 1 }, [U3]: { dm: 0, alert_interval: 1 } },
        [{ user_id: U2, kind: 'retainer', guild_id: G1, channel_id: C1, role_id: null, position: 0 }]);
    assert.equal(T.kindCanSend('retainer', U3), false);
    assert.equal(T.kindCanSend('retainer', U2), true);
    const client = fakeClient([{ id: G1, channelId: C1, ownerId: U2 }]);
    T.watchRetainerUndercuts(client);
    const prevExec = pool.execute;
    pool.execute = async (sql, a) => (/^(INSERT INTO retainer_items|UPDATE retainer_)/.test(sql.replace(/\s+/g, ' ').trim()) ? [{}] : prevExec(sql, a));
    try {
        db.retainer_watch = [];
        await undercutAt([U1, U2, U3]);
        assert.deepEqual(RW.pendingUsers().sort(), [U1, U2].sort(), 'U3 (no DM, no channel) is not watched');
        T.kinds().retainer.lastSent.set(U1, Date.now()); // U1 got an undercut DM a moment ago
        await T.flushAlerts(client);
        await ticks(40);
        await waitFor(() => client.posts.length > 0, 4000);
    } finally { pool.execute = prevExec; }
    assert.equal(client.dms.length, 0, 'U1 waits for its 10 minutes, U2 has the DM switch off');
    assert.equal(client.posts.length, 1, 'U2: posted in the retainer channel');
    assert.equal(client.posts[0].embeds[0].data.title, t('en', 'alerts.undercut.title', { count: 1 }));
    assert.equal(client.posts[0].embeds[0].data.footer.text, t('en', 'alerts.footerShort'));
    assert.deepEqual(RW.pendingUsers(), [U1], 'U1 still waiting');
    RW._test.reset();
});

test('retainer channels: 3 free, 10 with Supporter Perks, counted apart from market and Item alert channels', async () => {
    const rows = (kind, user, n) => Array.from({ length: n }, (_, i) => ({ user_id: user, kind, guild_id: '2000000000000000' + (10 + i), channel_id: C1, role_id: i === 0 ? '400000000000000001' : null, position: i }));
    await undercutSetup({}, [...rows('retainer', U1, 5), ...rows('item', U1, 4), ...rows('retainer', U2, 12)]);
    db.perks.add(U2);
    await T.loadKindSettings('retainer');
    await T.loadKindSettings('item');
    assert.equal(T.kinds().retainer.targets.get(U1).length, 3, 'no perks: first 3');
    assert.equal(T.kinds().retainer.targets.get(U1)[0].roleId, '400000000000000001', 'role ping kept');
    assert.equal(T.kinds().item.targets.get(U1).length, 3, 'item channels counted on their own');
    assert.equal(T.kinds().retainer.targets.get(U2).length, 10, 'perks: up to 10');
});

// ================= Item alerts =================
const DAY = 864e5;
function itemRow(extra) {
    return { id: 1, user_id: U1, item_id: 5057, item_name: 'Iron Ingot', quality: 'nq', places: JSON.stringify([{ type: 'dc', name: 'Mana' }]), max_price: 1000, below_median: 0, ...extra };
}
async function itemSetup(rows, member = 'kofi') {
    db = freshDb();
    await DDL.createTables(pool);
    db.tables.add('kofi_payments');
    db.tables.add('patreon_payments');
    if (member === 'kofi') db.kofi.push({ user_id: U1, created_at: Date.now() - DAY });
    if (member === 'console') db.vset.set(U1, Date.now() + DAY);
    if (member === 'patreon') db.patreon.push({ user_id: U1, member_until: Date.now() + DAY });
    db.item_alerts = rows;
    IA._test.reset();
    IA._test.setNow();
    await IA.load(GEO);
}
const listing = (price, extra = {}) => ({ listingID: 'L' + price + (extra.id || ''), pricePerUnit: price, quantity: 1, hq: false, retainerName: 'R', ...extra });
const add = (world, listings) => ({ event: 'listings/add', item: 5057, world, listings });

test('membership: Ko-fi payment, console / giveaway membership and Patreon each count; none = paused (items kept)', async () => {
    for (const m of ['kofi', 'console', 'patreon']) {
        await itemSetup([itemRow()], m);
        assert.equal(IA.hasAlerts(), true, m + ' counts');
        assert.deepEqual([...IA.getWorlds()].sort(), [44, 49]);
    }
    await itemSetup([itemRow()], null);
    assert.equal(IA.hasAlerts(), false, 'not a member: skipped');
    assert.equal(db.item_alerts.length, 1, 'nothing deleted');
    // old Ko-fi payment (over 35 days) = ended; Patreon member_until passed = ended
    await itemSetup([itemRow()], null);
    db.kofi.push({ user_id: U1, created_at: Date.now() - 40 * DAY });
    db.patreon.push({ user_id: U1, member_until: Date.now() - 1 });
    IA._test.reset();
    await IA.load(GEO);
    assert.equal(IA.hasAlerts(), false);
});

test('membership ends: items pause at the next check (5-minute cache) and come back on renewal', async () => {
    await itemSetup([itemRow()], 'kofi');
    let clock = Date.now();
    IA._test.setNow(() => clock);
    assert.equal(IA.hasAlerts(), true);
    db.kofi = []; // membership ended
    await IA.load(GEO);
    assert.equal(IA.hasAlerts(), true, 'cached for 5 minutes');
    clock += 5 * 60 * 1000 + 1;
    await IA.load(GEO);
    assert.equal(IA.hasAlerts(), false, 'paused');
    db.patreon.push({ user_id: U1, member_until: clock + DAY }); // renewed (on Patreon this time)
    clock += 5 * 60 * 1000 + 1;
    await IA.load(GEO);
    assert.equal(IA.hasAlerts(), true, 'back');
    IA._test.setNow();
});

test('places: a region, a Data Center and single worlds in any mix; only the ticked worlds alert', async () => {
    await itemSetup([itemRow({ places: JSON.stringify([{ type: 'world', name: 'Masamune' }, { type: 'region', name: 'North-America' }]) })]);
    assert.deepEqual([...IA.getWorlds()].sort((a, b) => a - b), [49, 73]);
    const got = [];
    await IA.onListingsAdd(add(44, [listing(10)]), { onMatch: m => got.push(m) });
    assert.equal(got.length, 0, 'Anima is not ticked');
    await IA.onListingsAdd(add(49, [listing(10)]), { onMatch: m => got.push(m) });
    await IA.onListingsAdd(add(73, [listing(11)]), { onMatch: m => got.push(m) });
    assert.deepEqual(got.map(m => [m.worldId, m.place.key]), [[49, 'world:49'], [73, 'region:North-America']]);
});

test('price rule: fixed Gil (below it), below median (each place its own median), both = below both', async () => {
    const medianOf = { Mana: { nq: { median: 800, count: 6 }, hq: { median: null, count: 0 } }, 44: { nq: { median: 300, count: 2 }, hq: { median: null, count: 0 } } };
    const getBaseline = async (itemId, scope) => medianOf[scope] || null;
    // fixed only
    await itemSetup([itemRow({ max_price: 1000, below_median: 0 })]);
    let got = [];
    await IA.onListingsAdd(add(44, [listing(1000)]), { getBaseline, onMatch: m => got.push(m) });
    assert.equal(got.length, 0, 'equal is not below');
    await IA.onListingsAdd(add(44, [listing(999)]), { getBaseline, onMatch: m => got.push(m) });
    assert.equal(got.length, 1);
    assert.equal(got[0].median, null, 'no median shown when not used');
    // median only: the DC median 800, and Anima's own median 300 when Anima is ticked as a world
    await itemSetup([itemRow({ max_price: null, below_median: 1, places: JSON.stringify([{ type: 'dc', name: 'Mana' }, { type: 'world', name: 'Anima' }]) })]);
    got = [];
    await IA.onListingsAdd(add(44, [listing(500)]), { getBaseline, onMatch: m => got.push(m) });
    assert.deepEqual(got.map(m => [m.place.key, m.median]), [['dc:Mana', 800]], '500 < Mana 800 but not < Anima 300');
    // both: below 600 AND below the median 800
    await itemSetup([itemRow({ max_price: 600, below_median: 1 })]);
    got = [];
    await IA.onListingsAdd(add(44, [listing(700)]), { getBaseline, onMatch: m => got.push(m) });
    assert.equal(got.length, 0, 'below the median but not the fixed Gil');
    await IA.onListingsAdd(add(44, [listing(590)]), { getBaseline, onMatch: m => got.push(m) });
    assert.equal(got.length, 1);
    assert.equal(got[0].median, 800);
    assert.equal(IA.passesRule(100, { maxPrice: null, belowMedian: true }, null), false, 'no median known = no alert');
    // no rule at all is never watched
    await itemSetup([itemRow({ max_price: null, below_median: 0 })]);
    assert.equal(IA.hasAlerts(), false);
});

test('quality: NQ only, HQ only, Both; mannequin listings never alert', async () => {
    const run1 = async q => {
        await itemSetup([itemRow({ quality: q })]);
        const got = [];
        await IA.onListingsAdd(add(44, [listing(10), listing(20, { hq: true }), listing(1, { onMannequin: true })]), { onMatch: m => got.push(m.hq ? 'hq' : 'nq') });
        return got;
    };
    assert.deepEqual(await run1('nq'), ['nq']);
    assert.deepEqual(await run1('hq'), ['hq']);
    assert.deepEqual(await run1('both'), ['nq', 'hq']);
});

test('repeats: the same listing alerts once; a cheaper one alerts again; another one at the same price waits 1 hour', async () => {
    await itemSetup([itemRow()]);
    let clock = Date.now();
    IA._test.setNow(() => clock);
    const got = [];
    const deps = { onMatch: m => got.push(m.price) };
    await IA.onListingsAdd(add(44, [listing(500)]), deps);
    await IA.onListingsAdd(add(44, [listing(500)]), deps);             // the same listing again
    assert.deepEqual(got, [500]);
    await IA.onListingsAdd(add(49, [listing(500, { id: 'b' })]), deps); // new listing, same price, same place (Mana): cooldown
    assert.deepEqual(got, [500]);
    await IA.onListingsAdd(add(49, [listing(400)]), deps);              // cheaper: alerts
    assert.deepEqual(got, [500, 400]);
    clock += IA.REPEAT_COOLDOWN_MS + 1;
    await IA.onListingsAdd(add(44, [listing(450, { id: 'c' })]), deps); // an hour later: a new listing alerts again
    await IA.onListingsAdd(add(44, [listing(500)]), deps);              // ... but the first listing never again
    assert.deepEqual(got, [500, 400, 450]);
    IA._test.setNow();
});

test('limit: at most 100 items per member are watched (extra rows ignored)', async () => {
    await itemSetup(Array.from({ length: 105 }, (_, i) => itemRow({ id: i + 1, item_id: 1000 + i })));
    assert.equal(IA._test.byItem().size, 100);
});

test('bot: matches from the live feed are sent with the Item alert settings (Immediate DM, embed with NQ/HQ, world, price, median)', async () => {
    await itemSetup([itemRow({ max_price: 1000, below_median: 1, quality: 'hq' })]);
    db.alert_settings.set(U1 + ':item', { user_id: U1, kind: 'item', dm: 1, alert_interval: 0 });
    await T.loadKindSettings('item');
    T.setGeo({ Mana: [44, 49], Aether: [73] }, GEO.dcRegion, GEO.worldNames);
    T.pendingItems().clear();
    T.baselineCache().clear();
    baselines.set('Mana/5057', { recentHistory: Array.from({ length: 6 }, () => ({ hq: true, pricePerUnit: 2000, timestamp: Date.now() / 1000 })), hqSaleVelocity: 2, nqSaleVelocity: 1 });
    const client = fakeClient();
    await T.handleItemAlerts(client, add(49, [listing(900, { hq: true })]));
    await waitFor(() => client.dms.length > 0, 3000);
    assert.equal(client.dms.length, 1);
    const e = client.dms[0].embeds[0].data;
    assert.match(e.title, /#5057/);
    assert.match(e.title, /HQ/);
    assert.match(e.description, /Masamune \(Mana\)/);
    assert.match(e.description, /900 Gil/);
    assert.match(e.description, /2,000 Gil/, 'median shown');
    assert.ok(http.some(u => /universalis\.app\/api\/v2\/Mana\/5057$/.test(u)), 'median from Universalis (cached like market baselines)');
    // the same listing again: nothing new
    await T.handleItemAlerts(client, add(49, [listing(900, { hq: true })]));
    await ticks(20);
    assert.equal(client.dms.length, 1);
});

test('bot: Item alert DM off + channels -> channel post only; interval timing waits; market timing does not matter', async () => {
    await itemSetup([itemRow()]);
    db.alert_settings.set(U1 + ':item', { user_id: U1, kind: 'item', dm: 0, alert_interval: 5 });
    db.alert_channels = [{ user_id: U1, kind: 'item', guild_id: G1, channel_id: C1, role_id: '400000000000000009', position: 0 }];
    await T.loadKindSettings('item');
    T.pendingItems().clear();
    T.kinds().item.lastSent.clear();
    const client = fakeClient([{ id: G1, channelId: C1, ownerId: U1 }]);
    await T.handleItemAlerts(client, add(44, [listing(100)]));
    assert.equal(client.posts.length, 0, 'collected, not Immediate');
    await T.flushAlerts(client);
    assert.equal(client.dms.length, 0, 'DM switch off');
    assert.equal(client.posts.length, 1);
    assert.equal(client.posts[0].content, '<@&400000000000000009>', 'role ping');
    assert.match(client.posts[0].embeds[0].data.title, /Iron Ingot|#5057/);
    // a new cheaper listing within 5 minutes waits for the interval
    await T.handleItemAlerts(client, add(44, [listing(50)]));
    await T.flushAlerts(client);
    assert.equal(client.posts.length, 1, 'waits its 5 minutes');
    assert.equal(T.pendingItems().has(U1), true);
    T.kinds().item.lastSent.set(U1, Date.now() - 5 * 60 * 1000);
    await T.flushAlerts(client);
    assert.equal(client.posts.length, 2);
});

test('bot: Item alert worlds are added to the Universalis subscriptions (with market and retainer worlds)', async () => {
    await itemSetup([itemRow({ places: JSON.stringify([{ type: 'world', name: 'Adamantoise' }]) })]);
    assert.deepEqual([...IA.getWorlds()], [73]);
    const src = require('fs').readFileSync(path.join(ROOT, 'utils', 'marketMonitor.js'), 'utf8');
    assert.match(src, /for \(const id of itemAlerts\.getWorlds\(\)\) worlds\.add\(id\);/);
});

test('texts: new alert keys in 4 languages; /marketalert and help no longer say the market alerts use /datacenter', async () => {
    for (const l of ['en', 'fr', 'de', 'ja']) {
        for (const k of ['alerts.item.title', 'alerts.item.median', 'alerts.footer', 'marketalert.noneSet']) {
            const v = t(l, k, { name: 'X', quality: 'HQ' });
            assert.ok(v && v !== k && !/\{name\}|\{quality\}/.test(v), l + ' ' + k);
        }
        assert.ok(!/\/datacenter/.test(t(l, 'marketalert.noneSet')), l + ' noneSet');
        assert.ok(!/\/datacenter/.test(t(l, 'alerts.footer')), l + ' footer');
    }
});
