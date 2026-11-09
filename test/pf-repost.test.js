// Party Finder "Post again?" DM: when a listing starts (scheduler marks it 'started'), the host gets a DM with
// a "📅 Post again" button that opens the /pf date/time step with the old details and creates a NEW listing.
// Plain node, no Discord / database:  node --test test/pf-repost.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------- module stand-ins ----------
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}
function canLoad(name) { try { require.resolve(name); return true; } catch (e) { return false; } }
if (!canLoad('discord.js')) {
    // builders that remember what was set; toJSON() gives the plain data
    const builder = () => {
        const data = {};
        const self = new Proxy({}, {
            get(_o, k) {
                if (k === 'toJSON') return () => ({ ...data, ...(data.components ? { components: data.components.map(c => (c && c.toJSON ? c.toJSON() : c)) } : {}) });
                if (k === 'data') return data;
                if (k === 'then') return undefined;
                if (typeof k !== 'string') return undefined;
                return (...args) => {
                    if (k.startsWith('set')) {
                        const f = k.slice(3);
                        data[f.charAt(0).toLowerCase() + f.slice(1)] = args[0];
                    } else if (k.startsWith('add')) {
                        const f = k.slice(3).toLowerCase();
                        data[f] = (data[f] || []).concat(args.flat());
                    }
                    return self;
                };
            }
        });
        return self;
    };
    const B = function () { return builder(); };
    const shim = {
        SlashCommandBuilder: B, ActionRowBuilder: B, ButtonBuilder: B, ModalBuilder: B, TextInputBuilder: B, EmbedBuilder: B, StringSelectMenuBuilder: B,
        ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
        TextInputStyle: { Short: 1, Paragraph: 2 },
        MessageFlags: { Ephemeral: 64 },
        PermissionFlagsBits: { Administrator: 1n << 3n, ManageChannels: 1n << 4n }
    };
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === 'discord.js') return 'shim:discord.js';
        return orig.call(this, request, ...rest);
    };
    inject('shim:discord.js', shim);
}
const plain = c => (c && typeof c.toJSON === 'function' ? c.toJSON() : c);

// Fake database: party_finders (pool.query) + user_language (pool.execute)
const db = { rows: [], writes: [], langs: new Map() };
const pool = {
    async query(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (/^SELECT \* FROM party_finders/.test(q)) return [db.rows.map(r => ({ ...r }))];
        if (/^INSERT INTO party_finders/.test(q)) {
            db.writes.push({ q, params });
            const [id, guild_id, user_id, status, cover_image, data] = params;
            const i = db.rows.findIndex(r => String(r.id) === String(id));
            const row = { id, guild_id, user_id, status, cover_image, data };
            if (i >= 0) db.rows[i] = row; else db.rows.push(row);
            return [{ affectedRows: 1 }];
        }
        if (/^UPDATE party_finders SET data = \? WHERE id = \?/.test(q)) {
            db.writes.push({ q, params });
            const r = db.rows.find(x => String(x.id) === String(params[1]));
            if (r) r.data = params[0];
            return [{ affectedRows: 1 }];
        }
        throw new Error('Fake pool: unexpected SQL: ' + q);
    },
    async execute(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (/^CREATE TABLE IF NOT EXISTS user_language/.test(q)) return [[]];
        if (/^SELECT lang, discord_locale FROM user_language/.test(q)) { const l = db.langs.get(params[0]); return [l ? [{ lang: l, discord_locale: null }] : []]; }
        if (/^INSERT INTO user_language/.test(q)) return [{ affectedRows: 1 }];
        throw new Error('Fake pool: unexpected SQL: ' + q);
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });
inject(path.join(ROOT, 'maintenance.js'), { isMaintenance: () => false });

const { t } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');
const sched = require('../utils/pfScheduler');
const pf = require('../commands/pf');

const HOST = '111111111111111111';
const OTHER = '222222222222222222';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';

function oldListing(over = {}) {
    const data = {
        id: '1700000000000', userId: HOST, guildId: GUILD, channelId: CHANNEL, messageId: 'm1',
        name: 'Savage Night', size: 8, tanks: 2, healers: 2, dps: 0, meleedps: 2, range: 1, caster: 1,
        date: '2026-11-10 21:00 GMT+2', imageUrl: 'https://img.example/cover.png', status: 'active',
        claims: { tanks: [], healers: [], dps: [], meleedps: [], range: [], caster: [], other: [], reserves: [] },
        notified30Min: true, notifiedExact: false, ...over
    };
    return { id: data.id, guild_id: GUILD, user_id: HOST, status: data.status, cover_image: data.imageUrl, data: JSON.stringify(data) };
}

function fakeChannel(id = CHANNEL) {
    const sent = [];
    const ch = {
        id, sent,
        guild: { id: GUILD, preferredLocale: 'en-US', emojis: { cache: { find: () => null } } },
        isTextBased: () => true,
        messages: { fetch: async () => ({ id: 'm1', edit: async () => {}, delete: async () => {} }) },
        send: async p => { sent.push(p); return { id: 'newMsg' + sent.length }; }
    };
    return ch;
}

function fakeClient({ dmFails = false } = {}) {
    const dms = [];
    const channel = fakeChannel();
    return {
        dms, channel,
        guilds: { fetch: async () => ({ id: GUILD, channels: { fetch: async () => channel } }) },
        users: { fetch: async id => { if (dmFails) throw new Error('Cannot send messages to this user'); return { id, send: async p => { dms.push({ to: id, p }); } }; } },
        channels: { fetch: async id => (id === CHANNEL ? channel : null) }
    };
}

/** Runs one tick of the real scheduler loop at `nowMs` (setInterval is caught, Date.now is pinned). */
async function runSchedulerTick(client, nowMs) {
    const realSI = global.setInterval;
    const realNow = Date.now;
    let tick = null;
    global.setInterval = fn => { tick = fn; return 0; };
    try {
        sched.startPfScheduler(client);
        Date.now = () => nowMs;
        await tick();
    } finally {
        global.setInterval = realSI;
        Date.now = realNow;
    }
}

function dmInteraction({ customId, userId = HOST, client, kind = 'button' }) {
    const calls = [];
    return {
        calls, customId, client,
        user: { id: userId, tag: 'x' }, locale: 'en-US', guildId: null, guild: null, channel: null, channelId: 'dmChannel',
        isButton: () => kind === 'button', isStringSelectMenu: () => false, isModalSubmit: () => kind === 'modal',
        reply: async p => { calls.push(['reply', p]); },
        update: async p => { calls.push(['update', p]); },
        showModal: async m => { calls.push(['showModal', m]); },
        deferUpdate: async () => { calls.push(['deferUpdate']); }
    };
}

const realLog = console.log;
const realErr = console.error;
test.before(() => { console.log = () => {}; console.error = () => {}; });
test.after(() => { console.log = realLog; console.error = realErr; });
test.beforeEach(() => { db.rows = []; db.writes = []; db.langs.clear(); userLanguage.clearCache(); global.pfSessions = new Map(); });

// the old listing starts at 2026-11-10 21:00 GMT+2 = 19:00 UTC
const START = Date.UTC(2026, 10, 10, 19, 0, 0);

test('listing ends -> host gets ONE DM with a "📅 Post again" button (after it was saved)', async () => {
    db.rows = [oldListing()];
    const client = fakeClient();
    await runSchedulerTick(client, START + 5000);
    assert.equal(client.channel.sent.length, 1, 'the "starting now" alert in the channel is unchanged');
    assert.equal(client.dms.length, 1);
    const dm = client.dms[0];
    assert.equal(dm.to, HOST);
    assert.equal(dm.p.content, t('en', 'pf.repost.dm', { name: 'Savage Night' }));
    const btn = dm.p.components[0].components[0];
    assert.equal(btn.type, 2);
    assert.equal(btn.emoji.name, '📅');
    assert.equal(btn.label, t('en', 'pf.repost.button'));
    assert.ok(btn.custom_id.length <= 100);
    assert.deepEqual(sched.parseRepostCustomId(btn.custom_id), { listingId: '1700000000000', hostId: HOST, sentAt: START + 5000 });
    assert.equal(JSON.parse(db.rows[0].data).status, 'started');

    // next tick: already notified -> no second DM
    await runSchedulerTick(client, START + 10000);
    assert.equal(client.dms.length, 1);
});

test('DM in the host\'s language', async () => {
    db.rows = [oldListing()];
    db.langs.set(HOST, 'ja');
    const client = fakeClient();
    await runSchedulerTick(client, START + 1000);
    assert.equal(client.dms[0].p.content, t('ja', 'pf.repost.dm', { name: 'Savage Night' }));
    assert.equal(client.dms[0].p.components[0].components[0].label, t('ja', 'pf.repost.button'));
});

test('DMs closed -> nothing else happens (no crash, listing still saved)', async () => {
    db.rows = [oldListing()];
    const client = fakeClient({ dmFails: true });
    await runSchedulerTick(client, START + 1000);
    assert.equal(client.dms.length, 0);
    assert.equal(JSON.parse(db.rows[0].data).notifiedExact, true);
    assert.equal(client.channel.sent.length, 1);
});

test('30-minute reminder does not send the DM', async () => {
    db.rows = [oldListing()];
    db.rows[0].data = JSON.stringify({ ...JSON.parse(db.rows[0].data), notified30Min: false });
    const client = fakeClient();
    await runSchedulerTick(client, START - 29.5 * 60000);
    assert.equal(client.dms.length, 0);
});

test('button pressed by someone else -> refused', async () => {
    db.rows = [oldListing()];
    const client = fakeClient();
    const i = dmInteraction({ customId: sched.repostCustomId('1700000000000', HOST, Date.now()), userId: OTHER, client });
    await pf.handleInteraction(i);
    assert.equal(i.calls.length, 1);
    assert.equal(i.calls[0][0], 'reply');
    assert.equal(i.calls[0][1].content, t('en', 'pf.repost.onlyHost'));
    assert.equal(global.pfSessions.has(OTHER), false);
});

test('button older than 7 days -> polite reply', async () => {
    db.rows = [oldListing()];
    const i = dmInteraction({ customId: sched.repostCustomId('1700000000000', HOST, Date.now() - 7 * 24 * 3600 * 1000 - 1000), client: fakeClient() });
    await pf.handleInteraction(i);
    assert.equal(i.calls[0][1].content, t('en', 'pf.repost.tooOld'));
    assert.equal(global.pfSessions.has(HOST), false);
});

test('old listing deleted meanwhile -> "gone" reply', async () => {
    const i = dmInteraction({ customId: sched.repostCustomId('1700000000000', HOST, Date.now()), client: fakeClient() });
    await pf.handleInteraction(i);
    assert.equal(i.calls[0][1].content, t('en', 'pf.gone'));
});

test('host: opens the date/time step prefilled, then Finish posts a NEW listing in the old channel', async () => {
    db.rows = [oldListing()];
    const client = fakeClient();
    const i = dmInteraction({ customId: sched.repostCustomId('1700000000000', HOST, Date.now()), client });
    await pf.handleInteraction(i);

    // same step as the wizard's "Edit date": the time zone menu, as a new private message
    assert.equal(i.calls[0][0], 'reply');
    const payload = i.calls[0][1];
    assert.equal(payload.content, t('en', 'pf.step3'));
    const rows = payload.components.map(plain);
    const ids = rows.flatMap(r => r.components.map(c => plain(c).custom_id || plain(c).customId));
    assert.deepEqual(ids, ['pf_sel_gmt_menu', 'pf_timezone_done']);

    const s = global.pfSessions.get(HOST);
    assert.equal(s.step, 'sel_timezone');
    assert.deepEqual(
        { name: s.data.name, size: s.data.size, tanks: s.data.tanks, healers: s.data.healers, meleedps: s.data.meleedps, range: s.data.range, caster: s.data.caster, imageUrl: s.data.imageUrl, gmt: s.data.gmt },
        { name: 'Savage Night', size: 8, tanks: 2, healers: 2, meleedps: 2, range: 1, caster: 1, imageUrl: 'https://img.example/cover.png', gmt: 2 }
    );
    assert.deepEqual(s.data.repostFrom, { listingId: '1700000000000', guildId: GUILD, channelId: CHANNEL });
    assert.equal(s.data.dateStr, undefined, 'the date is new (asked in the next step)');

    // (the date modal and time menus fill these exactly as in the normal wizard)
    s.data.dateStr = '2099-01-02';
    s.data.time = '20:30';
    s.data.imageStatus = 'blank';
    const fin = dmInteraction({ customId: 'pf_finish', client });
    await pf.handleInteraction(fin);

    assert.equal(client.channel.sent.length, 1, 'posted in the old listing channel, not in the DM');
    assert.equal(client.channel.sent[0].content, t('en', 'pf.published'));
    const insert = db.writes.find(w => /^INSERT INTO party_finders/.test(w.q));
    assert.ok(insert, 'saved');
    const saved = JSON.parse(insert.params[5]);
    assert.notEqual(saved.id, '1700000000000', 'a NEW listing');
    assert.equal(saved.guildId, GUILD);
    assert.equal(saved.channelId, CHANNEL);
    assert.equal(saved.userId, HOST);
    assert.equal(saved.name, 'Savage Night');
    assert.equal(saved.size, 8);
    assert.equal(saved.imageUrl, 'https://img.example/cover.png');
    assert.equal(saved.date, '2099-01-02 20:30 GMT+2');
    assert.equal(saved.status, 'active');
    assert.equal(saved.messageId, 'newMsg1');
    assert.deepEqual(saved.claims.tanks, [], 'nobody signed up yet');
    assert.equal(db.rows.length, 2, 'old listing kept');
    assert.equal(fin.calls[0][0], 'update');
    assert.equal(global.pfSessions.has(HOST), false);
});

test('Finish when the old channel is gone -> short message, nothing posted', async () => {
    db.rows = [oldListing()];
    const client = fakeClient();
    global.pfSessions.set(HOST, { step: 'confirmation', data: { name: 'X', size: 4, tanks: 1, healers: 1, meleedps: 1, range: 0, caster: 1, gmt: 9, dateStr: '2099-01-01', time: '20:00', imageUrl: 'https://img.example/a.png', repostFrom: { listingId: '1', guildId: GUILD, channelId: 'deleted' } } });
    const fin = dmInteraction({ customId: 'pf_finish', client });
    await pf.handleInteraction(fin);
    assert.equal(fin.calls[0][1].content, t('en', 'pf.repost.noChannel'));
    assert.equal(db.writes.length, 0);
});

test('normal /pf Finish (in a server) still posts in the current channel', async () => {
    const client = fakeClient();
    const here = fakeChannel('555555555555555555');
    global.pfSessions.set(HOST, { step: 'confirmation', data: { name: 'Normal', size: 4, tanks: 1, healers: 1, meleedps: 1, range: 0, caster: 1, gmt: 9, dateStr: '2099-01-01', time: '20:00', imageUrl: 'https://img.example/a.png' } });
    const fin = dmInteraction({ customId: 'pf_finish', client });
    Object.assign(fin, { guildId: GUILD, guild: here.guild, channel: here, channelId: here.id });
    await pf.handleInteraction(fin);
    assert.equal(here.sent.length, 1);
    assert.equal(client.channel.sent.length, 0);
    const saved = JSON.parse(db.writes[0].params[5]);
    assert.equal(saved.channelId, here.id);
    assert.equal(saved.guildId, GUILD);
});
