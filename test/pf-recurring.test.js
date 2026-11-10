// Recurring Party Finder (v2.2, Part 5.2): weekly on chosen days, same time. Next-run math (time zones, week wrap,
// offline catch-up), the scheduler posting the next listing exactly once (also after a restart), the /pf preview
// "🔁 Repeat weekly" picker and "Stop repeating" (host only).
// Plain node, no Discord / database:  node --test test/pf-recurring.test.js
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
        if (/^DELETE FROM party_finders WHERE id = \?/.test(q)) {
            db.writes.push({ q, params });
            db.rows = db.rows.filter(r => String(r.id) !== String(params[0]));
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
const recur = require('../utils/pfRecurring');
const guildLanguage = require('../utils/guildLanguage');

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


// the weekly listing starts at 2026-11-10 21:00 GMT+2 (a Tuesday) = 19:00 UTC
const START = Date.UTC(2026, 10, 10, 19, 0, 0);
const DAY = 24 * 3600 * 1000;
const rowOf = data => ({ id: data.id, guild_id: GUILD, user_id: HOST, status: data.status, cover_image: data.imageUrl, data: JSON.stringify(data) });
function weekly(over = {}) {
    return oldListing({ recurring: { days: [2], active: true, series: '1700000000000' }, notified30Min: true, ...over });
}
const listings = () => db.rows.map(r => JSON.parse(r.data));

// ---------- next-run math ----------
test('next run: next ticked weekday after the start, same time, in the listing\'s own time zone', () => {
    // 2026-11-10 is a Tuesday. Tue + Thu ticked -> Thu 2026-11-12, same 21:00 GMT+2
    assert.deepEqual(recur.nextRun('2026-11-10 21:00 GMT+2', [2, 4], Date.UTC(2026, 10, 10, 19, 0, 30)),
        { ms: Date.UTC(2026, 10, 12, 19, 0), date: '2026-11-12 21:00 GMT+2' });
    // only Tuesday -> one week later
    assert.equal(recur.nextRun('2026-11-10 21:00 GMT+2', [2], Date.UTC(2026, 10, 10, 19, 1)).date, '2026-11-17 21:00 GMT+2');
});

test('next run: week wrap (Saturday -> Monday) and month/year wrap', () => {
    // Sat 2026-11-14, ticked Mon + Sat -> Mon 2026-11-16
    assert.equal(recur.nextRun('2026-11-14 20:00 GMT+9', [1, 6], Date.UTC(2026, 10, 14, 11, 1)).date, '2026-11-16 20:00 GMT+9');
    // Thu 2026-12-31 23:30 GMT+9, ticked Fri -> Fri 2027-01-01 (new year)
    assert.equal(recur.nextRun('2026-12-31 23:30 GMT+9', [5], Date.UTC(2026, 11, 31, 14, 31)).date, '2027-01-01 23:30 GMT+9');
    // Sunday (0) after Saturday
    assert.equal(recur.nextRun('2026-11-14 20:00 GMT+9', [0], Date.UTC(2026, 10, 14, 11, 1)).date, '2026-11-15 20:00 GMT+9');
});

test('next run: weekdays count in the listing\'s time zone, not UTC', () => {
    // Mon 2026-11-16 01:00 GMT+9 is still Sunday in UTC. Ticked Monday -> the next Monday, 01:00 GMT+9.
    assert.equal(recur.nextRun('2026-11-16 01:00 GMT+9', [1], Date.UTC(2026, 10, 15, 16, 1)).date, '2026-11-23 01:00 GMT+9');
    // GMT-8: Tue 2026-11-10 22:00 is Wed 06:00 UTC. Ticked Wed -> Wed 2026-11-11 22:00 GMT-8 (not the UTC Wednesday)
    assert.equal(recur.nextRun('2026-11-10 22:00 GMT-8', [3], Date.UTC(2026, 10, 11, 6, 1)).date, '2026-11-11 22:00 GMT-8');
});

test('next run: after a long offline time, runs that are over are skipped (never in the past)', () => {
    const now = Date.UTC(2026, 10, 30, 0, 0);
    const n = recur.nextRun('2026-11-10 21:00 GMT+2', [2], now);
    assert.equal(n.date, '2026-12-01 21:00 GMT+2');
    assert.ok(n.ms > now);
    assert.equal(recur.nextRun('2026-11-10 21:00 GMT+2', [], now), null);
    assert.equal(recur.nextRun('bad date', [2], now), null);
    assert.deepEqual(recur.cleanDays([0, 6, '3', 7, -1, 'x', 3, 1.5]), [3, 6, 0]);
});

// ---------- scheduler ----------
test('weekly listing starts -> the NEXT listing is posted once (same channel, nobody signed up), DM has "Stop repeating"', async () => {
    db.rows = [weekly()];
    const client = fakeClient();
    await runSchedulerTick(client, START + 5000);
    const all = listings();
    assert.equal(all.length, 2);
    const old = all.find(l => l.id === '1700000000000');
    const next = all.find(l => l.id !== '1700000000000');
    assert.equal(old.recurPosted, true);
    assert.equal(next.date, '2026-11-17 21:00 GMT+2');
    assert.equal(next.channelId, CHANNEL);
    assert.equal(next.userId, HOST);
    assert.equal(next.name, 'Savage Night');
    assert.deepEqual(next.recurring, { days: [2], active: true, series: '1700000000000' });
    assert.deepEqual(next.claims.tanks, []);
    assert.equal(next.messageId, 'newMsg2', 'posted after the "starting now" alert');
    const posted = client.channel.sent.find(p => p.content === t('en', 'pf.recur.posted'));
    assert.ok(posted && posted.embeds.length === 1);
    // the start DM: Post again + Stop repeating
    const btns = client.dms[0].p.components[0].components;
    assert.deepEqual(btns.map(b => b.custom_id), [sched.repostCustomId('1700000000000', HOST, START + 5000), 'pf_recur_stop_1700000000000']);
    assert.equal(btns[1].label, t('en', 'pf.recur.stop'));

    // more ticks: nothing new
    await runSchedulerTick(client, START + 10000);
    await runSchedulerTick(client, START + 60000);
    assert.equal(listings().length, 2);
});

test('restart: a started listing that already posted its follow-up never posts again (flag saved in the database)', async () => {
    db.rows = [weekly({ notifiedExact: true, status: 'started', recurPosted: true })];
    await runSchedulerTick(fakeClient(), START + 3 * 3600 * 1000);
    assert.equal(listings().length, 1);
});

test('restart while offline at start time: the follow-up is still posted once, for a future date', async () => {
    db.rows = [weekly()];
    const client = fakeClient();
    const now = START + 9 * DAY; // offline for 9 days (missed the 17th)
    await runSchedulerTick(client, now);
    await runSchedulerTick(client, now + 5000);
    const next = listings().filter(l => l.id !== '1700000000000');
    assert.equal(next.length, 1);
    assert.equal(next[0].date, '2026-11-24 21:00 GMT+2');
});

test('no double post: a listing of the same series and date already there (e.g. second process) -> nothing posted', async () => {
    const existing = JSON.parse(oldListing({ id: '1700000000999', date: '2026-11-17 21:00 GMT+2', recurring: { days: [2], active: true, series: '1700000000000' } }).data);
    db.rows = [weekly(), rowOf(existing)];
    const client = fakeClient();
    await runSchedulerTick(client, START + 5000);
    assert.equal(listings().length, 2);
    assert.equal(client.channel.sent.filter(p => p.content === t('en', 'pf.recur.posted')).length, 0);
});

test('stopped series / non-weekly listing: no follow-up', async () => {
    db.rows = [weekly({ recurring: { days: [2], active: false, series: '1700000000000' } })];
    await runSchedulerTick(fakeClient(), START + 5000);
    assert.equal(listings().length, 1);
    db.rows = [oldListing()];
    const c = fakeClient();
    await runSchedulerTick(c, START + 5000);
    assert.equal(listings().length, 1);
    assert.equal(c.dms[0].p.components[0].components.length, 1, 'normal listing: only "Post again"');
});

test('follow-up post fails (channel gone) -> no empty listing is left behind, the series stops', async () => {
    db.rows = [weekly({ channelId: 'deleted' })];
    const client = fakeClient();
    await runSchedulerTick(client, START + 5000);
    assert.equal(listings().length, 1);
    assert.equal(listings()[0].recurPosted, true);
});

test('the next listing\'s embed says it repeats, in the server\'s language (Server language card)', async () => {
    db.rows = [weekly()];
    const client = fakeClient();
    // the server picked Japanese on the website
    const realGet = guildLanguage.get;
    guildLanguage.get = id => (String(id) === GUILD ? 'ja' : null);
    try {
        await runSchedulerTick(client, START + 5000);
    } finally { guildLanguage.get = realGet; }
    const posted = client.channel.sent.find(p => p.content === t('ja', 'pf.recur.posted'));
    assert.ok(posted, 'posted in Japanese');
    const desc = plain(posted.embeds[0]).description;
    assert.ok(desc.includes(t('ja', 'pf.recur.embedLine', { days: t('ja', 'pf.recur.day.tue') })), desc);
    assert.ok(client.channel.sent.some(p => p.content === t('ja', 'pf.alert.now', { name: 'Savage Night', pings: '<@' + HOST + '>' })), 'the start alert follows the override too');
});

// ---------- /pf preview: Repeat weekly ----------
function serverInteraction(customId, extra = {}) {
    const here = fakeChannel('555555555555555555');
    const i = dmInteraction({ customId, client: fakeClient() });
    Object.assign(i, { guildId: GUILD, guild: here.guild, channel: here, channelId: here.id, here }, extra);
    return i;
}
const baseSession = () => ({ step: 'confirmation', data: { name: 'Weekly', size: 4, tanks: 1, healers: 1, meleedps: 1, range: 0, caster: 1, gmt: 9, dateStr: '2099-01-05', time: '20:00', imageUrl: 'https://img.example/a.png' } });

test('preview has "🔁 Repeat weekly"; the picker suggests the chosen weekday; picking days shows them in the preview', async () => {
    global.pfSessions.set(HOST, baseSession());
    let i = serverInteraction('pf_edit_repeat');
    await pf.handleInteraction(i);
    const p = i.calls[0][1];
    assert.equal(i.calls[0][0], 'update');
    const menu = plain(plain(p.components[0]).components[0]);
    assert.equal(menu.customId, 'pf_sel_repeat_menu');
    assert.equal(menu.maxValues, 7);
    const opts = menu.options;
    assert.deepEqual(opts.map(o => o.value), ['1', '2', '3', '4', '5', '6', '0']);
    assert.deepEqual(opts.filter(o => o.default).map(o => o.value), ['1'], '2099-01-05 is a Monday');

    i = serverInteraction('pf_sel_repeat_menu', { isStringSelectMenu: () => true, isButton: () => false, values: ['4', '1'] });
    await pf.handleInteraction(i);
    assert.deepEqual(global.pfSessions.get(HOST).data.recurDays, [1, 4]);
    const fields = plain(i.calls[0][1].embeds[0]).fields;
    const f = fields.find(x => x.name === t('en', 'pf.recur.field'));
    assert.equal(f.value, t('en', 'pf.recur.every', { days: 'Mon, Thu', time: '20:00', gmt: '+9' }));
    const ids = i.calls[0][1].components.flatMap(r => plain(r).components.map(c => plain(c).customId));
    assert.ok(ids.includes('pf_edit_repeat') && ids.includes('pf_finish'));

    i = serverInteraction('pf_repeat_none');
    await pf.handleInteraction(i);
    assert.deepEqual(global.pfSessions.get(HOST).data.recurDays, []);
    assert.equal(plain(i.calls[0][1].embeds[0]).fields.find(x => x.name === t('en', 'pf.recur.field')).value, t('en', 'pf.recur.none'));
});

test('Finish with days picked saves the listing as the start of a weekly series', async () => {
    global.pfSessions.set(HOST, { ...baseSession(), data: { ...baseSession().data, recurDays: [1, 4] } });
    const i = serverInteraction('pf_finish');
    await pf.handleInteraction(i);
    const saved = JSON.parse(db.writes.find(w => /^INSERT INTO party_finders/.test(w.q)).params[5]);
    assert.deepEqual(saved.recurring, { days: [1, 4], active: true, series: saved.id });
    assert.ok(plain(i.here.sent[0].embeds[0]).description.includes(t('en', 'pf.recur.embedLine', { days: 'Mon, Thu' })));
    // without days: no recurring at all
    db.writes = [];
    global.pfSessions.set(HOST, baseSession());
    await pf.handleInteraction(serverInteraction('pf_finish'));
    assert.equal(JSON.parse(db.writes.find(w => /^INSERT INTO party_finders/.test(w.q)).params[5]).recurring, undefined);
});

test('Stop repeating: only the host; stops every listing of the series; joining keeps the weekly data', async () => {
    const a = JSON.parse(weekly().data);
    const b = { ...a, id: '1700000000555', date: '2026-11-17 21:00 GMT+2' };
    db.rows = [rowOf(a), rowOf(b)];
    // someone joins the upcoming one: the weekly data must survive the save
    let i = serverInteraction('pf_leave_1700000000555', { user: { id: OTHER, tag: 'o' } });
    await pf.handleInteraction(i);
    assert.deepEqual(listings().find(l => l.id === '1700000000555').recurring, { days: [2], active: true, series: '1700000000000' });

    i = serverInteraction('pf_recur_stop_1700000000555', { user: { id: OTHER, tag: 'o' } });
    await pf.handleInteraction(i);
    assert.equal(i.calls[0][1].content, t('en', 'pf.recur.onlyHost'));
    assert.ok(listings().every(l => l.recurring.active));

    i = dmInteraction({ customId: 'pf_recur_stop_1700000000000', client: fakeClient() });
    await pf.handleInteraction(i);
    assert.equal(i.calls[0][1].content, t('en', 'pf.recur.stopped', { name: 'Savage Night' }));
    assert.ok(listings().every(l => l.recurring.active === false));
    i = dmInteraction({ customId: 'pf_recur_stop_1700000000000', client: fakeClient() });
    await pf.handleInteraction(i);
    assert.equal(i.calls[0][1].content, t('en', 'pf.recur.alreadyStopped', { name: 'Savage Night' }));
});

test('Check My PF(s) shows "Stop repeating" only for weekly listings', async () => {
    const a = JSON.parse(weekly().data);
    const b = JSON.parse(oldListing({ id: '1700000000777' }).data);
    db.rows = [rowOf(a), rowOf(b)];
    const i = serverInteraction('pf_check');
    await pf.handleInteraction(i);
    const rows = i.calls[0][1].components.map(r => plain(r).components.map(c => plain(c).customId));
    assert.deepEqual(rows, [['pf_show_1700000000000', 'pf_delete_listing_1700000000000', 'pf_recur_stop_1700000000000'],
        ['pf_show_1700000000777', 'pf_delete_listing_1700000000777']]);
});

test('every recurring text exists in en/fr/de/ja', () => {
    const fs = require('fs');
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales/en/pf.json'), 'utf8')).recur;
    const keys = o => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? keys(v).map(x => k + '.' + x) : [k]);
    for (const l of ['fr', 'de', 'ja']) {
        const other = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', l, 'pf.json'), 'utf8')).recur;
        assert.deepEqual(keys(other).sort(), keys(en).sort(), l);
    }
});
