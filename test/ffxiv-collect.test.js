// FFXIV Collect integration: the client (utils/ffxivCollect.js: API shapes from saved answers in test/fixtures/ffxivcollect,
// cache 6 h / manual refresh 30 min, 404 / 403 / site down, gentle queue), the verified-Main gates (/ign, /collect, PF button),
// the IGN card stats row (utils/ignCardStats.js: never on top of job icons or QR codes), /collect (check item + fuzzy
// "Did you mean", missing list order + pages, leaderboard of verified Mains in this server + 📢 Show limits) and the
// PF Mount farm (autocomplete, posted listing, check button, weekly repeat keeps the mount).
// Item lists come ONLY from the owner's local file (data/ffxivcollect-lists.json, here a copy of
// test/fixtures/ffxivcollect/ffxivcollect-lists.json in a temp folder): no list is ever requested from the internet.
// Plain node, no Discord / network / MySQL:  node --test test/ffxiv-collect.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const FX = path.join(__dirname, 'fixtures');
const fx = name => JSON.parse(fs.readFileSync(path.join(FX, 'ffxivcollect', name + '.json'), 'utf8'));

// the item lists file: a temp copy of the fixture (never data/ffxivcollect-lists.json of the bot)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pingway-collect-'));
const LISTS = path.join(TMP, 'ffxivcollect-lists.json');
const LISTS_FIXTURE = fx('ffxivcollect-lists');
const writeLists = (file, obj) => fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
writeLists(LISTS, LISTS_FIXTURE);
process.env.PINGWAY_COLLECT_LISTS_FILE = LISTS;
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* temp */ } });

// a list download is never allowed (FFXIV Collect master list paths, or any ?language= list)
const LIST_URL = /\/api\/(mounts|minions|achievements|orchestrions|emotes|hairstyles|bardings|triad\/cards)\b|[?&]language=/;
const listRequests = [];
const origFetch = global.fetch;
global.fetch = async (url, ...rest) => {
    listRequests.push(String(url));
    throw new Error('network is not allowed in this test: ' + url);
};
test.after(() => {
    global.fetch = origFetch;
    assert.deepEqual(listRequests, [], 'no fetch() at all');
    assert.deepEqual(listRequestsSeen(), [], 'no item list was ever requested');
});

// ---------- module stand-ins ----------
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}
// builders that remember what was set (data.title, data.fields, data.components ...)
const builder = () => {
    const data = {};
    const self = new Proxy({}, {
        get(_o, k) {
            if (k === 'toJSON') return () => data;
            if (k === 'data') return data;
            if (k === 'then' || typeof k !== 'string') return undefined;
            return (...args) => {
                if (k.startsWith('set')) { const f = k.slice(3); data[f.charAt(0).toLowerCase() + f.slice(1)] = args[0]; }
                else if (k.startsWith('add')) { const f = k.slice(3).toLowerCase(); data[f] = (data[f] || []).concat(args.flat()); }
                for (const a of args) if (typeof a === 'function') a(builder());
                return self;
            };
        }
    });
    return self;
};
const B = function () { return builder(); };
const PERM = { ViewChannel: 1n << 10n, SendMessages: 1n << 11n, EmbedLinks: 1n << 14n, Administrator: 1n << 3n, ManageChannels: 1n << 4n };
let axiosCalls = [];
const shims = {
    'discord.js': {
        SlashCommandBuilder: B, ActionRowBuilder: B, ButtonBuilder: B, ModalBuilder: B, TextInputBuilder: B, EmbedBuilder: B, StringSelectMenuBuilder: B,
        AttachmentBuilder: function (buf, o) { this.buf = buf; this.name = o && o.name; },
        ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 }, TextInputStyle: { Short: 1, Paragraph: 2 },
        MessageFlags: { Ephemeral: 64 }, PermissionFlagsBits: PERM
    },
    axios: { get: async (url, cfg) => { axiosCalls.push({ url, cfg }); if (LIST_URL.test(String(url))) listRequests.push(String(url)); return { status: 404, data: { status: 404, error: 'Not found' } }; } },
    cheerio: {}, qrcode: {}
};
try { require.resolve('sharp'); } catch (e) { shims.sharp = function () {}; }
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (shims[request]) return 'shim:' + request;
    return origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);

const { makeDb } = require('./fixtures/ign-fakedb');
let { db, pool } = makeDb();
const pf = { rows: [] };
const livePool = {
    execute: (...a) => pool.execute(...a), getConnection: () => pool.getConnection(),
    async query(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (/^SELECT \* FROM party_finders/.test(q)) return [pf.rows.map(r => ({ ...r }))];
        if (/^INSERT INTO party_finders/.test(q)) {
            const [id, guild_id, user_id, status, cover_image, data] = params;
            const i = pf.rows.findIndex(r => String(r.id) === String(id));
            const row = { id, guild_id, user_id, status, cover_image, data };
            if (i >= 0) pf.rows[i] = row; else pf.rows.push(row);
            return [{ affectedRows: 1 }];
        }
        if (/^UPDATE party_finders SET data = \? WHERE id = \?/.test(q)) { const r = pf.rows.find(x => String(x.id) === String(params[1])); if (r) r.data = params[0]; return [{ affectedRows: 1 }]; }
        if (/^DELETE FROM party_finders/.test(q)) { pf.rows = pf.rows.filter(r => String(r.id) !== String(params[0])); return [{}]; }
        return [[]];
    }
};
const langs = { user: 'en', guild: 'en' };
inject(path.join(ROOT, 'utils', 'db.js'), { pool: livePool });
inject(path.join(ROOT, 'utils', 'userLanguage.js'), { forInteraction: async () => langs.user, forUser: async () => langs.user, forGuild: () => langs.guild, noteLocale: async () => {} });
inject(path.join(ROOT, 'maintenance.js'), { isMaintenance: () => false });

const fc = require('../utils/ffxivCollect');
const cs = require('../utils/ignCardStats');
const C = require('../utils/ignClaims');
const { t } = require('../utils/i18n');
const collect = require('../commands/collect');
const ign = require('../commands/ign');
const pfCmd = require('../commands/pf');
const recur = require('../utils/pfRecurring');

// ---------- fake FFXIV Collect ----------
const api = { routes: {}, calls: [], delay: 0, active: 0, maxActive: 0, starts: [], listCalls: [] };
function listRequestsSeen() { return api.listCalls.concat(listRequests); }
function route(p, status, data) { api.routes[p] = { status, data }; }
fc._setHttp(async url => {
    api.calls.push(url);
    if (LIST_URL.test(String(url))) { api.listCalls.push(String(url)); return { status: 0, data: null }; }
    api.starts.push(Date.now());
    api.active++; api.maxActive = Math.max(api.maxActive, api.active);
    try {
        if (api.delay) await new Promise(r => setTimeout(r, api.delay));
        const p = url.replace(fc.BASE, '');
        const r = api.routes[p] || api.routes[p.split('?')[0]];
        if (!r) return { status: 0, data: null };
        return typeof r === 'function' ? r() : r;
    } finally { api.active--; }
});
const L = { mounts: fx('mounts-en'), mountsJa: fx('mounts-ja'), minions: fx('minions-en'), ach: fx('achievements-en'), cards: fx('cards-en') };
function standardRoutes() {
    api.routes = {};
    route('/characters/31313131?ids=1&latest=1', 200, fx('character'));
}

const U = '200000000000000001', U2 = '200000000000000002', U3 = '200000000000000003', STRANGER = '200000000000000099';
const LID = '31313131';
function reset() {
    ({ db, pool } = makeDb());
    C._reset(); fc._reset(); fc._setListsFile(LISTS); writeLists(LISTS, LISTS_FIXTURE); api.calls = []; api.starts = []; api.maxActive = 0; api.delay = 0;
    collect._.lastShow.clear(); pf.rows = []; global.pfSessions = new Map(); langs.user = 'en'; langs.guild = 'en';
    standardRoutes();
}
async function verify(uid, id) {
    const s = await C.startClaim(pool, uid, id, {});
    const html = fs.readFileSync(path.join(FX, 'lodestone-character.html'), 'utf8').replace('{{BIO}}', s.code);
    return C.checkClaim(pool, uid, s.code, { fetchPage: async () => C.parseCharacterPage(html, 200) });
}
function interaction(o) {
    const out = { replies: [], edits: [], updates: [], modals: [], deferred: null, sent: [] };
    const i = Object.assign({
        user: { id: U, tag: 'u#1' }, customId: '', guildId: null, guild: null, channel: null, locale: 'en-US', values: [],
        options: { getString: () => null, getFocused: () => '' },
        isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false, isChatInputCommand: () => false,
        fields: { getTextInputValue: () => '' },
        async reply(x) { out.replies.push(x); this.replied = true; }, async editReply(x) { out.edits.push(x); }, async update(x) { out.updates.push(x); },
        async deferReply(x) { out.deferred = x || {}; this.deferred = true; }, async deferUpdate() { out.deferred = 'update'; this.deferred = true; },
        async showModal(m) { out.modals.push(m); }, async respond(c) { out.choices = c; }, async followUp(x) { out.replies.push(x); }
    }, o);
    i.out = out;
    return i;
}
const last = arr => arr[arr.length - 1];
const embedOf = payload => payload.embeds[0].data;

// ================= client =================
test('character summary: the shapes FFXIV Collect sends (ids=1, latest=1), only public collections keep their owned ids', async () => {
    reset();
    const r = await fc.getCharacter(pool, LID, { now: 1000 });
    assert.equal(r.state, 'ok');
    assert.equal(api.calls[0], fc.BASE + '/characters/31313131?ids=1&latest=1');
    assert.equal(r.data.name, 'Mira Starfall');
    assert.deepEqual(r.data.c.mounts, { count: 5, total: 380, public: true, ids: [1, 9, 42, 150, 240] });
    assert.deepEqual([r.data.c.achievements.points, r.data.c.achievements.pointsTotal, r.data.c.achievements.public], [30, 38000, true]);
    assert.equal(fc.owns(r.data, 'mounts', 42), true);
    assert.equal(fc.owns(r.data, 'mounts', 71), false);
    // achievements hidden on the Lodestone / a private collection: counts 0, ids dropped -> "can't tell"
    reset();
    route('/characters/31313131?ids=1&latest=1', 200, fx('character-hidden'));
    const h = await fc.getCharacter(pool, LID, { now: 1000 });
    assert.deepEqual([h.data.c.achievements.count, h.data.c.achievements.public, h.data.c.achievements.ids], [0, false, null]);
    assert.equal(fc.owns(h.data, 'minions', 1), null);
    assert.equal(fc.statValue(h.data, 'achievements'), null);
});

test('the real HTTP call: User-Agent "Pingway (FFXIV Discord bot)", timeout, JSON', async () => {
    reset();
    fc._setHttp(null); // the default (axios, stubbed here)
    axiosCalls = [];
    const r = await fc.getCharacter(pool, '42', { now: 5 });
    assert.equal(r.state, 'notfound');
    assert.equal(axiosCalls[0].url, 'https://ffxivcollect.com/api/characters/42?ids=1&latest=1');
    assert.equal(axiosCalls[0].cfg.headers['User-Agent'], 'Pingway (FFXIV Discord bot)');
    assert.equal(axiosCalls[0].cfg.timeout, 10000);
    fc._setHttp(async url => { api.calls.push(url); if (LIST_URL.test(String(url))) { api.listCalls.push(String(url)); return { status: 0, data: null }; } const p = url.replace(fc.BASE, ''); const x = api.routes[p] || api.routes[p.split('?')[0]]; return x || { status: 0, data: null }; });
});

test('cache: kept 6 hours (no new request), then asked again; manual refresh at most every 30 minutes', async () => {
    reset();
    const H = 3600000;
    await fc.getCharacter(pool, LID, { now: 0 });
    await fc.getCharacter(pool, LID, { now: 5 * H });
    assert.equal(api.calls.length, 1, 'cached');
    assert.equal(db.fcChars.get(LID).status, 'ok');
    await fc.getCharacter(pool, LID, { now: 6 * H + 1 });
    assert.equal(api.calls.length, 2, 'older than 6 h -> asked again');
    // manual
    const m1 = await fc.getCharacter(pool, LID, { force: true, now: 6 * H + 2 });
    assert.equal(m1.state, 'ok');
    assert.equal(api.calls.length, 3);
    const m2 = await fc.getCharacter(pool, LID, { force: true, now: 6 * H + 2 + 10 * 60000 });
    assert.equal(m2.state, 'limited');
    assert.equal(m2.waitMin, 20);
    assert.equal(m2.saved.data.name, 'Mira Starfall', 'the saved data is still shown');
    assert.equal(api.calls.length, 3, 'no request');
    const m3 = await fc.getCharacter(pool, LID, { force: true, now: 6 * H + 2 + 30 * 60000 });
    assert.equal(m3.state, 'ok');
    assert.equal(api.calls.length, 4);
});

test('404 = not on FFXIV Collect yet, 403 = private (asked again after 30 min), site down = last saved data + note', async () => {
    reset();
    route('/characters/31313131?ids=1&latest=1', 404, { status: 404, error: 'Not found' });
    assert.equal((await fc.getCharacter(pool, LID, { now: 0 })).state, 'notfound');
    assert.equal((await fc.getCharacter(pool, LID, { now: 60000 })).state, 'notfound');
    assert.equal(api.calls.length, 1, 'not asked again right away');
    route('/characters/31313131?ids=1&latest=1', 403, { status: 403, error: 'Character is set to private' });
    assert.equal((await fc.getCharacter(pool, LID, { now: 31 * 60000 })).state, 'private');
    // the 🔄 Refresh asks right away (after "search for your character once on ffxivcollect.com")
    route('/characters/31313131?ids=1&latest=1', 200, fx('character'));
    assert.equal((await fc.getCharacter(pool, LID, { now: 32 * 60000, force: true })).state, 'ok');
    // down: saved data with stale
    route('/characters/31313131?ids=1&latest=1', 500, { status: 500, error: 'Server error' });
    const d = await fc.getCharacter(pool, LID, { now: 10 * 3600000 });
    assert.deepEqual([d.state, d.stale, d.data.name], ['ok', true, 'Mira Starfall']);
    // down and nothing saved
    reset();
    delete api.routes['/characters/31313131?ids=1&latest=1'];
    assert.equal((await fc.getCharacter(pool, LID, { now: 0 })).state, 'down');
});

test('item lists: read from the local file only (never downloaded), slim items, a language not in the file -> English', async () => {
    reset();
    const ja = await fc.getList(pool, 'mounts', 'ja', { now: 0 });
    assert.equal(ja.find(m => m.id === 71).name, 'デブチョコボ');
    assert.deepEqual(Object.keys(ja[0]).sort(), ['icon', 'id', 'name', 'owned', 'sources']);
    assert.equal(ja.find(m => m.id === 104).owned, 3.4);
    assert.equal(ja.notLoaded, undefined);
    const minions = await fc.getList(pool, 'minions', 'en', { now: 0 });
    assert.deepEqual(minions.map(m => m.id), [1, 2, 3]);
    const ach = await fc.getList(pool, 'achievements', 'en', { now: 0 });
    assert.deepEqual([ach[1].desc, ach[1].points], ['Complete 100 Gold Saucer events.', 20]);
    const cards = await fc.getList(pool, 'cards', 'en', { now: 0 });
    assert.equal(cards[2].name, 'Bahamut');
    // fr / de are not in the file, ja has only mounts: English for the rest
    assert.equal((await fc.getList(pool, 'mounts', 'fr', { now: 0 })).find(m => m.id === 71).name, 'Fat Chocobo');
    assert.equal((await fc.getList(pool, 'cards', 'ja', { now: 0 }))[2].name, 'Bahamut');
    assert.equal((await fc.getList(pool, 'mounts', 'xx', { now: 0 })).find(m => m.id === 71).name, 'Fat Chocobo', 'unknown language -> en');
    assert.deepEqual(await fc.getList(pool, 'nope', 'en', { now: 0 }), []);
    assert.equal(await fc.listsReady({ now: 0 }), true);
    assert.equal(api.calls.length, 0, 'no request at all for lists');
    assert.deepEqual(listRequestsSeen(), []);
    assert.equal(fc.LISTS_FILE, LISTS, 'path from the env (tests only)');
    assert.equal(path.basename(fc.LISTS_FILE), 'ffxivcollect-lists.json');
    // the real default path is <bot root>/data/ffxivcollect-lists.json (like data/trivia_bank.json)
    assert.match(fs.readFileSync(path.join(ROOT, 'utils', 'ffxivCollect.js'), 'utf8'), /path\.join\(__dirname, '\.\.', 'data', 'ffxivcollect-lists\.json'\)/);
    await fc.ensureTables(pool);
    assert.ok(!db.log.some(x => /ffxiv_collect_lists/.test(x.sql)), 'the old lists table is not used (not even CREATE)');
});

test('item lists: no file / a broken file -> [] with notLoaded; checked again at most once a minute; replaced file read again (mtime)', async () => {
    reset();
    fs.rmSync(LISTS);
    const none = await fc.getList(pool, 'mounts', 'en', { now: 0 });
    assert.deepEqual([none.length, none.notLoaded], [0, true]);
    assert.equal(await fc.listsReady({ now: 1 }), false);
    // the owner puts the file in: seen after the next check (60 s)
    writeLists(LISTS, LISTS_FIXTURE);
    assert.equal((await fc.getList(pool, 'mounts', 'en', { now: 30000 })).notLoaded, true, 'not looked at again yet');
    const ok = await fc.getList(pool, 'mounts', 'en', { now: fc.LISTS_CHECK_MS + 1 });
    assert.equal(ok.length, 12);
    assert.equal(ok.notLoaded, undefined);
    // the owner replaces the file (new mtime): read again without a restart
    const next = JSON.parse(JSON.stringify(LISTS_FIXTURE));
    next.langs.en.mounts.push({ id: 5000, name: 'Brand New Mount', icon: 'https://x.test/5000.png', owned: 0.1, sources: [] });
    writeLists(LISTS, next);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(LISTS, later, later);
    assert.equal((await fc.getList(pool, 'mounts', 'en', { now: fc.LISTS_CHECK_MS + 2 })).length, 12, 'still the copy in memory');
    assert.equal((await fc.getList(pool, 'mounts', 'en', { now: 2 * fc.LISTS_CHECK_MS + 2 })).length, 13);
    // the same file (same mtime): not read again (the copy in memory is kept)
    const before = await fc.getList(pool, 'mounts', 'en', { now: 2 * fc.LISTS_CHECK_MS + 3 });
    assert.equal(await fc.getList(pool, 'mounts', 'en', { now: 4 * fc.LISTS_CHECK_MS }), before);
    // broken file / wrong format -> notLoaded
    for (const bad of ['{ not json', JSON.stringify({ format: 'other', langs: { en: { mounts: [] } } }), JSON.stringify({ format: 'pingway-collect-1', langs: [] }), JSON.stringify({ format: 'pingway-collect-1', langs: { en: { mounts: 'x' } } })]) {
        fc._setListsFile(LISTS);
        writeLists(LISTS, bad);
        const r = await fc.getList(pool, 'mounts', 'en', { now: 0 });
        assert.deepEqual([r.length, r.notLoaded], [0, true], bad);
    }
    assert.equal(api.calls.length, 0);
});

test('item lists: validation drops bad items (ids, names, owned, sources, http icons -> null, duplicates), keeps the good ones', () => {
    const good = { id: 7, name: 'Good', icon: 'https://x.test/7.png', owned: 12.3, sources: [{ type: 'Quest', text: 'Do it' }] };
    const parsed = fc.parseListsFile({ format: 'pingway-collect-1', builtAt: '2026-11-11T00:00:00Z', langs: {
        en: {
            mounts: [good, { ...good }, { ...good, id: '8' }, { ...good, id: 0 }, { ...good, id: 1.5 }, { ...good, id: 9, name: '' }, { ...good, id: 10, name: 5 },
                { ...good, id: 11, owned: '12%' }, { ...good, id: 12, owned: 101 }, { ...good, id: 13, sources: 'x' }, null, 'x', [1],
                { id: 14, name: 'Http icon', icon: 'http://x.test/14.png', owned: 1, extra: 'dropped field',
                    sources: [{ type: 'A', text: 'a' }, null, { type: 1, text: 'b' }, { type: 'C' }, { type: 'D', text: 'd' }, { type: 'E', text: 'e' }] }],
            achievements: [{ id: 1, name: 'Ach', icon: 'javascript:alert(1)', owned: 50, desc: 'x'.repeat(400), points: '10' }],
            minions: 'not a list'
        },
        de: 'nope'
    } });
    assert.deepEqual(parsed.langs.en.mounts.map(m => m.id), [7, 14]);
    const m14 = parsed.langs.en.mounts[1];
    assert.equal(m14.icon, null, 'https icons only');
    assert.deepEqual(Object.keys(m14).sort(), ['icon', 'id', 'name', 'owned', 'sources']);
    assert.deepEqual(m14.sources, [{ type: 'A', text: 'a' }, { type: '', text: 'b' }, { type: 'C', text: '' }, { type: 'D', text: 'd' }], 'max 4, strings only');
    const a = parsed.langs.en.achievements[0];
    assert.deepEqual([a.icon, a.desc.length, a.points], [null, 300, 0]);
    assert.equal(parsed.langs.en.minions, undefined);
    assert.equal(parsed.langs.de, undefined);
    assert.equal(parsed.dropped, 12);
    assert.equal(fc.parseListsFile({ format: 'pingway-collect-1', langs: {} }), null, 'nothing usable');
    assert.equal(fc.parseListsFile(null), null);
});

test('no lists file: /collect Check + Missing + pick say so (ephemeral panel), Leaderboard and IGN stats still work, PF autocomplete empty, PF check answers by id', async () => {
    reset();
    await verify(U, LID);
    fs.rmSync(LISTS);
    fc._setListsFile(LISTS);
    const msg = t('en', 'collect.listsMissing');
    assert.equal(msg, "📚 The item list isn't loaded yet, so this can't be checked right now. Please try again later.");
    for (const l of ['fr', 'de', 'ja']) assert.ok(t(l, 'collect.listsMissing') && t(l, 'collect.listsMissing') !== msg, l);
    // Check item
    const m = interaction({ customId: 'collect_checkm_' + U, isButton: () => false, isModalSubmit: () => true, fields: { getTextInputValue: () => 'Fat Chocobo' } });
    await collect.handleInteraction(m);
    assert.equal(embedOf(last(m.out.edits)).description, msg);
    assert.equal(m.out.deferred, 'update', 'inside the ephemeral panel');
    // Missing
    const sel = interaction({ customId: 'collect_misscat_' + U, isButton: () => false, isStringSelectMenu: () => true, values: ['mounts'] });
    await collect.handleInteraction(sel);
    assert.equal(embedOf(last(sel.out.edits)).description, msg);
    // pick from an old "Did you mean" menu
    const pick = interaction({ customId: 'collect_pick_' + U, isButton: () => false, isStringSelectMenu: () => true, values: ['mounts:71'] });
    await collect.handleInteraction(pick);
    assert.equal(embedOf(last(pick.out.edits)).description, msg);
    // Leaderboard: character counts only
    const g = fakeGuild([U], []);
    const lb = await collect._.leaderboard(pool, g.guild, 'mounts', { refresh: false });
    assert.deepEqual(lb.rows.map(r => [r.userId, r.value]), [[U, 5]]);
    // IGN card stats: counts only
    assert.deepEqual((await ign.collectStatsFor(U, LID)).map(x => x.key + ':' + x.text), ['mounts:5/380', 'minions:2/520', 'achievements:30 pts']);
    // PF autocomplete: empty list
    const ac = interaction({ locale: 'en-US', options: { getFocused: () => 'Fat' } });
    await pfCmd.autocomplete(ac);
    assert.deepEqual(ac.out.choices, []);
    // /pf mount:<typed> -> the friendly note instead of "No mount found"
    const ex = interaction({ isChatInputCommand: () => true, options: { getString: n => (n === 'mount' ? 'Fat Chocobo' : null) } });
    await pfCmd.execute(ex);
    assert.ok(last(ex.out.edits).content.includes(msg));
    // PF "Check if you have it": answered by id, the saved name, no rarity / source
    pf.rows.push({ id: '999', guild_id: 'g1', user_id: U2, status: 'active', data: JSON.stringify({ id: '999', userId: U2, guildId: 'g1', name: 'Farm', size: 8, date: '2030-01-01 20:00 GMT+9', claims: {}, mount: { id: 42, name: 'Midgardsormr' } }) });
    let c = interaction({ customId: 'pf_mcheck_999' });
    await pfCmd.handleInteraction(c);
    let e = last(c.out.edits).embeds[0].data;
    assert.match(e.description, /✅ You already have \*\*Midgardsormr\*\*!/);
    assert.ok(!/players have it|📍/.test(e.description), 'no rarity / source');
    pf.rows[0].data = JSON.stringify(Object.assign(JSON.parse(pf.rows[0].data), { mount: { id: 104 } }));
    c = interaction({ customId: 'pf_mcheck_999' });
    await pfCmd.handleInteraction(c);
    e = last(c.out.edits).embeds[0].data;
    assert.match(e.description, /❌ You still need \*\*#104\*\*/, 'no saved name: still answered by id');
    assert.deepEqual(listRequestsSeen(), []);
});

test('gentle: at most 2 requests at the same time, starts spaced out', async () => {
    reset();
    api.delay = 60;
    const ids = ['101', '102', '103', '104', '105'];
    for (const id of ids) route('/characters/' + id + '?ids=1&latest=1', 200, Object.assign(fx('character'), { id: Number(id) }));
    await Promise.all(ids.map(id => fc.getCharacter(pool, id)));
    assert.equal(api.calls.length, 5);
    assert.ok(api.maxActive <= fc.MAX_PARALLEL, 'max ' + api.maxActive);
    const s = api.starts.slice().sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) assert.ok(s[i] - s[i - 1] >= fc.SPACING_MS - 20, 'spacing ' + (s[i] - s[i - 1]));
});

// ================= search =================
test('search: exact (any case), typos, Japanese, English fallback; unsure -> several suggestions', async () => {
    reset();
    const src = async lang => [{ collection: 'mounts', items: await fc.getList(pool, 'mounts', lang), en: await fc.getList(pool, 'mounts', 'en') },
        { collection: 'cards', items: await fc.getList(pool, 'cards', lang), en: await fc.getList(pool, 'cards', 'en') }];
    let r = fc.search('fat chocobo', await src('en'));
    assert.equal(r[0].item.id, 71);
    assert.ok(fc.isConfident(r));
    r = fc.search('Midgardsorm', await src('en'));
    assert.equal(r[0].item.name, 'Midgardsormr');
    assert.ok(fc.isConfident(r), 'one letter missing');
    r = fc.search('Fenrri', await src('en'));
    assert.equal(r[0].item.name, 'Fenrir');
    r = fc.search('デブチョコボ', await src('ja'));
    assert.deepEqual([r[0].item.id, r[0].item.name], [71, 'デブチョコボ']);
    assert.ok(fc.isConfident(r));
    r = fc.search('Fat Chocobo', await src('ja'));
    assert.deepEqual([r[0].item.id, r[0].item.name], [71, 'デブチョコボ'], 'English name works in Japanese too, shown in Japanese');
    r = fc.search('chocobo', await src('en'));
    assert.ok(r.length >= 3 && !fc.isConfident(r), 'several chocobos -> Did you mean');
    assert.equal(fc.search('zzzzqqqq', await src('en')).length, 0);
});

// ================= verified Main gates =================
test('verified Main needed: /ign (older not verified card), /collect, PF "Check if you have it" -> the verify message', async () => {
    reset();
    db.config.set(U, { user_id: U, lodestone_id: LID, main_job: 'Dancer', portrait_toggle: 1 }); // older card, migrated as not verified
    const msg = t('en', 'ign.needVerified');
    assert.match(msg, /verified character first[\s\S]*\/ignconfig[\s\S]*pingway-[\s\S]*✅ Verify[\s\S]*My Settings → IGN/);
    for (const l of ['fr', 'de', 'ja']) assert.notEqual(t(l, 'ign.needVerified'), msg, l);
    const i1 = interaction({ isChatInputCommand: () => true });
    await ign.execute(i1);
    assert.equal(i1.out.replies[0].content, msg);
    assert.deepEqual(i1.out.replies[0].flags, [64], 'ephemeral');
    assert.equal(i1.out.deferred, null, 'no card made');
    const i2 = interaction({ isChatInputCommand: () => true });
    await collect.execute(i2);
    assert.equal(i2.out.replies[0].content, msg);
    pf.rows.push({ id: '777', guild_id: '1', user_id: U2, status: 'active', data: JSON.stringify({ id: '777', userId: U2, guildId: '1', name: 'Farm', size: 8, date: '2030-01-01 20:00 GMT+9', mount: { id: 71, name: 'Fat Chocobo' } }) });
    const i3 = interaction({ customId: 'pf_mcheck_777' });
    await pfCmd.handleInteraction(i3);
    assert.equal(i3.out.replies[0].content, msg);
    // once verified: /ign goes on (deferred, public card)
    await verify(U, LID);
    assert.ok((await fc.verifiedMain(pool, U)).claim_key);
});

// ================= IGN card stats row =================
test('card stats: all on/off combinations x QR codes x big numbers: inside the Jobs panel, never on a job icon / level or QR code', () => {
    const data = { c: {} };
    for (const k of fc.CARD_STATS) data.c[k] = { count: 1234, total: 1500, points: 123456, pointsTotal: 150000, public: true };
    const jobs = cs.jobBoxes();
    let drawn = 0;
    for (let mask = 0; mask < 32; mask++) {
        const tog = {};
        fc.CARD_STATS.forEach((k, i) => { tog[k] = !!(mask & (1 << i)); });
        const items = cs.itemsFor(data, tog);
        assert.equal(items.length, Object.values(tog).filter(Boolean).length);
        for (const [tm, ff] of [[false, false], [true, false], [false, true], [true, true]]) {
            const l = cs.layout(items, { hasTomestone: tm, hasFFLogs: ff });
            assert.deepEqual(l.dropped, [], 'everything fits (2 lines max) mask ' + mask);
            const blocks = [...jobs, ...cs.qrBoxes(tm, ff)];
            const boxes = l.credit ? [...l.boxes, l.credit] : l.boxes;
            for (const b of boxes) {
                assert.ok(b.x0 >= cs.PANEL.x0 && b.x1 <= cs.PANEL.x1 && b.y0 >= cs.PANEL.y0 && b.y1 <= cs.PANEL.y1, 'inside the panel ' + JSON.stringify(b));
                for (const j of blocks) assert.ok(!cs.overlaps(b, j), 'mask ' + mask + ' qr ' + tm + ff + ': ' + JSON.stringify(b) + ' on ' + JSON.stringify(j));
            }
            for (let a = 0; a < l.boxes.length; a++) for (let c = a + 1; c < l.boxes.length; c++) assert.ok(!cs.overlaps(l.boxes[a], l.boxes[c]), 'stats overlap');
            assert.ok(new Set(l.boxes.map(b => b.baseline)).size <= 2);
            drawn += l.boxes.length;
        }
    }
    assert.ok(drawn > 0);
    // more than fits -> left out, never squeezed on top of something
    const many = Array.from({ length: 12 }, (_, i) => ({ key: 'mounts', text: '12,345/12,345' + i }));
    const l = cs.layout(many, { hasTomestone: true, hasFFLogs: true });
    assert.ok(l.dropped.length > 0 && l.boxes.every(b => b.x1 <= l.right));
    // the SVG says where the data is from
    assert.match(cs.svg(cs.layout(cs.itemsFor(data, fc.STAT_DEFAULTS), {})), /Data by FFXIV Collect/);
    assert.equal(cs.svg(cs.layout([], {})).includes('Data by'), false, 'no stats -> no credit');
});

test('card stats: defaults (Mounts, Minions, Achievement points), the character switches, hidden achievements left out, not on FFXIV Collect = no row', async () => {
    reset();
    await verify(U, LID);
    assert.deepEqual(await fc.readStatToggles(pool, U, LID), { mounts: true, minions: true, achievements: true, orchestrions: false, cards: false });
    let items = await ign.collectStatsFor(U, LID);
    assert.deepEqual(items.map(x => x.key + ':' + x.text), ['mounts:5/380', 'minions:2/520', 'achievements:30 pts']);
    const row = db.chars.find(r => r.lodestone_id === LID);
    Object.assign(row, { cs_mounts: 0, cs_cards: 1, cs_orchestrions: 1 });
    items = await ign.collectStatsFor(U, LID);
    assert.deepEqual(items.map(x => x.key), ['minions', 'achievements', 'orchestrions', 'cards']);
    Object.assign(row, { cs_mounts: 0, cs_minions: 0, cs_achievements: 0, cs_orchestrions: 0, cs_cards: 0 });
    const n = api.calls.length;
    assert.equal(await ign.collectStatsFor(U, LID), null, 'all off');
    assert.equal(api.calls.length, n, 'all off: FFXIV Collect is not asked');
    reset();
    await verify(U, LID);
    route('/characters/31313131?ids=1&latest=1', 200, fx('character-hidden'));
    assert.deepEqual((await ign.collectStatsFor(U, LID)).map(x => x.key), ['mounts'], 'hidden achievements / private minions left out');
    reset();
    await verify(U, LID);
    route('/characters/31313131?ids=1&latest=1', 404, { status: 404 });
    assert.equal(await ign.collectStatsFor(U, LID), null);
    assert.ok(db.cols.has('ign_characters.cs_mounts'), 'additive column');
});

// ================= /collect =================
async function openPanel(uid = U) {
    const i = interaction({ user: { id: uid }, isChatInputCommand: () => true });
    await collect.execute(i);
    return i;
}
test('/collect: ephemeral panel with Main + world + last sync, 4 buttons with stateless ids; only the opener can use them', async () => {
    reset();
    await verify(U, LID);
    const i = await openPanel();
    assert.deepEqual(i.out.deferred.flags, [64]);
    const p = last(i.out.edits);
    const e = embedOf(p);
    assert.equal(e.title, '📚 Mira Starfall — Gilgamesh [Aether]');
    assert.match(e.description, /🐎 \*\*Mounts:\*\* 5 \/ 380/);
    assert.match(e.description, /🏆 \*\*Achievements:\*\* 2 \/ 3,310 · 30 pts/);
    assert.match(e.description, /Last sync: <t:\d+:R>/);
    assert.equal(e.footer.text, 'Data by FFXIV Collect');
    const ids = p.components[0].data.components.map(b => b.data.customId);
    assert.deepEqual(ids, ['check', 'missing', 'lb', 'refresh'].map(a => 'collect_' + a + '_' + U));
    for (const id of ids) assert.ok(!/release|warp/.test(id) && !/^(btn_|select_|pf_|ign_)/.test(id), 'no other router catches ' + id);
    const other = interaction({ user: { id: STRANGER }, customId: 'collect_missing_' + U });
    await collect.handleInteraction(other);
    assert.equal(other.out.replies[0].content, t('en', 'collect.onlyOwner'));
    assert.deepEqual(other.out.replies[0].flags, [64]);
    // after a restart: the same id still works (nothing kept in memory)
    const again = interaction({ customId: 'collect_home_' + U });
    await collect.handleInteraction(again);
    assert.equal(embedOf(last(again.out.edits)).title, '📚 Mira Starfall — Gilgamesh [Aether]');
    // not on FFXIV Collect yet
    reset();
    await verify(U, LID);
    route('/characters/31313131?ids=1&latest=1', 404, {});
    const nf = await openPanel();
    assert.match(embedOf(last(nf.out.edits)).description, /isn't on FFXIV Collect yet\. Search for your character once on \[ffxivcollect\.com\]/);
    // achievements hidden on the Lodestone
    reset();
    await verify(U, LID);
    route('/characters/31313131?ids=1&latest=1', 200, fx('character-hidden'));
    const hid = await openPanel();
    assert.match(embedOf(last(hid.out.edits)).description, /achievements are hidden on the Lodestone/);
});

test('/collect 🔎 Check item: modal -> ✅ / ❌ with rarity, how to get it and icon; unsure -> "Did you mean" menu -> pick', async () => {
    reset();
    await verify(U, LID);
    const b = interaction({ customId: 'collect_check_' + U });
    await collect.handleInteraction(b);
    assert.equal(b.out.modals[0].data.customId, 'collect_checkm_' + U);
    const ask = async q => {
        const m = interaction({ customId: 'collect_checkm_' + U, isButton: () => false, isModalSubmit: () => true, fields: { getTextInputValue: () => q } });
        await collect.handleInteraction(m);
        assert.equal(m.out.deferred, 'update');
        return last(m.out.edits);
    };
    let p = await ask('midgardsormr');
    let e = embedOf(p);
    assert.equal(e.description, t('en', 'collect.have'));
    assert.equal(e.thumbnail, L.mounts.results.find(x => x.id === 42).icon);
    assert.deepEqual(e.fields.map(f => f.value).slice(0, 2), ['Mounts', '40.1% of FFXIV Collect players have it']);
    assert.match(e.fields[2].value, /Achievement: Heavensward Hunt Mastery/);
    p = await ask('Fenrir');
    assert.equal(embedOf(p).description, t('en', 'collect.haveNot'));
    // a typo with one possible match: asked to confirm
    p = await ask('Fenrri');
    assert.match(embedOf(p).description, /Do you mean:[\s\S]*Fenrir/);
    p = await ask('Bahamut');
    assert.equal(embedOf(p).fields[0].value, 'Triple Triad cards');
    p = await ask('wood you believe it');
    assert.match(embedOf(p).fields.map(f => f.value).join('|'), /Complete 100 Gold Saucer events\.\|?/);
    p = await ask('chocobo');
    assert.match(embedOf(p).description, /No exact match for \*\*chocobo\*\*/);
    const menu = p.components[0].data.components[0].data;
    assert.equal(menu.customId, 'collect_pick_' + U);
    assert.ok(menu.options.length >= 3 && menu.options.length <= 10);
    assert.ok(menu.options.some(o => o.value === 'mounts:71'));
    const pick = interaction({ customId: 'collect_pick_' + U, isButton: () => false, isStringSelectMenu: () => true, values: ['mounts:71'] });
    await collect.handleInteraction(pick);
    assert.equal(embedOf(last(pick.out.edits)).title, '🐎 Fat Chocobo');
    p = await ask('qqqqzzzz');
    assert.match(embedOf(p).description, /No mount, minion/);
    // Japanese
    langs.user = 'ja';
    p = await ask('デブチョコボ');
    assert.equal(embedOf(p).title, '🐎 デブチョコボ');
    assert.equal(embedOf(p).description, t('ja', 'collect.haveNot'));
});

test('/collect 📋 Missing: category menu, easiest first (most players have it), 10 per page with ◀ ▶', async () => {
    reset();
    await verify(U, LID);
    const big = JSON.parse(JSON.stringify(LISTS_FIXTURE));
    for (let i = 0; i < 25; i++) big.langs.en.mounts.push(Object.assign({}, big.langs.en.mounts[0], { id: 1000 + i, name: 'Extra Mount ' + i, owned: 50 - i }));
    const bigFile = path.join(TMP, 'big-lists.json');
    writeLists(bigFile, big);
    fc._setListsFile(bigFile);
    const m = interaction({ customId: 'collect_missing_' + U });
    await collect.handleInteraction(m);
    assert.equal(last(m.out.edits).components[0].data.components[0].data.customId, 'collect_misscat_' + U);
    const sel = interaction({ customId: 'collect_misscat_' + U, isButton: () => false, isStringSelectMenu: () => true, values: ['mounts'] });
    await collect.handleInteraction(sel);
    let p = last(sel.out.edits);
    const e = embedOf(p);
    // owned: 1, 9, 42, 150, 240 -> 37 total - 5 owned = 32 missing
    assert.equal(e.title, '📋 Missing Mounts (32)');
    const pcts = [...e.description.matchAll(/— ([\d.]+)%/g)].map(x => Number(x[1]));
    assert.equal(pcts.length, 10);
    assert.deepEqual(pcts, pcts.slice().sort((a, b) => b - a), 'easiest first');
    assert.ok(!/Magitek Armor|Midgardsormr/.test(e.description), 'owned ones are not listed');
    assert.equal(e.footer.text, 'Page 1/4 · Data by FFXIV Collect');
    const nav = p.components[1].data.components.map(c => c.data);
    assert.deepEqual([nav[0].customId, nav[0].disabled, nav[1].customId, nav[1].disabled], ['collect_mpage_' + U + '_mounts_-1', true, 'collect_mpage_' + U + '_mounts_1', false]);
    const pg = interaction({ customId: 'collect_mpage_' + U + '_mounts_3' });
    await collect.handleInteraction(pg);
    p = last(pg.out.edits);
    assert.equal(embedOf(p).footer.text, 'Page 4/4 · Data by FFXIV Collect');
    assert.match(embedOf(p).description, /^\*\*31\.\*\*/);
    assert.equal(p.components[1].data.components[1].data.disabled, true);
    // whole list order over all pages
    const all = fc.missing((await fc.getCharacter(pool, LID)).data, 'mounts', await fc.getList(pool, 'mounts', 'en'));
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].owned >= all[i].owned);
    // a private collection
    const minions = interaction({ customId: 'collect_misscat_' + U, isButton: () => false, isStringSelectMenu: () => true, values: ['minions'] });
    route('/characters/31313131?ids=1&latest=1', 200, fx('character-hidden'));
    fc._reset();
    db.fcChars.clear();
    await collect.handleInteraction(minions);
    assert.equal(embedOf(last(minions.out.edits)).description, t('en', 'collect.missingHidden'));
});

function fakeGuild(memberIds, perms) {
    const me = { id: 'bot' };
    return {
        guild: { id: 'g1', members: { me, cache: new Map(), fetch: async ({ user }) => new Map(user.filter(u => memberIds.includes(u)).map(u => [u, { id: u }])) } },
        channel: { id: 'c1', sent: [], permissionsFor: () => ({ has: p => perms.includes(p) }), async send(x) { this.sent.push(x); return { id: 'm1' }; } }
    };
}
test('/collect 🏆 Leaderboard: only verified Mains of this server, from saved data; stale members refreshed in the background', async () => {
    reset();
    await verify(U, LID);
    await verify(U2, '5001');
    await verify(U3, '6001');
    db.config.set(STRANGER, { user_id: STRANGER, lodestone_id: '7001', portrait_toggle: 1 });
    await C.migrateUser(pool, STRANGER); // not verified: never listed
    const now = Date.now();
    const save = (id, mounts, points, at) => db.fcChars.set(id, { lodestone_id: id, status: 'ok', fetched_at: at, checked_at: at, manual_at: null,
        data: JSON.stringify({ id, name: 'N' + id, server: 'W', c: { mounts: { count: mounts, total: 380, public: true, ids: [] }, achievements: { count: 1, total: 9, points, pointsTotal: 99, public: true, ids: [] } } }) });
    save(LID, 5, 30, now);
    save('5001', 200, 9000, now - 7 * 3600000); // older than 6 h: still shown, refreshed in the background
    save('6001', 300, 100, now);
    save('7001', 999, 99999, now);
    const g = fakeGuild([U, U2, STRANGER], []); // U3 is not in this server
    const c5001 = Object.assign(fx('character'), { id: 5001 });
    c5001.mounts.count = 250;
    route('/characters/5001?ids=1&latest=1', 200, c5001);
    const lb = await collect._.leaderboard(pool, g.guild, 'mounts', { now });
    assert.deepEqual(lb.rows.map(r => [r.userId, r.value]), [[U2, 200], [U, 5]]);
    const ach = await collect._.leaderboard(pool, g.guild, 'achievements', { now, refresh: false });
    assert.deepEqual(ach.rows.map(r => [r.userId, r.value]), [[U2, 9000], [U, 30]]);
    await new Promise(r => setTimeout(r, fc.SPACING_MS + 50));
    assert.ok(api.calls.some(c => c.includes('/characters/5001')), 'stale member refreshed lazily');
    assert.ok(!api.calls.some(c => c.includes('/characters/7001') || c.includes('/characters/6001')));
    // the panel view: category menu + 📢 Show
    const v = interaction({ customId: 'collect_lb_' + U, guild: g.guild, channel: g.channel });
    await collect.handleInteraction(v);
    const p = last(v.out.edits);
    assert.match(embedOf(p).title, /Top collectors — 🐎 Mounts/);
    assert.match(embedOf(p).description, /🥇 <@200000000000000002>/);
    assert.equal(p.components[1].data.components[0].data.customId, 'collect_lbshow_' + U + '_mounts');
    const pickAch = interaction({ customId: 'collect_lbcat_' + U, guild: g.guild, channel: g.channel, isButton: () => false, isStringSelectMenu: () => true, values: ['achievements'] });
    await collect.handleInteraction(pickAch);
    assert.match(embedOf(last(pickAch.out.edits)).title, /Achievement points/);
});

test('/collect 📢 Show: posts publicly (no pings), needs View/Send/Embed in the channel, once a minute per channel', async () => {
    reset();
    await verify(U, LID);
    db.fcChars.set(LID, { lodestone_id: LID, status: 'ok', fetched_at: Date.now(), checked_at: Date.now(), manual_at: null, data: JSON.stringify(fc.slimCharacter(fx('character'))) });
    const noPerm = fakeGuild([U], [PERM.ViewChannel, PERM.SendMessages]);
    let s = interaction({ customId: 'collect_lbshow_' + U + '_mounts', guild: noPerm.guild, channel: noPerm.channel });
    await collect.handleInteraction(s);
    assert.equal(s.out.replies[0].content, t('en', 'collect.showNoPerm'));
    assert.equal(noPerm.channel.sent.length, 0);
    const g = fakeGuild([U], [PERM.ViewChannel, PERM.SendMessages, PERM.EmbedLinks]);
    s = interaction({ customId: 'collect_lbshow_' + U + '_mounts', guild: g.guild, channel: g.channel });
    await collect.handleInteraction(s);
    assert.equal(g.channel.sent.length, 1);
    assert.deepEqual(g.channel.sent[0].allowedMentions, { parse: [] });
    assert.match(g.channel.sent[0].embeds[0].data.description, /Shared by <@200000000000000001>/);
    assert.match(g.channel.sent[0].embeds[0].data.footer.text, /Data by FFXIV Collect/);
    assert.equal(last(s.out.edits).content, t('en', 'collect.showDone'));
    s = interaction({ customId: 'collect_lbshow_' + U + '_mounts', guild: g.guild, channel: g.channel });
    await collect.handleInteraction(s);
    assert.match(s.out.replies[0].content, /just posted here\. Try again in \d+ s/);
    assert.equal(g.channel.sent.length, 1);
    // a minute later: fine again
    collect._.lastShow.set('c1', Date.now() - collect._.SHOW_GAP_MS - 1);
    s = interaction({ customId: 'collect_lbshow_' + U + '_mounts', guild: g.guild, channel: g.channel });
    await collect.handleInteraction(s);
    assert.equal(g.channel.sent.length, 2);
    // the server's language for the public post
    langs.guild = 'de';
    collect._.lastShow.clear();
    s = interaction({ customId: 'collect_lbshow_' + U + '_mounts', guild: g.guild, channel: g.channel });
    await collect.handleInteraction(s);
    assert.match(g.channel.sent[2].embeds[0].data.title, /Top-Sammler — 🐎 Reittiere/);
});

test('/collect 🔄 Refresh: syncs; again within 30 min says when', async () => {
    reset();
    await verify(U, LID);
    let r = interaction({ customId: 'collect_refresh_' + U });
    await collect.handleInteraction(r);
    assert.match(embedOf(last(r.out.edits)).description, /✅ Synced with FFXIV Collect/);
    r = interaction({ customId: 'collect_refresh_' + U });
    await collect.handleInteraction(r);
    assert.match(embedOf(last(r.out.edits)).description, /You can refresh again in 30 min/);
    assert.match(embedOf(last(r.out.edits)).description, /Mounts:\*\* 5 \/ 380/);
});

// ================= PF Mount farm =================
test('PF Mount farm: /pf mount option with autocomplete (user language, typos), the posted listing shows the mount + check button', async () => {
    reset();
    const data = pfCmd.data.data;
    const opt = (data.stringoption || data.options || [])[0];
    assert.ok(opt, 'mount option registered');
    const ac = interaction({ locale: 'ja', options: { getFocused: () => 'デブ' } });
    await pfCmd.autocomplete(ac);
    assert.deepEqual(ac.out.choices.slice(0, 2).map(c => c.value).sort(), ['200', '71']);
    const ac2 = interaction({ locale: 'en-US', options: { getFocused: () => 'Ixoin' } });
    await pfCmd.autocomplete(ac2);
    assert.equal(ac2.out.choices[0].name, 'Ixion');
    const ac3 = interaction({ locale: 'en-US', options: { getFocused: () => '' } });
    await pfCmd.autocomplete(ac3);
    assert.equal(ac3.out.choices[0].value, '104', 'empty: rarest first');
    assert.ok(ac3.out.choices.length <= 25);
    // /pf mount:71 -> the wizard keeps the mount
    const ex = interaction({ isChatInputCommand: () => true, options: { getString: n => (n === 'mount' ? '71' : null) } });
    await pfCmd.execute(ex);
    assert.match(last(ex.out.edits).content, /🐎 Mount farm: \*\*Fat Chocobo\*\*/);
    assert.deepEqual(global.pfSessions.get(U).data.mount, { id: 71, name: 'Fat Chocobo', icon: L.mounts.results.find(x => x.id === 71).icon });
    const typo = interaction({ isChatInputCommand: () => true, options: { getString: n => (n === 'mount' ? 'Sabotender Emperdor' : null) } });
    await pfCmd.execute(typo);
    assert.equal(global.pfSessions.get(U).data.mount.id, 90);
    const none = interaction({ isChatInputCommand: () => true, options: { getString: n => (n === 'mount' ? 'qqqqzzzz' : null) } });
    await pfCmd.execute(none);
    assert.match(last(none.out.edits).content, /No mount found for \*\*qqqqzzzz\*\*/);
    assert.equal(global.pfSessions.get(U).data.mount, undefined);
    // without the option: the old flow, untouched
    const plainPf = interaction({ isChatInputCommand: () => true });
    await pfCmd.execute(plainPf);
    assert.equal(plainPf.out.replies[0].content, t('en', 'pf.welcome'));
    // Create keeps the mount; Finish posts it
    global.pfSessions.set(U, { step: 'idle', data: { mount: { id: 71, name: 'Fat Chocobo', icon: 'https://x.test/71.webp' } } });
    const create = interaction({ customId: 'pf_create' });
    await pfCmd.handleInteraction(create);
    assert.equal(global.pfSessions.get(U).data.mount.id, 71);
    const g = fakeGuild([U], []);
    Object.assign(global.pfSessions.get(U).data, { name: 'Fat farm', size: 8, tanks: 2, healers: 2, meleedps: 2, range: 1, caster: 1, dps: 0, dateStr: '2031-1-1', time: '20:00', gmt: 9, imageUrl: 'https://x.test/c.png', imageStatus: 'success_custom' });
    const fin = interaction({ customId: 'pf_finish', guildId: 'g1', guild: g.guild, channel: g.channel, channelId: 'c1' });
    await pfCmd.handleInteraction(fin);
    const post = g.channel.sent[0];
    const e = post.embeds[0].data;
    assert.match(e.description, /🐎 \*\*Mount farm:\*\* Fat Chocobo/);
    assert.equal(e.thumbnail, L.mounts.results.find(x => x.id === 71).icon);
    const btns = post.components[0].data.components.map(b => b.data);
    assert.equal(btns[2].customId, 'pf_mcheck_' + JSON.parse(pf.rows[0].data).id);
    assert.equal(btns[2].label, '🐎 Check if you have it');
    assert.equal(JSON.parse(pf.rows[0].data).mount.id, 71, 'saved with the listing');
});

test('PF Mount farm: the check button answers each member (✅ / ❌ + rarity + source), the server language on the post, weekly repeat keeps the mount', async () => {
    reset();
    await verify(U, LID);
    const listing = { id: '888', userId: U2, guildId: 'g1', channelId: 'c1', name: 'Farm', size: 8, tanks: 2, healers: 2, dps: 0, meleedps: 2, range: 1, caster: 1,
        date: '2030-01-01 20:00 GMT+9', claims: {}, mount: { id: 42, name: 'Midgardsormr', icon: null }, recurring: { days: [1], active: true, series: '888' } };
    pf.rows.push({ id: '888', guild_id: 'g1', user_id: U2, status: 'active', data: JSON.stringify(listing) });
    let c = interaction({ customId: 'pf_mcheck_888' });
    await pfCmd.handleInteraction(c);
    let e = last(c.out.edits).embeds[0].data;
    assert.deepEqual(c.out.deferred.flags, [64]);
    assert.match(e.description, /✅ You already have \*\*Midgardsormr\*\*!/);
    assert.match(e.description, /40\.1% of FFXIV Collect players have it/);
    assert.match(e.description, /📍 Heavensward Hunt Mastery/);
    assert.equal(e.footer.text, 'Data by FFXIV Collect');
    listing.mount = { id: 104, name: 'Fenrir' };
    pf.rows[0].data = JSON.stringify(listing);
    c = interaction({ customId: 'pf_mcheck_888' });
    await pfCmd.handleInteraction(c);
    assert.match(last(c.out.edits).embeds[0].data.description, /❌ You still need \*\*Fenrir\*\*/);
    // the public listing in Japanese (server language): mount name from the Japanese list
    langs.guild = 'ja';
    const built = await pfCmd.buildPFEmbedAndRows(JSON.parse(JSON.stringify(listing)), { id: 'g1' }, '<@1>');
    assert.match(built.embed.data.description, /フェンリル/);
    // weekly repeat: the next listing farms the same mount
    langs.guild = 'en';
    const ch = fakeGuild([U], []).channel;
    ch.isTextBased = () => true; ch.guild = { id: 'g1' }; ch.name = 'pf';
    const client = { channels: { fetch: async () => ch } };
    const row = pf.rows[0];
    const outcome = await recur.handleStarted(client, row, JSON.parse(row.data), Date.parse('2030-01-01T11:05:00Z'));
    assert.equal(outcome, 'posted');
    const fresh = JSON.parse(pf.rows.find(r => r.id !== '888').data);
    assert.equal(fresh.mount.id, 104);
    assert.equal(ch.sent[0].components[0].data.components[2].data.customId, 'pf_mcheck_' + fresh.id);
    // a listing without a mount: no button, no thumbnail (unchanged)
    const plain = await pfCmd.buildPFEmbedAndRows({ id: '1', userId: U, name: 'x', size: 8, date: '2030-01-01 20:00 GMT+9', claims: {} }, { id: 'g1' }, '');
    assert.equal(plain.components[0].data.components.length, 2);
    assert.equal(plain.embed.data.thumbnail, undefined);
});

test('/collect texts: same keys in 4 languages, command description <= 100 characters, attribution everywhere', () => {
    for (const l of ['en', 'fr', 'de', 'ja']) {
        assert.ok(t(l, 'collect.cmd.description').length <= 100, l);
        assert.ok(t(l, 'pf.mount.optionDesc').length <= 100, l);
        assert.match(t(l, 'collect.credit'), /FFXIV Collect/);
        assert.match(t(l, 'pf.mount.credit'), /FFXIV Collect/);
    }
    assert.equal(collect.data.data.name, 'collect');
});
