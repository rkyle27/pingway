// Tests for the /vc Google voice rules (free period, caller, member characters, hourly limit, kill switch)
// and the My Settings voice options (nickname, max characters). Plain node, no Discord / Google / DB:
//   node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V = p => require(path.join(ROOT, 'utils', 'voice', p));

const members = V('members');
const settings = V('settings');
const tts = V('tts');
const panel = V('panel');
const reader = V('reader');
const sessionMod = V('session');
const { cleanText } = V('textClean');

const flush = () => new Promise(r => setImmediate(r));
const AFTER = Date.parse('2027-03-01T00:00:00Z');   // after the free period
const DURING = Date.parse('2026-12-01T00:00:00Z');  // during it

const realLog = console.log;
const realErr = console.error;
test.before(() => { console.log = () => {}; console.error = () => {}; });
test.after(() => { console.log = realLog; console.error = realErr; });

// kill switch file in a temp folder for every test (never the real bot folder)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-voice-'));
settings._setPath(path.join(TMP, 'voice-settings.json'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ------------------------------------------------------------------ fakes
const SW_ON = { isGoogleOn: () => true };
const SW_OFF = { isGoogleOn: () => false };

function fakeMembers({ googleOn = true, left = 0, maxChars = 200, nick = null } = {}) {
    const m = {
        spent: [],
        set: { googleOn, nickname: nick, maxChars },
        left,
        getUserSettings: async () => m.set,
        charsLeft: async () => m.left,
        spend: async (userId, n) => { m.spent.push([userId, n]); m.left = Math.max(0, m.left - n); return n; }
    };
    return m;
}

function fakeSession({ caller = 'u1', present = true, now = AFTER } = {}) {
    const s = { callerId: caller, googleWindow: [], memberGoogleUsed: false, charsNoteSent: false, notes: [], present, t: now };
    s.clock = { now: () => s.t };
    s.callerPresent = () => !!s.callerId && s.present;
    s.sendNote = text => s.notes.push(text);
    return s;
}

function fakeUsage({ limit = 1000, chars = 0, blocked = false } = {}) {
    const u = { log: [], chars, blocked };
    u.check = async n => (u.blocked ? { ok: false, reason: 'quota' } : u.chars + n > limit ? { ok: false, reason: 'limit' } : { ok: true });
    u.add = n => { u.chars += n; u.log.push(['add', n]); };
    u.block = r => { u.blocked = true; u.log.push(['block', r]); };
    u.state = () => ({ day: '2026-11-05', chars: u.chars, reason: u.blocked ? 'quota' : u.chars >= limit ? 'limit' : null });
    return u;
}
const fakeEspeak = () => ({ calls: [], isInstalled: () => true, async synthesize(text, voice) { this.calls.push(text); return Buffer.alloc(3840); } });
const googleOk = async () => ({ ok: true, status: 200, json: async () => ({ audioContent: Buffer.from('OggS').toString('base64') }) });
const google500 = async () => ({ ok: false, status: 500, json: async () => ({ error: { status: 'INTERNAL' } }) });

/** speak() the way realDeps does, with fakes */
function speakFor(session, text, { mem, usage = fakeUsage(), fetchImpl = googleOk, sw = SW_ON, espeak = fakeEspeak() } = {}) {
    return tts.speak(text, 'en-US-Standard-C', {
        key: 'AIzaFAKE', googleOn: sw.isGoogleOn(), espeak, usage, fetchImpl,
        plan: chars => members.planGoogle(session, chars, { members: mem, killSwitch: sw })
    });
}

// ------------------------------------------------------------------ free period
test('free period ends 2027-02-01 00:00 Japan time (JST boundary), env override', () => {
    const old = process.env.TTS_FREE_UNTIL;
    delete process.env.TTS_FREE_UNTIL;
    assert.equal(members.freeUntil(), Date.parse('2027-01-31T15:00:00Z'));
    assert.equal(members.isFreePeriod(Date.parse('2027-01-31T14:59:59.999Z')), true, '23:59:59 JST Jan 31');
    assert.equal(members.isFreePeriod(Date.parse('2027-01-31T15:00:00Z')), false, '00:00 JST Feb 1');
    process.env.TTS_FREE_UNTIL = '2026-12-01T00:00:00+09:00';
    assert.equal(members.freeUntil(), Date.parse('2026-11-30T15:00:00Z'));
    process.env.TTS_FREE_UNTIL = String(Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(members.freeUntil(), Date.parse('2026-01-01T00:00:00Z'), 'ms number');
    process.env.TTS_FREE_UNTIL = 'not a date';
    assert.equal(members.freeUntil(), members.FREE_UNTIL_DEFAULT);
    if (old === undefined) delete process.env.TTS_FREE_UNTIL; else process.env.TTS_FREE_UNTIL = old;
});

test('during the free period: Google for everyone, daily cap applies, no member characters used', async () => {
    const s = fakeSession({ caller: null, now: DURING }); // no caller at all
    const mem = fakeMembers({ left: 0 });
    const u = fakeUsage();
    const out = await speakFor(s, 'hello there', { mem, usage: u });
    assert.equal(out.engine, 'google');
    assert.deepEqual(u.log, [['add', 11]], 'counted in the free daily counter');
    assert.equal(mem.spent.length, 0, 'no member characters');
    // daily cap reached -> backup, as today
    const full = fakeUsage({ chars: 1000 });
    assert.equal((await speakFor(fakeSession({ now: DURING }), 'hi', { mem, usage: full })).engine, 'espeak');
});

// ------------------------------------------------------------------ after the free period
test('after the free period: caller present + switch on + characters -> Google, characters taken, no daily cap', async () => {
    const s = fakeSession();
    const mem = fakeMembers({ left: 5000 });
    const u = fakeUsage({ chars: 1000 }); // free daily cap already used up: does not matter for member use
    const out = await speakFor(s, 'Ana says: hi', { mem, usage: u });
    assert.equal(out.engine, 'google');
    assert.deepEqual(mem.spent, [['u1', 12]]);
    assert.deepEqual(u.log, [], 'member use is not counted as free use');
});

test('a Google quota block still means backup for member use', async () => {
    const mem = fakeMembers({ left: 5000 });
    const out = await speakFor(fakeSession(), 'hi', { mem, usage: fakeUsage({ blocked: true }) });
    assert.equal(out.engine, 'espeak');
    assert.equal(mem.spent.length, 0);
});

test('caller present / absent / none', async () => {
    const mem = fakeMembers({ left: 5000 });
    const s = fakeSession({ present: false });
    assert.equal((await members.planGoogle(s, 10, { members: mem, killSwitch: SW_ON })).reason, 'caller_away');
    assert.equal((await speakFor(s, 'hi', { mem })).engine, 'espeak');
    s.present = true; // caller came back
    assert.equal((await speakFor(s, 'hi', { mem })).engine, 'google');
    const none = fakeSession({ caller: null });
    assert.equal((await members.planGoogle(none, 10, { members: mem, killSwitch: SW_ON })).reason, 'no_caller');
});

test('not a member (no characters) -> backup, and no note', async () => {
    const s = fakeSession();
    const mem = fakeMembers({ left: 0 });
    assert.equal((await speakFor(s, 'hi', { mem })).engine, 'espeak');
    assert.deepEqual(s.notes, []);
});

test('characters run out mid-call -> backup voice and ONE short note that never says who pays', async () => {
    const s = fakeSession();
    const mem = fakeMembers({ left: 30 });
    assert.equal((await speakFor(s, 'x'.repeat(20), { mem })).engine, 'google');
    assert.equal((await speakFor(s, 'x'.repeat(20), { mem })).engine, 'google', 'the last message may go over by at most itself');
    assert.equal(mem.left, 0);
    assert.equal((await speakFor(s, 'one', { mem })).engine, 'espeak');
    assert.equal((await speakFor(s, 'two', { mem })).engine, 'espeak');
    assert.deepEqual(s.notes, [members.OUT_OF_CHARS_NOTE]);
    assert.match(s.notes[0], /Google voice ended for this call, using the backup voice/);
    assert.doesNotMatch(s.notes[0], /u1|<@|member|paid|pay|Ko-fi/i);
});

test('caller switches Google off mid-call -> backup from the next message', async () => {
    const s = fakeSession();
    const mem = fakeMembers({ left: 5000 });
    assert.equal((await speakFor(s, 'hi', { mem })).engine, 'google');
    mem.set = { ...mem.set, googleOn: false };
    assert.equal((await speakFor(s, 'hi again', { mem })).engine, 'espeak');
    assert.equal(mem.spent.length, 1);
    assert.deepEqual(s.notes, [], 'switching off is not "ran out"');
});

test('characters are taken only when Google accepted the text', async () => {
    const s = fakeSession();
    const mem = fakeMembers({ left: 5000 });
    const out = await speakFor(s, 'hello', { mem, fetchImpl: google500 });
    assert.equal(out.engine, 'espeak');
    assert.deepEqual(mem.spent, []);
    assert.deepEqual(s.googleWindow, [], 'not counted in the hourly window either');
});

test('per call: max 20,000 Google characters per rolling hour (free period and after)', async () => {
    for (const now of [DURING, AFTER]) {
        const s = fakeSession({ now });
        const mem = fakeMembers({ left: 1e9 });
        s.googleWindow.push({ at: now - 10 * 60000, n: 19990 });
        assert.equal((await members.planGoogle(s, 10, { members: mem, killSwitch: SW_ON })).google, true, '19,990 + 10 is allowed');
        const blocked = await members.planGoogle(s, 11, { members: mem, killSwitch: SW_ON });
        assert.deepEqual([blocked.google, blocked.reason], [false, 'hourly']);
        assert.equal((await speakFor(s, 'x'.repeat(11), { mem, usage: fakeUsage({ limit: 1e9 }) })).engine, 'espeak');
        s.t = now + 50 * 60000; // the old entry is now more than an hour old
        assert.equal((await members.planGoogle(s, 11, { members: mem, killSwitch: SW_ON })).google, true);
        assert.equal(members.windowUsed(s, s.t), 0);
    }
});

test('kill switch: off = backup for everyone (free period and members)', async () => {
    const mem = fakeMembers({ left: 5000 });
    for (const now of [DURING, AFTER]) {
        const s = fakeSession({ now });
        const p = await members.planGoogle(s, 5, { members: mem, killSwitch: SW_OFF });
        assert.deepEqual([p.google, p.reason], [false, 'switch']);
        assert.equal((await speakFor(s, 'hi', { mem, sw: SW_OFF })).engine, 'espeak');
    }
    assert.equal(mem.spent.length, 0);
    assert.deepEqual(tts.engineStatus({ key: 'k', espeak: fakeEspeak(), usage: fakeUsage(), googleOn: false }), { mode: 'backup', reason: 'switch' });
});

// ------------------------------------------------------------------ kill switch file
test('voice-settings.json: missing / corrupt = on, saved value survives a "restart"', () => {
    const file = path.join(TMP, 'ks.json');
    settings._setPath(file);
    assert.equal(settings.isGoogleOn(), true, 'missing file = on');
    fs.writeFileSync(file, '{not json');
    settings._setPath(file);
    assert.equal(settings.isGoogleOn(), true, 'corrupt file = on');
    fs.writeFileSync(file, '"just a string"');
    settings._setPath(file);
    assert.equal(settings.isGoogleOn(), true);
    assert.deepEqual(settings.setGoogle(false), { google: false, saved: true });
    assert.equal(settings.isGoogleOn(), false, 'works right away');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { google: false });
    settings._setPath(file); // restart
    assert.equal(settings.isGoogleOn(), false);
    settings.setGoogle(true);
    settings._setPath(file);
    assert.equal(settings.isGoogleOn(), true);
    // unwritable place: still switches in memory, says it was not saved
    settings._setPath(path.join(TMP, 'no-such-dir', 'x.json'));
    assert.deepEqual(settings.setGoogle(false), { google: false, saved: false });
    assert.equal(settings.isGoogleOn(), false);
    settings._setPath(path.join(TMP, 'voice-settings.json'));
});

test('console: "tts", "tts google off|on"', async () => {
    settings._setPath(path.join(TMP, 'console.json'));
    const off = await settings.ttsConsole(['google', 'off']);
    assert.match(off[0], /OFF/);
    assert.equal(settings.isGoogleOn(), false);
    const mem = fakeMembers({ left: 5000 });
    const a = fakeSession({ now: AFTER });
    const b = fakeSession({ now: AFTER, present: false });
    const sessions = new Map([['g1', a], ['g2', b], ['g3', { destroyed: true }]]);
    const fakeTts = on => ({ apiKey: () => 'k', engineStatus: () => (on ? { mode: 'google', reason: null } : { mode: 'backup', reason: 'switch' }) });
    const membersApi = { ...members, planGoogle: (s, c, o) => members.planGoogle(s, c, { ...o, members: mem }) };
    let lines = await settings.ttsConsole([], { sessions, usage: fakeUsage({ chars: 1234 }), members: membersApi, tts: fakeTts(false), now: AFTER });
    assert.match(lines[0], /Google voices: OFF \(kill switch\)/);
    assert.match(lines[1], /Free period: over/);
    assert.match(lines[2], /1,234 \/ /);
    assert.match(lines[3], /Active calls: 2, using Google: 0/);
    await settings.ttsConsole(['google', 'on']);
    lines = await settings.ttsConsole([], { sessions, usage: fakeUsage(), members: membersApi, tts: fakeTts(true), now: AFTER });
    assert.match(lines[0], /Google voices: ON/);
    assert.match(lines[3], /Active calls: 2, using Google: 1/);
    lines = await settings.ttsConsole([], { sessions: new Map(), usage: fakeUsage(), members: membersApi, tts: fakeTts(true), now: DURING });
    assert.match(lines[1], /Free period: active until 2027-02-01 00:00 JST/);
    assert.match((await settings.ttsConsole(['google', 'maybe']))[0], /Usage/);
    settings._setPath(path.join(TMP, 'voice-settings.json'));
});

// ------------------------------------------------------------------ DB: lots, expiry, oldest first, cache
function fakeDb(lots, settingsRows = {}) {
    const db = { lots, settingsRows, queries: [], fail: null };
    const run = async (sql, args) => {
        db.queries.push(sql);
        if (db.fail) throw db.fail;
        const live = now => db.lots.filter(l => l.user_id === args[0] && l.chars_left > 0 && (l.expires_at === 0 || l.expires_at > now));
        if (/FROM voice_user_settings/.test(sql)) return [[db.settingsRows[args[0]]].filter(Boolean)];
        if (/SUM\(chars_left\)/.test(sql)) return [[{ left_: live(args[1]).reduce((s, l) => s + l.chars_left, 0) }]];
        if (/SELECT id, chars_left FROM tts_char_lots/.test(sql)) {
            assert.match(sql, /ORDER BY \(expires_at = 0\), expires_at, id FOR UPDATE/);
            const order = live(args[1]).sort((x, y) => ((x.expires_at === 0) - (y.expires_at === 0)) || x.expires_at - y.expires_at || x.id - y.id);
            return [order.map(l => ({ id: l.id, chars_left: l.chars_left }))];
        }
        if (/^UPDATE tts_char_lots/.test(sql)) {
            const l = db.lots.find(x => x.id === args[1]);
            if (l.chars_left >= args[2]) l.chars_left -= args[0];
            return [{ affectedRows: 1 }];
        }
        throw new Error('unexpected sql ' + sql);
    };
    db.pool = {
        execute: run,
        getConnection: async () => ({ execute: run, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} })
    };
    return db;
}

test('member characters: expired lots ignored, oldest-expiring lot used first, never below zero', async () => {
    const now = AFTER;
    const db = fakeDb([
        { id: 1, user_id: 'u1', chars_left: 100, expires_at: now - 1 },          // expired
        { id: 2, user_id: 'u1', chars_left: 500, expires_at: now + 90 * 864e5 },
        { id: 3, user_id: 'u1', chars_left: 300, expires_at: now + 10 * 864e5 }, // expires first
        { id: 4, user_id: 'u1', chars_left: 50, expires_at: 0 },                 // never expires: last
        { id: 5, user_id: 'u2', chars_left: 999, expires_at: now + 864e5 }
    ]);
    let t = now;
    const m = members.createMembers({ getPool: () => db.pool, clock: { now: () => t } });
    assert.equal(await m.charsLeft('u1'), 850);
    await m.spend('u1', 350);
    assert.deepEqual(db.lots.map(l => l.chars_left), [100, 450, 0, 50, 999]);
    assert.equal(await m.charsLeft('u1'), 500, 'cache is lowered right away');
    await m.spend('u1', 600); // more than left: takes what is there, never negative
    assert.deepEqual(db.lots.map(l => l.chars_left), [100, 0, 0, 0, 999]);
    t += 61000;
    assert.equal(await m.charsLeft('u1'), 0);
});

test('member characters: a missing table means none (no crash, no log spam)', async () => {
    const db = fakeDb([]);
    db.fail = Object.assign(new Error("Table 'x.tts_char_lots' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    const m = members.createMembers({ getPool: () => db.pool });
    assert.equal(await m.charsLeft('u1'), 0);
    assert.deepEqual(await m.getUserSettings('u1'), { googleOn: true, nickname: null, maxChars: 200 });
    assert.equal(await m.spend('u1', 10), 0);
    const broken = members.createMembers({ getPool: () => { throw new Error('Cannot find module mysql2'); } });
    assert.equal(await broken.charsLeft('u1'), 0);
    assert.equal((await broken.getUserSettings('u1')).maxChars, 200);
});

test('settings from My Settings: read, cleaned, cached at most 60 s', async () => {
    const db = fakeDb([], { u1: { google_on: 1, nickname: ' <@123456789012345678> Riv  https://evil.example ', max_chars: 50 } });
    let t = AFTER;
    const m = members.createMembers({ getPool: () => db.pool, clock: { now: () => t } });
    assert.deepEqual(await m.getUserSettings('u1'), { googleOn: true, nickname: 'Riv', maxChars: 50 });
    db.settingsRows.u1 = { google_on: 0, nickname: null, max_chars: 5 };
    t += 30000;
    assert.equal((await m.getUserSettings('u1')).googleOn, true, 'cached');
    t += 31000;
    assert.deepEqual(await m.getUserSettings('u1'), { googleOn: false, nickname: null, maxChars: 200 }, 'bad max -> 200');
});

// ------------------------------------------------------------------ nickname + max characters
test('nickname cleaning (same rules as the website)', () => {
    const c = members.cleanNickname;
    assert.equal(c(''), null);
    assert.equal(c(null), null);
    assert.equal(c('   '), null);
    assert.equal(c('River Zola'), 'River Zola');
    assert.equal(c('**River**'), 'River');
    assert.equal(c('hi <@123456789012345678> @everyone'), 'hi everyone');
    assert.equal(c('go https://x.y/z now'), 'go now');
    assert.equal(c('visit www.evil.com'), 'visit');
    assert.equal(c('my discord.gg/abc'), 'my');
    assert.equal(c('[click](https://x.y)'), 'click');
    assert.equal(c('<a:dance:123456789012345678>'), 'dance');
    assert.equal(c('a\u0000b\u202ec'), 'a b c');
    assert.equal(c('!!!'), null, 'needs a letter or number');
    assert.equal(Array.from(c('名'.repeat(50))).length, 32);
    assert.equal(c('x'.repeat(40)).length, 32);
});

test('max characters per message: clamp + cleanText cut', () => {
    assert.equal(members.clampMaxChars(20), 20);
    assert.equal(members.clampMaxChars(200), 200);
    for (const bad of [19, 201, 0, -5, 50.5, 'abc', null, undefined]) assert.equal(members.clampMaxChars(bad), 200, String(bad));
    const long = 'word '.repeat(100);
    assert.ok(cleanText(long, {}, 20).length <= 20);
    assert.ok(cleanText(long, {}).length <= 200 && cleanText(long, {}).length > 150);
    assert.ok(cleanText(long, {}, 999).length <= 200, 'never above 200');
});

test('reader: caller max applies to everyone in the call; each speaker\'s nickname is read', async () => {
    reader._reset();
    const spoken = [];
    const session = { channelId: 'vc1', callerId: 'caller', enqueueTts: (text, voice) => { spoken.push(text); return true; } };
    const per = { caller: { googleOn: true, nickname: 'Boss', maxChars: 20 }, u2: { googleOn: true, nickname: 'Kenny', maxChars: 200 } };
    const mem = { getUserSettings: async id => per[id] || { googleOn: true, nickname: null, maxChars: 200 } };
    const store = { getUserVoice: async () => null, getGuildSettings: async () => ({ defaultVoice: null, djRoleId: null }) };
    const guild = { id: 'g1', members: { cache: new Map() }, roles: { cache: new Map() }, channels: { cache: new Map() } };
    const msg = (id, name, content) => ({ guild, content, channel: { id: 'vc1' }, author: { id, bot: false }, member: { displayName: name, voice: { channelId: 'vc1' } }, attachments: new Map(), mentions: {} });
    const h = (m, now) => reader.handleMessage(m, { getSession: () => session, store, members: mem, now });
    assert.equal(await h(msg('u2', 'Ken', 'this is a rather long message that goes on'), 0), 'queued');
    assert.equal(await h(msg('u3', 'Ana', 'short one'), 1000), 'queued');
    assert.ok(spoken[0].startsWith('Kenny says: '), 'nickname instead of display name');
    assert.ok(spoken[0].slice('Kenny says: '.length).length <= 20, 'caller max (20) applied to another speaker');
    assert.equal(spoken[1], 'Ana says: short one', 'no nickname -> display name');
    session.callerId = null;
    assert.equal(await h(msg('u3', 'Ana', 'word '.repeat(60)), 5000), 'queued');
    assert.ok(spoken[2].length > 100, 'no caller -> 200');
});

// ------------------------------------------------------------------ session caller + panel
function fakeVoiceLib() {
    class P extends EventEmitter {
        constructor() { super(); this.state = { status: 'idle' }; }
        play(r) { const o = this.state; this.state = { status: 'playing', resource: r }; this.emit('stateChange', o, this.state); }
        pause() { return true; } unpause() { return true; }
        stop() { const o = this.state; this.state = { status: 'idle' }; this.emit('stateChange', o, this.state); return true; }
    }
    return {
        NoSubscriberBehavior: { Pause: 'pause' },
        AudioPlayerStatus: { Idle: 'idle', Playing: 'playing', Paused: 'paused' },
        StreamType: { OggOpus: 'ogg/opus', Raw: 'raw' },
        VoiceConnectionStatus: { Destroyed: 'destroyed' },
        createAudioPlayer: () => new P(),
        createAudioResource: (input, opts) => ({ input, opts })
    };
}

test('session: synthesize gets the session; caller set / replaced; note helper is safe', async () => {
    const calls = [];
    const conn = { state: { status: 'ready' }, subscribe() {}, destroy() {} };
    const timers = { setTimeout: () => 1, clearTimeout: () => {}, now: () => AFTER };
    const s = new sessionMod.VoiceSession({
        guildId: 'g', channelId: 'vc1', voice: fakeVoiceLib(), connection: conn,
        deps: { clock: timers, synthesize: async (text, voice, session) => { calls.push(session); return Buffer.from('OggS'); } }
    });
    assert.equal(s.callerPresent(), false, 'no caller yet');
    let here = true;
    const notes = [];
    s.setCaller('a', { isPresent: () => here, sendNote: t => notes.push(t) });
    assert.equal(s.callerPresent(), true);
    here = false;
    assert.equal(s.callerPresent(), false);
    s.memberGoogleUsed = true;
    s.charsNoteSent = true;
    s.setCaller('b', { isPresent: () => { throw new Error('x'); }, sendNote: () => Promise.reject(new Error('no perms')) });
    assert.equal(s.callerId, 'b');
    assert.equal(s.memberGoogleUsed, false, 'new caller -> fresh call state');
    assert.equal(s.charsNoteSent, false);
    assert.equal(s.callerPresent(), false, 'errors = away');
    s.sendNote('x'); // rejected promise is caught
    await flush();
    s.enqueueTts('hi', 'v');
    await flush();
    assert.equal(calls[0], s);
    s.destroy();
});

test('vc.js: the person whose /vc joins or moves Pingway becomes the caller', () => {
    const vc = require(path.join(ROOT, 'commands', 'vc.js'));
    const sent = [];
    const guild = {
        voiceStates: { cache: new Map([['u9', { channelId: 'vc2' }]]) },
        channels: { cache: new Map([['vc2', { send: p => sent.push(p) }]]) }
    };
    const s = { channelId: 'vc2', setCaller(id, hooks) { this.callerId = id; this.hooks = hooks; } };
    vc._internal.setCaller(s, guild, 'u9');
    assert.equal(s.callerId, 'u9');
    assert.equal(s.hooks.isPresent(), true);
    s.channelId = 'vc3'; // moved away from the caller
    assert.equal(s.hooks.isPresent(), false);
    s.channelId = 'vc2';
    s.hooks.sendNote(members.OUT_OF_CHARS_NOTE);
    assert.deepEqual(sent[0], { content: members.OUT_OF_CHARS_NOTE, allowedMentions: { parse: [] } });
});

test('panel only ever says "Google voice" / "backup voice", never who pays', async () => {
    const vc = require(path.join(ROOT, 'commands', 'vc.js'));
    const { callEngine } = vc._internal;
    const g = () => ({ mode: 'google', reason: null });
    assert.deepEqual(await callEngine({}, { engineStatus: g, plan: async () => ({ google: false, reason: 'no_chars' }) }), { mode: 'backup', reason: 'call' });
    assert.deepEqual(await callEngine({}, { engineStatus: g, plan: async () => ({ google: false, reason: 'caller_away' }) }), { mode: 'backup', reason: 'call' });
    assert.deepEqual(await callEngine({}, { engineStatus: () => ({ mode: 'backup', reason: 'limit' }), plan: async () => ({ google: true, reason: 'member' }) }), { mode: 'google', reason: null });
    assert.deepEqual(await callEngine(null, { engineStatus: g, plan: async () => { throw new Error('not called'); } }), { mode: 'google', reason: null });

    const base = { status: { channelId: 'vc1', nowPlaying: null, speaking: false, musicQueue: 0, ttsQueue: 0 }, voiceReady: true, ttsEnabled: true, voiceName: 'en-US-Standard-C', voiceIsDefault: true, selectedLang: null, available: null, radioResults: null, moveOffer: null, djRoleId: null, notice: null };
    for (const eng of [{ mode: 'backup', reason: 'call' }, { mode: 'backup', reason: 'switch' }, { mode: 'google', reason: null }]) {
        const p = panel.buildPanel({ ...base, ttsEngine: eng });
        const all = JSON.stringify(p);
        assert.doesNotMatch(all, /caller|member|Ko-?fi|paid|pays|supporter|characters left/i, JSON.stringify(eng));
        if (eng.mode === 'backup') assert.match(p.embeds[0].description, /backup voice/);
    }
    assert.match(panel.buildPanel({ ...base, ttsEngine: { mode: 'backup', reason: 'call' } }).embeds[0].description, /Using the backup voice for this call/);
});

test('rate: 20,000 Google characters per call per rolling hour constant', () => {
    assert.equal(members.CALL_HOURLY_MAX, 20000);
    assert.equal(members.HOUR_MS, 3600000);
});
