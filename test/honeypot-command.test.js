// /honeypot as ONE command with options (no sub-commands): action (Set channel / Turn off / DM alerts / Warning message /
// Status), channel (for Set channel), on (for DM alerts and Warning message). Same behaviour and saved settings as before;
// wrong option combinations get a friendly message in the user's language.
// Plain node, no Discord / database:  node --test test/honeypot-command.test.js
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
    return new Proxy(fn, { get(_t, k) { if (k === 'then') return undefined; if (k === Symbol.toPrimitive) return () => ''; return stub(); }, apply() { return stub(); }, construct() { return stub(); } });
}
const PERM = { BanMembers: 4n, ManageMessages: 8192n, Administrator: 8n };
inject('shim:discord.js', new Proxy({ MessageFlags: { Ephemeral: 64 }, PermissionFlagsBits: PERM, ChannelType: { GuildText: 0 } }, { get(o, k) { return k in o ? o[k] : stub(); } }));
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'discord.js') return 'shim:discord.js';
    return origResolve.call(this, request, ...rest);
};
const lang = { v: 'en' };
inject(path.join(ROOT, 'utils', 'userLanguage.js'), { forInteraction: async () => lang.v });
// the honeypot settings (utils/honeypot.js) are recorded, not saved
const calls = [];
const traps = new Map();
inject(path.join(ROOT, 'utils', 'honeypot.js'), {
    setChannel: async (_c, g, ch) => { calls.push(['setChannel', g, ch]); if (ch) traps.set(g, Object.assign(traps.get(g) || { dm: true, warning: true }, { channelId: ch })); else traps.delete(g); },
    setDm: async (g, on) => { calls.push(['setDm', g, on]); if (traps.get(g)) traps.get(g).dm = on; },
    setWarning: async (_c, g, on) => { calls.push(['setWarning', g, on]); if (traps.get(g)) traps.get(g).warning = on; },
    getTrap: g => traps.get(g) || null
});

const { t } = require('../utils/i18n');
const cmd = require('../commands/honeypot');

function hp({ action, channel = null, on = null, perms = [PERM.BanMembers, PERM.ManageMessages] }) {
    const out = [];
    return {
        out, client: {}, locale: 'en-US', user: { id: 'u' },
        guild: { id: 'g1', members: { me: { permissions: { has: p => perms.includes(p) } } } },
        options: {
            getString: n => (n === 'action' ? action : null),
            getChannel: n => (n === 'channel' ? channel : null),
            getBoolean: n => (n === 'on' ? on : null),
            getSubcommand: () => { throw new Error('/honeypot has no sub-commands'); }
        },
        reply: async x => { out.push(x); }
    };
}
const run = async o => { const i = hp(o); await cmd.execute(i); assert.equal(i.out.length, 1); assert.deepEqual(i.out[0].flags, [64]); return i.out[0].content; };

test('Set channel saves the channel (same reply as before)', async () => {
    calls.length = 0; traps.clear(); lang.v = 'en';
    const c = await run({ action: 'set', channel: { id: 'c9' } });
    assert.deepEqual(calls, [['setChannel', 'g1', 'c9']]);
    assert.equal(c, t('en', 'honeypot.isNow', { channelId: 'c9', posted: t('en', 'honeypot.posted'), permNote: '' }));
});

test('Turn off, DM alerts on/off, Warning message on/off, Status', async () => {
    calls.length = 0; traps.clear(); lang.v = 'en';
    await run({ action: 'set', channel: { id: 'c1' } });
    assert.equal(await run({ action: 'dm', on: false }), t('en', 'honeypot.dmOff'));
    assert.equal(await run({ action: 'dm', on: true }), t('en', 'honeypot.dmOn'));
    assert.equal(await run({ action: 'warning', on: false }), t('en', 'honeypot.warningOff'));
    assert.equal(await run({ action: 'warning', on: true }), t('en', 'honeypot.warningOn'));
    assert.equal(await run({ action: 'status' }), t('en', 'honeypot.status', { channelId: 'c1', dm: 'on', warning: 'on', permNote: '' }));
    assert.equal(await run({ action: 'off' }), t('en', 'honeypot.turnedOff'));
    assert.equal(await run({ action: 'status' }), t('en', 'honeypot.statusOff', { permNote: '' }));
    assert.match(t('en', 'honeypot.statusOff', { permNote: '' }), /`\/honeypot action: Set channel`/);
    assert.deepEqual(calls.map(c => c[0] + ':' + c[2]), ['setChannel:c1', 'setDm:false', 'setDm:true', 'setWarning:false', 'setWarning:true', 'setChannel:null']);
});

test('missing permissions note is still shown', async () => {
    traps.clear(); lang.v = 'en';
    const c = await run({ action: 'status', perms: [] });
    assert.match(c, /Pingway is missing \*\*Ban Members and Manage Messages\*\*/);
});

test('wrong option combinations: friendly messages, nothing saved', async () => {
    calls.length = 0; lang.v = 'en';
    assert.equal(await run({ action: 'set' }), t('en', 'honeypot.needChannel'));
    assert.equal(await run({ action: 'dm' }), t('en', 'honeypot.needOn', { action: 'DM alerts' }));
    assert.equal(await run({ action: 'warning' }), t('en', 'honeypot.needOn', { action: 'Warning message' }));
    assert.equal(await run({ action: 'off', channel: { id: 'c2' } }), t('en', 'honeypot.onlyChannel'));
    assert.equal(await run({ action: 'status', on: true }), t('en', 'honeypot.onlyOn'));
    assert.equal(await run({ action: 'set', channel: { id: 'c2' }, on: false }), t('en', 'honeypot.onlyOn'));
    assert.deepEqual(calls, [], 'nothing was changed');
});

test('the messages are translated (fr / de / ja), French and German use tu/du', async () => {
    for (const l of ['fr', 'de', 'ja']) {
        lang.v = l;
        const c = await run({ action: 'dm' });
        assert.equal(c, t(l, 'honeypot.needOn', { action: t(l, 'honeypot.cmd.actions.dm') }));
        assert.notEqual(c, t('en', 'honeypot.needOn', { action: 'DM alerts' }));
        assert.ok(!/\{\w+\}/.test(c), l + ': no {placeholder} left');
    }
    assert.match(t('fr', 'honeypot.needChannel'), /Remplis/);
    assert.match(t('de', 'honeypot.needChannel'), /Fülle bitte/);
    lang.v = 'en';
});
