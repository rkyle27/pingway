// Market alerts v2.2 (Part 5.3): DM on/off and server channels are separate; channels: 3 free, 10 with Supporter Perks,
// optional role ping per channel; older rows keep what they had (DM users keep DMs, channel users keep channels).
// Also: the Server language card (utils/guildLanguage.js) is used by public posts (userLanguage.forGuild).
// Plain node, no Discord / database / network:  node --test test/market-channels.test.js
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
const shims = {
    ws: function () {}, bson: { BSON: { serialize: () => Buffer.alloc(0), deserialize: () => ({}) } },
    axios: { get: async () => { throw new Error('no network in tests'); } },
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

// Fake database: market_alerts + market_alert_channels (+ guild_language)
const db = { alerts: new Map(), channels: [], guildLang: [], noMarketDm: false, noRoleId: false, sql: [] };
const pool = {
    async execute(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        db.sql.push(q);
        if (/^CREATE TABLE IF NOT EXISTS guild_language/.test(q)) return [[]];
        if (q === 'SELECT guild_id, lang FROM guild_language WHERE lang IS NOT NULL') return [db.guildLang.filter(r => r.lang !== null)];
        if (q === "SELECT user_id FROM market_alerts WHERE alert_target = 'server'") {
            return [[...db.alerts.values()].filter(r => r.alert_target === 'server').map(r => ({ user_id: r.user_id }))];
        }
        if (q === "SELECT user_id, market_dm FROM market_alerts WHERE alert_target = 'server' AND market_dm IS NOT NULL") {
            if (db.noMarketDm) throw new Error("Unknown column 'market_dm' in 'field list'");
            return [[...db.alerts.values()].filter(r => r.alert_target === 'server' && r.market_dm !== null && r.market_dm !== undefined)];
        }
        if (q === 'SELECT user_id, guild_id, channel_id, role_id FROM market_alert_channels ORDER BY user_id, position') {
            if (db.noRoleId) throw new Error("Unknown column 'role_id' in 'field list'");
            return [db.channels.slice().sort((a, b) => (a.user_id > b.user_id ? 1 : a.user_id < b.user_id ? -1 : a.position - b.position))];
        }
        if (q === 'SELECT user_id, guild_id, channel_id FROM market_alert_channels ORDER BY user_id, position') {
            return [db.channels.map(({ role_id, ...r }) => r)];
        }
        if (/^SHOW COLUMNS FROM market_alerts LIKE/.test(q)) return [[{ Field: 'x' }]];
        if (q === 'SELECT dm_enabled, alert_target, market_dm FROM market_alerts WHERE user_id = ?') {
            const r = db.alerts.get(params[0]);
            return [r ? [{ ...r }] : []];
        }
        if (/^INSERT INTO market_alerts \(user_id, dm_enabled, alert_target, market_dm\)/.test(q)) {
            const [user_id, dm_enabled, alert_target, market_dm] = params;
            db.alerts.set(user_id, { ...(db.alerts.get(user_id) || {}), user_id, dm_enabled, alert_target, market_dm });
            return [{ affectedRows: 1 }];
        }
        if (q === 'SELECT datacenters FROM user_datacenters WHERE user_id = ? ORDER BY (guild_id = ?) DESC LIMIT 1') return [[]];
        if (q === 'SELECT alert_interval FROM market_alerts WHERE user_id = ?') return [[]];
        throw new Error('Fake pool: unexpected SQL: ' + q);
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });
const perkUsers = new Set();
inject(path.join(ROOT, 'utils', 'membership.js'), {
    ownerHasMembership: async id => perkUsers.has(String(id)), sponsorHasPerks: async () => false, findPerksAdmin: async () => null
});
inject(path.join(ROOT, 'utils', 'retainerWatch.js'), { getWorlds: () => new Set(), load: async () => {}, hasWatches: () => false, hasPending: () => false });
inject(path.join(ROOT, 'utils', 'dmStatus.js'), { isBlocked: () => false, load: async () => {}, markOk: async () => {}, markFailed: async () => {} });

const MM = require('../utils/marketMonitor');
const marketalert = require('../commands/marketalert');
const guildLanguage = require('../utils/guildLanguage');
const userLanguage = require('../utils/userLanguage');
const { t } = require('../utils/i18n');

const U1 = '100000000000000001', U2 = '100000000000000002', U3 = '100000000000000003', U4 = '100000000000000004';
const gid = n => '9000000000000000' + String(n).padStart(2, '0');
const cid = n => '9100000000000000' + String(n).padStart(2, '0');
function chans(user, n, role) {
    for (let i = 0; i < n; i++) db.channels.push({ user_id: user, guild_id: gid(i + 1), channel_id: cid(i + 1), role_id: role || null, position: i });
}
test.beforeEach(() => { db.alerts.clear(); db.channels = []; db.guildLang = []; db.noMarketDm = false; db.noRoleId = false; perkUsers.clear(); });

// ---------- DM / channels state (website and /marketalert share the rule) ----------
test('state of a row: older rows keep what they had; new rows use the DM switch', () => {
    const s = marketalert.stateOf;
    assert.deepEqual(s(null), { dm: false, channels: false });
    assert.deepEqual(s({ dm_enabled: 1, alert_target: 'dm', market_dm: null }), { dm: true, channels: false }, 'older DM user keeps DMs on');
    assert.deepEqual(s({ dm_enabled: 1, alert_target: 'server', market_dm: null }), { dm: false, channels: true }, 'older channel user keeps channels, DMs stay off');
    assert.deepEqual(s({ dm_enabled: 0, alert_target: 'server', market_dm: null }), { dm: false, channels: false }, 'off stays off');
    assert.deepEqual(s({ dm_enabled: 1, alert_target: 'server', market_dm: 1 }), { dm: true, channels: true }, 'both');
    assert.deepEqual(s({ dm_enabled: 1, alert_target: 'dm', market_dm: 1 }), { dm: true, channels: false });
});

test('/marketalert toggles only the DM switch; server channels keep posting', async () => {
    db.alerts.set(U1, { user_id: U1, dm_enabled: 1, alert_target: 'server', market_dm: null }); // older channel user
    const calls = [];
    const i = { customId: 'marketalert_toggle_dm', isButton: () => true, user: { id: U1 }, locale: 'en-US', update: async p => calls.push(p), reply: async p => calls.push(p) };
    await marketalert.handleInteraction(i);
    assert.deepEqual(db.alerts.get(U1), { user_id: U1, dm_enabled: 1, alert_target: 'server', market_dm: 1 });
    await marketalert.handleInteraction(i);
    assert.deepEqual(db.alerts.get(U1), { user_id: U1, dm_enabled: 1, alert_target: 'server', market_dm: 0 }, 'DM off, channels still on');
    // DM-only user turning DMs off: alerts off completely
    db.alerts.set(U2, { user_id: U2, dm_enabled: 1, alert_target: 'dm', market_dm: null });
    await marketalert.handleInteraction({ ...i, user: { id: U2 } });
    assert.deepEqual(db.alerts.get(U2), { user_id: U2, dm_enabled: 0, alert_target: 'dm', market_dm: 0 });
});

// ---------- channels: limits, DM switch, older columns ----------
test('channels: 3 free, 10 with Supporter Perks (extra saved rows wait unused)', async () => {
    assert.deepEqual(MM.CHANNEL_LIMITS, { free: 3, perks: 10 });
    db.alerts.set(U1, { user_id: U1, dm_enabled: 1, alert_target: 'server', market_dm: 0 });
    db.alerts.set(U2, { user_id: U2, dm_enabled: 1, alert_target: 'server', market_dm: 0 });
    db.alerts.set(U3, { user_id: U3, dm_enabled: 1, alert_target: 'server', market_dm: 0 });
    chans(U1, 5); chans(U2, 12); chans(U3, 2);
    perkUsers.add(U2);
    await MM._test.loadTargets();
    const T = MM._test.targets();
    assert.equal(T.get(U1).length, 3, 'free user: first 3');
    assert.deepEqual(T.get(U1).map(x => x.guildId), [gid(1), gid(2), gid(3)]);
    assert.equal(T.get(U2).length, 10, 'supporter: 10');
    assert.equal(T.get(U3).length, 2);
});

test('channels: DM switch per user; older rows (no market_dm) = channels only', async () => {
    db.alerts.set(U1, { user_id: U1, dm_enabled: 1, alert_target: 'server', market_dm: 1 });   // both
    db.alerts.set(U2, { user_id: U2, dm_enabled: 1, alert_target: 'server', market_dm: 0 });   // channels only
    db.alerts.set(U3, { user_id: U3, dm_enabled: 1, alert_target: 'server', market_dm: null }); // older row
    db.alerts.set(U4, { user_id: U4, dm_enabled: 1, alert_target: 'dm', market_dm: null });     // older DM user
    chans(U1, 1); chans(U2, 1); chans(U3, 1);
    await MM._test.loadTargets();
    const off = MM._test.dmOff();
    assert.equal(off.has(U1), false);
    assert.equal(off.has(U2), true);
    assert.equal(off.has(U3), true);
    assert.equal(off.has(U4), false, 'DM users keep DMs');
    assert.equal(MM._test.targets().has(U4), false);
    // the website/bot never added the new columns yet: older behaviour
    db.noMarketDm = true; db.noRoleId = true;
    await MM._test.loadTargets();
    assert.equal(MM._test.dmOff().has(U1), true);
    assert.equal(MM._test.targets().get(U1)[0].roleId, '');
});

function fakeGuild(id, { owner = U1, admins = [], locale = 'en-US' } = {}) {
    const sent = [];
    const channel = { id: cid(1), name: 'alerts', sent, isTextBased: () => true, send: async p => { sent.push(p); return {}; } };
    return {
        id, name: 'G' + id, ownerId: owner, preferredLocale: locale, sent,
        channels: { cache: new Map([[channel.id, channel]]) },
        members: { fetch: async uid => ({ permissions: { has: () => admins.includes(uid) } }) }
    };
}
const embedsFor = async lang => [new FakeEmbed().setTitle('Item ' + lang)];

test('posting: the picked role is pinged (only that role, first message only); no role = no ping', async () => {
    const g = fakeGuild(gid(1));
    const client = { guilds: { cache: new Map([[g.id, g]]) } };
    const ROLE = '920000000000000002';
    await MM._test.postToChannels(client, U1, [{ guildId: g.id, channelId: cid(1), roleId: ROLE }], embedsFor);
    assert.equal(g.sent[0].content, '<@&' + ROLE + '>');
    assert.deepEqual(g.sent[0].allowedMentions, { parse: [], roles: [ROLE] });
    await MM._test.postToChannels(client, U1, [{ guildId: g.id, channelId: cid(1), roleId: '' }], embedsFor);
    assert.equal(g.sent[1].content, undefined);
    assert.deepEqual(g.sent[1].allowedMentions, { parse: [] });
});

test('posting: only while the user is still owner/admin; Pingway must be in the server', async () => {
    const g = fakeGuild(gid(1), { owner: U2, admins: [] });
    const client = { guilds: { cache: new Map([[g.id, g]]) } };
    const log = console.error; console.error = () => {};
    try {
        assert.equal(await MM._test.postToChannels(client, U1, [{ guildId: g.id, channelId: cid(1), roleId: '' }], embedsFor), 0);
        assert.equal(await MM._test.postToChannels(client, U1, [{ guildId: gid(9), channelId: cid(1), roleId: '' }], embedsFor), 0, 'not in that server');
    } finally { console.error = log; }
    const g2 = fakeGuild(gid(2), { owner: U2, admins: [U1] });
    const c2 = { guilds: { cache: new Map([[g2.id, g2]]) } };
    assert.equal(await MM._test.postToChannels(c2, U1, [{ guildId: g2.id, channelId: cid(1), roleId: '' }], embedsFor), 1);
});

// ---------- Server language card ----------
test('Server language card: posts use the override, else the server\'s Discord language', async () => {
    db.guildLang = [{ guild_id: gid(1), lang: 'ja' }, { guild_id: gid(2), lang: 'xx' }, { guild_id: gid(3), lang: null }];
    assert.equal(await guildLanguage.load(), 1);
    assert.ok(db.sql.some(q => /^CREATE TABLE IF NOT EXISTS guild_language \( guild_id VARCHAR\(32\) NOT NULL PRIMARY KEY, lang VARCHAR\(2\) NULL, updated_by VARCHAR\(32\) NULL, updated_at BIGINT NOT NULL DEFAULT 0 \)$/.test(q)));
    assert.equal(userLanguage.forGuild({ id: gid(1), preferredLocale: 'en-US' }), 'ja');
    assert.equal(userLanguage.forGuild({ id: gid(2), preferredLocale: 'de' }), 'de', 'invalid override ignored');
    assert.equal(userLanguage.forGuild({ id: gid(3), preferredLocale: 'fr' }), 'fr', 'automatic');
    assert.equal(userLanguage.forGuild(null), 'en');
    // market alerts posted in that server follow it too
    const g = fakeGuild(gid(1), { locale: 'en-US' });
    const client = { guilds: { cache: new Map([[g.id, g]]) } };
    await MM._test.postToChannels(client, U1, [{ guildId: g.id, channelId: cid(1), roleId: '' }], embedsFor);
    assert.equal(g.sent[0].embeds[0].data.title, 'Item ja');
    assert.equal(g.sent[0].embeds[0].data.footer.text, t('ja', 'alerts.footer'));
    // database trouble: the last known overrides stay
    const real = pool.execute;
    pool.execute = async () => { throw new Error('db down'); };
    try { await guildLanguage.load(); } finally { pool.execute = real; }
    assert.equal(userLanguage.forGuild({ id: gid(1) }), 'ja');
    db.guildLang = [];
    await guildLanguage.load();
    assert.equal(userLanguage.forGuild({ id: gid(1), preferredLocale: 'en-US' }), 'en', 'override removed on the website');
});
