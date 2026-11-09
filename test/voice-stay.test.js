// /vc "Stay in voice" + auto-reconnect. Plain node, no Discord / network:  node --test test/voice-stay.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sessionMod = require(path.join(ROOT, 'utils', 'voice', 'session'));
const panel = require(path.join(ROOT, 'utils', 'voice', 'panel'));
const store = require(path.join(ROOT, 'utils', 'voice', 'store'));
const { canUse } = require(path.join(ROOT, 'utils', 'voice', 'perms'));
const i18n = require(path.join(ROOT, 'utils', 'i18n'));
const { t } = i18n;

const flush = () => new Promise(r => setImmediate(r));

// ------------------------------------------------------------------ fakes (same shape as test/voice.test.js)
function fakeClock() {
    let now = 1_000_000;
    let id = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout: (fn, ms) => { const k = ++id; timers.set(k, { at: now + ms, fn }); return k; },
        clearTimeout: k => { timers.delete(k); },
        async advance(ms) {
            const end = now + ms;
            for (;;) {
                let next = null;
                for (const [k, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
                if (!next) break;
                timers.delete(next[0]);
                now = next[1].at;
                next[1].fn();
                await flush();
            }
            now = end;
        },
        pending: () => timers.size
    };
}

class FakePlayer extends EventEmitter {
    constructor() { super(); this.state = { status: 'idle' }; }
    _set(s) { const o = this.state; this.state = s; this.emit('stateChange', o, s); }
    play(resource) { this._set({ status: 'playing', resource }); }
    pause() { if (this.state.status !== 'playing') return false; this._set({ ...this.state, status: 'paused' }); return true; }
    unpause() { if (this.state.status !== 'paused') return false; this._set({ ...this.state, status: 'playing' }); return true; }
    stop() { if (this.state.status === 'idle') return false; this._set({ status: 'idle' }); return true; }
}

function fakeConnection() {
    const c = new EventEmitter();
    c.state = { status: 'ready' };
    c.subscribe = () => {};
    c.rejoins = 0;
    c.rejoin = () => { c.rejoins++; return true; };
    c.destroy = () => { c.state = { status: 'destroyed' }; c.destroyed = true; };
    c._set = status => { const o = c.state; c.state = { status }; c.emit('stateChange', o, c.state); };
    return c;
}

function fakeVoice() {
    const conns = [];
    return {
        conns,
        NoSubscriberBehavior: { Pause: 'pause' },
        AudioPlayerStatus: { Idle: 'idle', Playing: 'playing', Paused: 'paused', Buffering: 'buffering', AutoPaused: 'autopaused' },
        StreamType: { OggOpus: 'ogg/opus', Raw: 'raw' },
        VoiceConnectionStatus: { Ready: 'ready', Destroyed: 'destroyed', Disconnected: 'disconnected', Signalling: 'signalling', Connecting: 'connecting' },
        createAudioPlayer: () => new FakePlayer(),
        createAudioResource: (input, opts) => ({ input, opts, playbackDuration: 0 }),
        joinVoiceChannel(cfg) { const c = fakeConnection(); c.cfg = cfg; conns.push(c); return c; },
        entersState: async () => {}
    };
}

function fakeDeps(clock) {
    return {
        clock,
        ttsEnabled: () => true,
        synthesize: async () => Buffer.from('OggS-fake'),
        openAudio: async url => ({ stream: new PassThrough(), live: false, title: null, url }),
        spawnFfmpeg: () => {
            const proc = new EventEmitter();
            proc.stdin = new PassThrough();
            proc.stdout = new PassThrough();
            proc.kill = () => { proc.killed = true; };
            return { proc, ogg: true };
        }
    };
}

function newSession() {
    const clock = fakeClock();
    const voice = fakeVoice();
    const connection = fakeConnection();
    const s = new sessionMod.VoiceSession({ guildId: 'g1', channelId: 'vc1', voice, connection, deps: fakeDeps(clock) });
    return { s, clock, connection };
}

const realLog = console.log;
const realErr = console.error;
test.before(() => { console.log = () => {}; console.error = () => {}; });
test.after(() => { console.log = realLog; console.error = realErr; });

// ------------------------------------------------------------------ session
test('stay mode: no 15-min idle leave while humans are in the channel', async () => {
    const { s, clock } = newSession();
    s.setHumanCount(2);
    assert.equal(s.setStay(true), true);
    await clock.advance(3 * 60 * 60000); // 3 hours of silence
    assert.equal(s.destroyed, false);
    assert.equal(s.status().stay, true);
});

test('stay mode: still leaves 1 minute after everyone left', async () => {
    const { s, clock, connection } = newSession();
    s.setHumanCount(1);
    s.setStay(true);
    await clock.advance(20 * 60000);
    s.setHumanCount(0);
    await clock.advance(59000);
    assert.equal(s.destroyed, false);
    await clock.advance(1000);
    assert.equal(s.destroyed, true, 'alone timer (60 s) unchanged');
    assert.equal(connection.destroyed, true);
    assert.equal(clock.pending(), 0);
});

test('stay mode: someone coming back within the minute keeps it in voice', async () => {
    const { s, clock } = newSession();
    s.setHumanCount(1);
    s.setStay(true);
    s.setHumanCount(0);
    await clock.advance(30000);
    s.setHumanCount(1);
    await clock.advance(60 * 60000);
    assert.equal(s.destroyed, false);
});

test('toggle twice -> off; idle leave works again (fresh 15 min)', async () => {
    const { s, clock } = newSession();
    s.setHumanCount(1);
    assert.equal(s.toggleStay(), true);
    await clock.advance(30 * 60000);
    assert.equal(s.toggleStay(), false);
    assert.equal(s.stay, false);
    await clock.advance(15 * 60000 - 1000);
    assert.equal(s.destroyed, false);
    await clock.advance(1000);
    assert.equal(s.destroyed, true);
});

test('stay off (default): unchanged 15-min idle leave', async () => {
    const { s, clock } = newSession();
    assert.equal(s.stay, false);
    s.setHumanCount(3);
    await clock.advance(15 * 60000);
    assert.equal(s.destroyed, true);
});

test('stay resets when Pingway leaves; the next /vc starts with stay off', async () => {
    const voice = fakeVoice();
    const clock = fakeClock();
    const guild = { id: 'gStay', voiceAdapterCreator: () => ({}) };
    const s1 = await sessionMod.joinChannel({ guild, channel: { id: 'c1' }, voice, deps: fakeDeps(clock) });
    s1.setHumanCount(1);
    s1.setStay(true);
    sessionMod.destroySession('gStay', 'test');
    assert.equal(s1.stay, false);
    assert.equal(s1.setStay(true), false, 'a destroyed session cannot be switched on');
    const s2 = await sessionMod.joinChannel({ guild, channel: { id: 'c1' }, voice, deps: fakeDeps(clock) });
    assert.notEqual(s2, s1);
    assert.equal(s2.stay, false);
    sessionMod.destroySession('gStay', 'test');
});

// ------------------------------------------------------------------ reconnect
async function joinWith(entersState) {
    const voice = fakeVoice();
    const clock = fakeClock();
    const guild = { id: 'gR' + Math.random(), voiceAdapterCreator: () => ({}) };
    const s = await sessionMod.joinChannel({ guild, channel: { id: 'c1' }, voice, deps: fakeDeps(clock) });
    voice.entersState = entersState; // after the join (which waits for Ready)
    return { s, conn: voice.conns[0], voice };
}
const until = async cond => { for (let i = 0; i < 50 && !cond(); i++) await flush(); };

test('reconnect: recovers by itself (Signalling/Connecting) -> no rejoin, stays', async () => {
    const { s, conn } = await joinWith(async () => {});
    conn._set('disconnected');
    await until(() => !s._reconnecting);
    assert.equal(conn.rejoins, 0);
    assert.equal(s.destroyed, false);
    s.destroy('test');
});

test('reconnect: no recovery -> rejoins exactly once, stays when Ready', async () => {
    const calls = [];
    const { s, conn } = await joinWith(async (_c, status) => {
        calls.push(status);
        if (status !== 'ready') throw new Error('timeout');
    });
    conn._set('disconnected');
    conn._set('disconnected'); // a second drop while handling the first is ignored
    await until(() => !s._reconnecting);
    assert.equal(conn.rejoins, 1);
    assert.ok(calls.includes('ready'));
    assert.equal(s.destroyed, false);
    s.destroy('test');
});

test('reconnect: rejoin fails -> leaves as before (once)', async () => {
    const { s, conn } = await joinWith(async () => { throw new Error('timeout'); });
    conn._set('disconnected');
    await until(() => s.destroyed);
    assert.equal(conn.rejoins, 1);
    assert.equal(s.destroyed, true);
    assert.equal(conn.destroyed, true);
});

test('reconnect: no rejoin after Pingway was disconnected on purpose', async () => {
    let release;
    const gate = new Promise((_, rej) => { release = rej; });
    const { s, conn } = await joinWith(() => gate);
    conn._set('disconnected');
    s.destroy('disconnected by someone'); // voiceStateUpdate destroyed it meanwhile
    release(new Error('timeout'));
    await until(() => !s._reconnecting);
    assert.equal(conn.rejoins, 0);
});

// ------------------------------------------------------------------ panel + permissions
test('panel: Stay button (5th button of row 2), on/off look, disabled when not connected', () => {
    const base = { voiceReady: true, ttsEnabled: true, voiceName: 'en-US-Standard-C', voiceIsDefault: true, selectedLang: null, available: null, radioResults: null, moveOffer: null, djRoleId: null, notice: null };
    const st = { channelId: 'vc1', nowPlaying: null, speaking: false, musicQueue: 0, ttsQueue: 0 };
    for (const lang of ['en', 'fr', 'de', 'ja']) {
        const off = panel.buildPanel({ ...base, lang, status: { ...st, stay: false } }).components[1].components;
        assert.equal(off.length, 5);
        const b = off[4];
        assert.equal(b.custom_id, 'vc_stay');
        assert.equal(b.label, t(lang, 'vc.panel.stayOff'));
        assert.equal(b.emoji.name, '🔓');
        assert.ok(!b.disabled);
        const on = panel.buildPanel({ ...base, lang, status: { ...st, stay: true } }).components[1].components[4];
        assert.equal(on.label, t(lang, 'vc.panel.stayOn'));
        assert.equal(on.emoji.name, '🔒');
        assert.equal(on.style, 3);
    }
    const none = panel.buildPanel({ ...base, status: null }).components[1].components[4];
    assert.equal(none.disabled, true);
});

test('permissions: stay follows the panel rules (same channel, DJ role)', () => {
    const member = ({ channel = 'vc1', roles = [] } = {}) => ({ voice: { channelId: channel }, roles: { cache: new Map(roles.map(r => [r, {}])) }, permissions: { has: () => false } });
    assert.equal(canUse('stay', { member: member(), botChannelId: 'vc1', settings: { djRoleId: null } }).ok, true);
    assert.equal(canUse('stay', { member: member({ channel: 'vc2' }), botChannelId: 'vc1', settings: { djRoleId: null } }).ok, false);
    assert.equal(canUse('stay', { member: member(), botChannelId: 'vc1', settings: { djRoleId: 'dj' } }).ok, false);
    assert.equal(canUse('stay', { member: member({ roles: ['dj'] }), botChannelId: 'vc1', settings: { djRoleId: 'dj' } }).ok, true);
});

// ------------------------------------------------------------------ command
test('/vc: optional "stay" option localized in 4 languages; plain /vc unchanged', async t2 => {
    const vc = require(path.join(ROOT, 'commands', 'vc.js'));
    assert.equal(vc.data.name, 'vc');
    assert.equal(vc.data.options.length, 1);
    const o = vc.data.options[0];
    assert.equal(o.type, 5);
    assert.equal(o.name, 'stay');
    assert.equal(o.required, false);
    assert.ok(o.description.length <= 100);
    assert.deepEqual(Object.keys(o.name_localizations).sort(), ['de', 'fr', 'ja']);
    assert.deepEqual(Object.keys(o.description_localizations).sort(), ['de', 'fr', 'ja']);
    for (const n of Object.values(o.name_localizations)) assert.match(n, /^[-_\p{L}\p{N}]{1,32}$/u, 'Discord option name');
    for (const n of Object.values(o.name_localizations)) assert.equal(n, n.toLowerCase());

    store._setPool({ execute: async sql => (/^\s*SELECT/i.test(sql) ? [[]] : [{}]) });
    const guildId = 'gCmd';
    const voice = fakeVoice();
    const clock = fakeClock();
    const guild = { id: guildId, voiceAdapterCreator: () => ({}), channels: { cache: new Map() }, members: { me: null } };
    const s = await sessionMod.joinChannel({ guild, channel: { id: 'vc1' }, voice, deps: fakeDeps(clock) });
    s.setHumanCount(1);

    const make = ({ customId = null, stay = null, inVoice = 'vc1' } = {}) => {
        const calls = [];
        return {
            calls, customId, guildId, locale: 'en-US', user: { id: 'u1' }, guild,
            member: { voice: { channelId: inVoice, channel: null }, roles: { cache: new Map() }, permissions: { has: () => false } },
            options: { getBoolean: name => (name === 'stay' ? stay : null) },
            inGuild: () => true, isButton: () => true,
            deferReply: async o => calls.push(['deferReply', o]),
            deferUpdate: async () => calls.push(['deferUpdate']),
            editReply: async p => calls.push(['editReply', p])
        };
    };
    const descOf = i => i.calls.find(c => c[0] === 'editReply')[1].embeds[0].description;

    await t2.test('panel button toggles, notice in the ephemeral panel', async () => {
        const i = make({ customId: 'vc_stay' });
        await vc.handleInteraction(i);
        assert.deepEqual(i.calls.map(c => c[0]), ['deferUpdate', 'editReply']);
        assert.equal(s.stay, true);
        assert.ok(descOf(i).includes(t('en', 'vc.stayOn')));
        const i2 = make({ customId: 'vc_stay' });
        await vc.handleInteraction(i2);
        assert.equal(s.stay, false);
        assert.ok(descOf(i2).includes(t('en', 'vc.stayOff')));
    });
    await t2.test('someone in another channel cannot toggle', async () => {
        const i = make({ customId: 'vc_stay', inVoice: 'other' });
        await vc.handleInteraction(i);
        assert.equal(s.stay, false);
        assert.match(descOf(i), /🚫/);
    });
    await t2.test('/vc stay:true / stay:false set it (ephemeral)', async () => {
        const i = make({ stay: true });
        await vc.execute(i);
        assert.deepEqual(i.calls[0], ['deferReply', { flags: 64 }]);
        assert.equal(s.stay, true);
        assert.ok(descOf(i).includes(t('en', 'vc.stayOn')));
        await vc.execute(make({ stay: false }));
        assert.equal(s.stay, false);
    });
    await t2.test('plain /vc does not change stay', async () => {
        s.setStay(true);
        const i = make({ stay: null });
        await vc.execute(i);
        assert.equal(s.stay, true);
        assert.ok(!descOf(i).includes(t('en', 'vc.stayOn')));
    });
    sessionMod.destroySession(guildId, 'test');
});
