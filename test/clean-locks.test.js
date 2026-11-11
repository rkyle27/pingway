// /clean and /clearbotdms: scoped locks (utils/lock.js) + the 30-minute limit of /clean.
// - /clean locks only its channel: two channels at once are fine, a second /clean in the same channel is refused
// - other slash commands are never blocked while a clean runs (events/interactionCreate.js has no global "busy" block)
// - /clearbotdms locks only that user
// - locks are always released (also on errors)
// - a clean still running after 30 minutes stops and says how many messages were deleted (fake timers)
// Plain node, no Discord / database:  node --test test/clean-locks.test.js
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
function stub() {
    const fn = function () {};
    return new Proxy(fn, {
        get(_t, k) {
            if (k === 'then') return undefined;
            if (k === Symbol.toPrimitive) return () => '';
            return stub();
        },
        apply() { return stub(); },
        construct() { return stub(); }
    });
}
const shims = {
    'discord.js': new Proxy({ MessageFlags: { Ephemeral: 64 }, Events: { InteractionCreate: 'interactionCreate' }, PermissionFlagsBits: { Administrator: 8n } }, { get(o, k) { return k in o ? o[k] : stub(); } })
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (shims[request]) return 'shim:' + request;
    try { return origResolve.call(this, request, ...rest); } catch (e) {
        if (request.startsWith('.') || request.startsWith('/')) throw e;
        if (!require.cache['shim:' + request]) inject('shim:' + request, stub());
        return 'shim:' + request;
    }
};
for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);
inject(path.join(ROOT, 'utils', 'db.js'), { pool: { execute: async () => [[]], query: async () => [[]] } });
inject(path.join(ROOT, 'utils', 'userLanguage.js'), { forInteraction: async () => 'en', noteLocale: async () => {}, forGuild: () => 'en' });
inject(path.join(ROOT, 'maintenance.js'), { isMaintenance: () => false });
inject(path.join(ROOT, 'events', 'interactions', 'logger.js'), { handleInteraction: async () => {} });

const { t } = require('../utils/i18n');
const lock = require('../utils/lock');
const clean = require('../commands/clean');
const clearbotdms = require('../commands/clearbotdms');
const interactionCreate = require('../events/interactionCreate');

// ---------- fakes ----------
class Coll extends Map {
    filter(fn) { const c = new Coll(); for (const [k, v] of this) if (fn(v)) c.set(k, v); return c; }
    lastKey() { return [...this.keys()].pop(); }
}
const DAY = 24 * 3600 * 1000;
let nextId = 1;
// a channel with messages (newest first); gate: a promise the next fetch waits for (to keep a clean "running")
function fakeChannel(id, { recent = 0, old = 0, now = Date.now(), author = 'bot' } = {}) {
    const ch = { id, msgs: [], gate: null, fetchError: null, deleted: 0 };
    const mk = ts => {
        const m = { id: String(nextId++), createdTimestamp: ts, author: { id: author } };
        m.delete = async () => { const i = ch.msgs.indexOf(m); if (i < 0) { const e = new Error('Unknown Message'); e.code = 10008; throw e; } ch.msgs.splice(i, 1); ch.deleted++; };
        return m;
    };
    for (let i = 0; i < recent; i++) ch.msgs.push(mk(now - 1000 - i));
    for (let i = 0; i < old; i++) ch.msgs.push(mk(now - 30 * DAY - i));
    ch.messages = {
        async fetch({ limit, before }) {
            if (ch.gate) await ch.gate;
            if (ch.fetchError) throw ch.fetchError;
            let list = ch.msgs;
            if (before) { const i = list.findIndex(m => m.id === before); list = i < 0 ? [] : list.slice(i + 1); }
            const c = new Coll();
            for (const m of list.slice(0, limit)) c.set(m.id, m);
            return c;
        }
    };
    ch.bulkDelete = async coll => { const c = new Coll(); for (const [k, m] of coll) { const i = ch.msgs.indexOf(m); if (i >= 0) { ch.msgs.splice(i, 1); c.set(k, m); ch.deleted++; } } return c; };
    return ch;
}
function cleanInteraction(channel, target = 'all', o = {}) {
    const out = { replies: [], edits: [], followUps: [], deferred: null };
    const i = Object.assign({
        user: { id: 'u1', tag: 'u#1' }, channelId: channel.id, channel, guildId: 'g1', locale: 'en-US',
        options: { getString: () => target },
        async reply(x) { out.replies.push(x); }, async deferReply(x) { out.deferred = x; },
        async editReply(x) { out.edits.push(x); }, async followUp(x) { out.followUps.push(x); }
    }, o);
    i.out = out;
    return i;
}
function dmInteraction(userId, channel, o = {}) {
    const out = { replies: [], edits: [], deferred: null };
    const i = Object.assign({
        user: { id: userId, createDM: async () => channel }, channel, guildId: null, locale: 'en-US',
        client: { user: { id: 'bot' } },
        async reply(x) { out.replies.push(x); }, async deferReply(x) { out.deferred = x; }, async editReply(x) { out.edits.push(x); }
    }, o);
    i.out = out;
    return i;
}
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const flush = () => new Promise(r => setImmediate(r));

test.beforeEach(() => lock._reset());

test('/clean in two channels at the same time: both run; a second /clean in the same channel is refused', async () => {
    const a = fakeChannel('A', { recent: 5 });
    const b = fakeChannel('B', { recent: 3 });
    const g = gate();
    a.gate = g.p;
    const ia = cleanInteraction(a);
    const runA = clean.execute(ia);
    await flush();
    assert.equal(lock.isLocked(lock.channelKey('A')), true, 'channel A is locked while it runs');
    // another channel: not blocked
    const ib = cleanInteraction(b);
    await clean.execute(ib);
    assert.equal(ib.out.edits.at(-1).content, t('en', 'clean.complete', { deletedTotal: 3 }));
    assert.equal(lock.isLocked(lock.channelKey('B')), false);
    // same channel: "already running"
    const again = cleanInteraction(a);
    await clean.execute(again);
    assert.equal(again.out.replies[0].content, t('en', 'clean.alreadyRunning'));
    assert.deepEqual(again.out.replies[0].flags, [64]);
    assert.equal(again.out.deferred, null);
    // A finishes, then A can be cleaned again
    a.gate = null; g.open();
    await runA;
    assert.equal(ia.out.edits.at(-1).content, t('en', 'clean.complete', { deletedTotal: 5 }));
    assert.equal(lock.isLocked(lock.channelKey('A')), false);
    const third = cleanInteraction(fakeChannel('A', { recent: 1 }));
    await clean.execute(third);
    assert.equal(third.out.replies.length, 0);
    assert.equal(third.out.edits.at(-1).content, t('en', 'clean.complete', { deletedTotal: 1 }));
});

test('while a /clean runs, every other slash command (and other servers) keeps working', async () => {
    const a = fakeChannel('A', { recent: 2 });
    const g = gate();
    a.gate = g.p;
    const runA = clean.execute(cleanInteraction(a));
    await flush();
    const ran = [];
    const client = { commands: new Map([['ping', { execute: async i => { ran.push(i.guildId); } }], ['clean', clean]]) };
    const slash = (name, guildId) => ({
        commandName: name, guildId, guild: { id: guildId, name: 'S' }, user: { id: 'u2', tag: 'u#2' }, locale: 'en-US', channelId: 'X',
        isChatInputCommand: () => true, isRepliable: () => true, replied: false, deferred: false,
        reply: async x => { ran.push('reply:' + x.content); }
    });
    await interactionCreate.execute(slash('ping', 'g1'), client);
    await interactionCreate.execute(slash('ping', 'g2'), client);
    assert.deepEqual(ran, ['g1', 'g2'], 'no "busy" reply, the commands ran');
    a.gate = null; g.open();
    await runA;
});

test('the interaction handler has no global busy block and no autocomplete route any more', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'events', 'interactionCreate.js'), 'utf8');
    assert.ok(!/isBotBusy|getBusyTask|core\.busy/.test(src));
    assert.ok(!/isAutocomplete/.test(src));
    assert.equal(t('en', 'core.busy'), 'core.busy', 'the old busy text is gone');
});

test('/clearbotdms locks only that user: the same user is refused, another user runs at the same time', async () => {
    const dm1 = fakeChannel('dm1', { recent: 4 });
    const dm2 = fakeChannel('dm2', { recent: 2 });
    const g = gate();
    dm1.gate = g.p;
    const i1 = dmInteraction('U1', dm1);
    const run1 = clearbotdms.execute(i1);
    await flush();
    assert.equal(lock.isLocked(lock.userKey('U1')), true);
    const again = dmInteraction('U1', dm1);
    await clearbotdms.execute(again);
    assert.equal(again.out.replies[0].content, t('en', 'clearbotdms.alreadyRunning'));
    const i2 = dmInteraction('U2', dm2);
    await clearbotdms.execute(i2);
    assert.equal(i2.out.edits.at(-1).content, t('en', 'clearbotdms.done', { deletedCount: 2 }));
    // a /clean in some channel is not blocked by a DM cleanup either
    const c = cleanInteraction(fakeChannel('C', { recent: 1 }));
    await clean.execute(c);
    assert.equal(c.out.edits.at(-1).content, t('en', 'clean.complete', { deletedTotal: 1 }));
    dm1.gate = null; g.open();
    await run1;
    assert.equal(i1.out.edits.at(-1).content, t('en', 'clearbotdms.done', { deletedCount: 4 }));
    assert.equal(lock.isLocked(lock.userKey('U1')), false);
    for (const l of ['fr', 'de', 'ja']) assert.notEqual(t(l, 'clearbotdms.alreadyRunning'), t('en', 'clearbotdms.alreadyRunning'), l);
});

test('locks are released on errors and on a wrong target', async () => {
    const a = fakeChannel('A', { recent: 3 });
    a.fetchError = new Error('Missing Access');
    const quiet = console.error; console.error = () => {};
    try {
        const i = cleanInteraction(a);
        await clean.execute(i);
        assert.equal(i.out.edits.at(-1).content, t('en', 'clean.failed'));
        assert.equal(lock.isLocked(lock.channelKey('A')), false, 'released after an error');
        // deferReply itself fails (interaction expired)
        const d = cleanInteraction(fakeChannel('D'), 'all', { deferReply: async () => { throw new Error('Unknown interaction'); } });
        await assert.rejects(clean.execute(d));
        assert.equal(lock.isLocked(lock.channelKey('D')), false, 'released when deferReply throws');
        // wrong target
        const w = cleanInteraction(fakeChannel('W'), 'abc');
        await clean.execute(w);
        assert.equal(w.out.edits.at(-1).content, t('en', 'clean.invalid'));
        assert.match(t('en', 'clean.invalid'), /\/clean target: 5/);
        assert.equal(lock.isLocked(lock.channelKey('W')), false);
        // clearbotdms error
        const dm = fakeChannel('dm', { recent: 2 });
        dm.fetchError = new Error('boom');
        const di = dmInteraction('U9', dm);
        await clearbotdms.execute(di);
        assert.equal(di.out.edits.at(-1).content, t('en', 'clearbotdms.failed'));
        assert.equal(lock.isLocked(lock.userKey('U9')), false);
    } finally { console.error = quiet; }
});

test('30-minute limit: a long clean of old messages stops and says how many were deleted (fake timers, same 1 s pacing)', async (tt) => {
    tt.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
    const ch = fakeChannel('OLD', { old: 5000, recent: 0, now: Date.now() });
    const i = cleanInteraction(ch);
    let done = false;
    const run = clean.execute(i).then(() => { done = true; });
    let ticks = 0;
    while (!done && ticks < 5000) { await flush(); tt.mock.timers.tick(1000); ticks++; }
    await run;
    assert.equal(clean.TIME_LIMIT_MS, 30 * 60 * 1000);
    const deleted = ch.deleted;
    assert.ok(deleted >= 1795 && deleted <= 1801, 'about one message per second for 30 minutes (' + deleted + ')');
    assert.ok(ch.msgs.length > 3000, 'the rest is left');
    assert.equal(i.out.edits.at(-1).content, t('en', 'clean.timeLimit', { deletedTotal: deleted }));
    assert.equal(t('en', 'clean.timeLimit', { deletedTotal: 12 }),
        '⏱️ Pingway stopped cleaning after 30 minutes: this channel has too many old messages to clear. Deleted so far: 12.');
    assert.equal(lock.isLocked(lock.channelKey('OLD')), false);
});

test('30-minute limit: when the reply can no longer be edited (token expired), the stop message is a follow-up', async (tt) => {
    tt.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
    const start = Date.now();
    const ch = fakeChannel('OLD2', { old: 3000, now: start });
    const i = cleanInteraction(ch, 'all', {
        async editReply(x) { if (Date.now() - start > 15 * 60 * 1000) throw new Error('Invalid Webhook Token'); this.out.edits.push(x); }
    });
    i.out.followUps = [];
    i.followUp = async x => { i.out.followUps.push(x); };
    let done = false;
    const run = clean.execute(i).then(() => { done = true; });
    while (!done) { await flush(); tt.mock.timers.tick(1000); }
    await run;
    assert.equal(i.out.followUps.length, 1);
    assert.equal(i.out.followUps[0].content, t('en', 'clean.timeLimit', { deletedTotal: ch.deleted }));
    assert.deepEqual(i.out.followUps[0].flags, [64]);
});

test('a short clean (any target) is not affected by the limit', async () => {
    const ch = fakeChannel('S', { recent: 10 });
    const i = cleanInteraction(ch, '4');
    await clean.execute(i);
    assert.equal(ch.deleted, 4);
    assert.equal(i.out.edits.at(-1).content, t('en', 'clean.complete', { deletedTotal: 4 }));
});
