// Tests for /vc (Pingway Voice). Plain node, no Discord / Google / network:  node test/voice.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V = p => require(path.join(ROOT, 'utils', 'voice', p));

const { cleanText, withSpeaker, MAX_CHARS } = V('textClean');
const urlSafety = V('urlSafety');
const radio = V('radio');
const tts = V('tts');
const voices = V('voices');
const { canUse } = V('perms');
const sessionMod = V('session');
const panel = V('panel');
const reader = V('reader');
const store = V('store');
const lib = V('lib');

const flush = () => new Promise(r => setImmediate(r));

// ------------------------------------------------------------------ fakes
function fakeClock() {
    let t = 1_000_000;
    let id = 0;
    const timers = new Map();
    return {
        now: () => t,
        setTimeout: (fn, ms) => { const k = ++id; timers.set(k, { at: t + ms, fn }); return k; },
        clearTimeout: k => { timers.delete(k); },
        async advance(ms) {
            const end = t + ms;
            for (;;) {
                let next = null;
                for (const [k, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
                if (!next) break;
                timers.delete(next[0]);
                t = next[1].at;
                next[1].fn();
                await flush();
            }
            t = end;
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

function fakeConnection() {
    const c = new EventEmitter();
    c.state = { status: 'ready' };
    c.subscribed = null;
    c.subscribe = p => { c.subscribed = p; };
    c.destroy = () => { c.state = { status: 'destroyed' }; c.destroyed = true; };
    return c;
}

function fakeDeps(clock, over = {}) {
    const procs = [];
    const opened = [];
    const spoken = [];
    return {
        procs, opened, spoken, clock,
        ttsEnabled: () => true,
        synthesize: async (text, voice) => { spoken.push({ text, voice }); return Buffer.from('OggS-fake'); },
        openAudio: async url => { opened.push(url); return { stream: new PassThrough(), live: /radio/.test(url), title: null, url }; },
        spawnFfmpeg: () => {
            const proc = new EventEmitter();
            proc.stdin = new PassThrough();
            proc.stdout = new PassThrough();
            proc.killed = false;
            proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('exit', null)); };
            procs.push(proc);
            return { proc, ogg: true };
        },
        ...over
    };
}

function newSession(over = {}) {
    const clock = fakeClock();
    const voice = fakeVoice();
    const deps = fakeDeps(clock, over);
    const connection = fakeConnection();
    const s = new sessionMod.VoiceSession({ guildId: 'g1', channelId: 'vc1', voice, connection, deps });
    return { s, clock, voice, deps, connection };
}

// keep test output readable
const realLog = console.log;
const realErr = console.error;
test.before(() => { console.log = () => {}; console.error = () => {}; });
test.after(() => { console.log = realLog; console.error = realErr; });

// ------------------------------------------------------------------ text cleanup
test('text cleanup', async t => {
    const r = { user: id => (id === '111111111111111111' ? 'Riverzola' : null), role: () => 'Raiders', channel: () => 'general' };
    await t.test('slash commands and empty messages are skipped', () => {
        assert.equal(cleanText('/vc', r), null);
        assert.equal(cleanText('   ', r), null);
        assert.equal(cleanText('!!!???', r), null);
    });
    await t.test('links become "a link"', () => {
        assert.equal(cleanText('look https://example.com/a?b=1 now', r), 'look a link now');
        assert.equal(cleanText('see <https://x.y/z>', r), 'see a link');
        assert.equal(cleanText('[the guide](https://x.y/z) here', r), 'the guide here');
    });
    await t.test('mentions, roles, channels, emoji', () => {
        assert.equal(cleanText('hi <@111111111111111111> and <@!222222222222222222>', r), 'hi Riverzola and someone');
        assert.equal(cleanText('<@&333333333333333333> go to <#444444444444444444>', r), 'Raiders go to general');
        assert.equal(cleanText('gg <:pepe_happy:555555555555555555> <a:dance:666666666666666666>', r), 'gg pepe happy dance');
    });
    await t.test('code blocks are dropped, inline code kept', () => {
        assert.equal(cleanText('look ```js\nconst x = "https://a.b";\n``` ok', r), 'look code ok');
        assert.equal(cleanText('run `npm i` please', r), 'run npm i please');
    });
    await t.test('repeated characters collapse but numbers stay', () => {
        assert.equal(cleanText('noooooooo!!!!!!', r), 'noo!!');
        assert.equal(cleanText('it costs 1000000 gil', r), 'it costs 1000000 gil');
    });
    await t.test('markdown and spoilers', () => {
        assert.equal(cleanText('**bold** and ||secret||', r), 'bold and spoiler');
    });
    await t.test('capped at 200 characters', () => {
        const out = cleanText('word '.repeat(100), r);
        assert.ok(out.length <= MAX_CHARS, 'length ' + out.length);
        const jp = cleanText('こんにちは世界'.repeat(60), r);
        assert.ok(Array.from(jp).length <= MAX_CHARS);
    });
    await t.test('"name says:" only when the speaker changes or after 20 s', () => {
        const last = new Map();
        const base = { guildId: 'g', lastSpeaker: last };
        assert.equal(withSpeaker('hi', { ...base, userId: 'a', displayName: 'Ana', now: 0 }), 'Ana says: hi');
        assert.equal(withSpeaker('again', { ...base, userId: 'a', displayName: 'Ana', now: 5000 }), 'again');
        assert.equal(withSpeaker('yo', { ...base, userId: 'b', displayName: 'Ben', now: 6000 }), 'Ben says: yo');
        assert.equal(withSpeaker('back', { ...base, userId: 'b', displayName: 'Ben', now: 30000 }), 'Ben says: back');
        assert.equal(withSpeaker('', { ...base, userId: 'c', displayName: '**Cy**', now: 31000, fileOnly: true }), 'Cy sent a file');
    });
});

// ------------------------------------------------------------------ URL safety
function fakeTransport(routes, seen = []) {
    // routes: { 'host/path': { status, headers, body } }
    return {
        request(options, cb) {
            const req = new EventEmitter();
            req.end = () => {
                options.lookup(options.hostname, { all: false }, (err, address) => {
                    seen.push({ host: options.hostname, path: options.path, address, ua: options.headers['User-Agent'] });
                    const route = routes[options.hostname + options.path];
                    if (!route) return req.emit('error', Object.assign(new Error('no route'), { code: 'ECONNREFUSED' }));
                    if (route.hang) return; // never answers
                    const res = new PassThrough();
                    res.statusCode = route.status || 200;
                    res.headers = route.headers || {};
                    res.setTimeout = () => {};
                    setImmediate(() => { cb(res); res.end(route.body || ''); });
                });
            };
            req.destroy = () => {};
            return req;
        }
    };
}
const DNS = {
    'radio.example': '93.184.216.34',
    'cdn.example': '151.101.1.1',
    'evil.example': '10.0.0.5',
    'rebind.example': '169.254.169.254',
    'v6local.example': 'fd00::1'
};
const lookup = async host => {
    if (!DNS[host]) throw new Error('ENOTFOUND');
    return [{ address: DNS[host], family: DNS[host].includes(':') ? 6 : 4 }];
};

test('URL safety', async t => {
    await t.test('private / reserved addresses are blocked, public ones allowed', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
            '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::3', 'ff02::1',
            '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:10.0.0.1', '2001:db8::1', '64:ff9b::a00:1', 'fe80::1%eth0', 'not-an-ip']) {
            assert.equal(urlSafety.isBlockedIp(ip), true, ip + ' should be blocked');
        }
        for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
            assert.equal(urlSafety.isBlockedIp(ip), false, ip + ' should be allowed');
        }
    });
    await t.test('bad schemes, credentials and localhost are refused', async () => {
        for (const [u, code] of [['ftp://radio.example/a.mp3', 'bad_scheme'], ['file:///etc/passwd', 'bad_scheme'], ['javascript:alert(1)', 'bad_scheme'],
            ['http://user:pw@radio.example/a.mp3', 'credentials'], ['http://localhost:8080/', 'private_address'], ['http://127.0.0.1/a.mp3', 'private_address'],
            ['http://[::1]/a.mp3', 'private_address'], ['http://evil.example/a.mp3', 'private_address'], ['http://v6local.example/', 'private_address'],
            ['not a url', 'bad_url'], ['http://nowhere.invalid/', 'dns']]) {
            await assert.rejects(urlSafety.checkUrl(u, { lookup }), e => e.code === code, u);
        }
    });
    await t.test('YouTube / Spotify / SoundCloud are refused with a message', async () => {
        for (const u of ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://music.youtube.com/x', 'https://open.spotify.com/track/x', 'https://soundcloud.com/a/b', 'https://on.soundcloud.com/x']) {
            await assert.rejects(urlSafety.checkUrl(u, { lookup }), e => e.code === 'unsupported_service' && /not supported/.test(e.message), u);
        }
    });
    await t.test('a public audio link opens, pinned to the checked address, with our User-Agent', async () => {
        const seen = [];
        const transport = fakeTransport({ 'radio.example/live': { headers: { 'content-type': 'audio/mpeg', 'icy-name': 'Test FM' } } }, seen);
        const r = await urlSafety.openAudioUrl('http://radio.example/live', { lookup, transport });
        assert.equal(r.live, true);
        assert.equal(r.title, 'Test FM');
        assert.equal(seen[0].address, '93.184.216.34');
        assert.equal(seen[0].ua, 'PingwayBot/1.0');
        r.stream.destroy();
    });
    await t.test('a file with content-length is not live', async () => {
        const transport = fakeTransport({ 'cdn.example/song.ogg': { headers: { 'content-type': 'application/ogg', 'content-length': '12345', 'accept-ranges': 'bytes' } } });
        const r = await urlSafety.openAudioUrl('https://cdn.example/song.ogg', { lookup, transport });
        assert.equal(r.live, false);
        assert.equal(r.seekable, true);
    });
    await t.test('redirect to a private address is refused', async () => {
        const transport = fakeTransport({ 'radio.example/r': { status: 302, headers: { location: 'http://evil.example/x' } } });
        await assert.rejects(urlSafety.openAudioUrl('http://radio.example/r', { lookup, transport }), e => e.code === 'private_address');
        const t2 = fakeTransport({ 'radio.example/r2': { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data' } } });
        await assert.rejects(urlSafety.openAudioUrl('http://radio.example/r2', { lookup, transport: t2 }), e => e.code === 'private_address');
        const t3 = fakeTransport({ 'radio.example/r3': { status: 307, headers: { location: 'file:///etc/passwd' } } });
        await assert.rejects(urlSafety.openAudioUrl('http://radio.example/r3', { lookup, transport: t3 }), e => e.code === 'bad_scheme');
    });
    await t.test('max 3 redirects', async () => {
        const routes = {};
        for (let i = 0; i < 5; i++) routes['radio.example/h' + i] = { status: 302, headers: { location: '/h' + (i + 1) } };
        routes['radio.example/h3'] = { headers: { 'content-type': 'audio/mpeg' } };
        const ok = await urlSafety.openAudioUrl('http://radio.example/h0', { lookup, transport: fakeTransport(routes) });
        ok.stream.destroy();
        routes['radio.example/h3'] = { status: 302, headers: { location: '/h4' } };
        await assert.rejects(urlSafety.openAudioUrl('http://radio.example/h0', { lookup, transport: fakeTransport(routes) }), e => e.code === 'too_many_redirects');
    });
    await t.test('non-audio and HLS are refused; .pls playlists are followed once', async () => {
        const transport = fakeTransport({
            'cdn.example/page': { headers: { 'content-type': 'text/html; charset=utf-8' } },
            'cdn.example/live.m3u8': { headers: { 'content-type': 'application/vnd.apple.mpegurl' } },
            'cdn.example/hls': { headers: { 'content-type': 'application/x-mpegurl' }, body: '#EXTM3U\n#EXT-X-VERSION:3\nseg.ts\n' },
            'cdn.example/list.pls': { headers: { 'content-type': 'audio/x-scpls' }, body: '[playlist]\nFile1=http://radio.example/live\nNumberOfEntries=1\n' },
            'cdn.example/bad.pls': { headers: { 'content-type': 'audio/x-scpls' }, body: '[playlist]\nFile1=http://evil.example/x\n' },
            'radio.example/live': { headers: { 'content-type': 'audio/aacp' } }
        });
        await assert.rejects(urlSafety.openAudioUrl('https://cdn.example/page', { lookup, transport }), e => e.code === 'not_audio');
        await assert.rejects(urlSafety.openAudioUrl('https://cdn.example/live.m3u8', { lookup, transport }), e => e.code === 'hls');
        await assert.rejects(urlSafety.openAudioUrl('https://cdn.example/hls', { lookup, transport }), e => e.code === 'hls');
        const r = await urlSafety.openAudioUrl('https://cdn.example/list.pls', { lookup, transport });
        assert.equal(r.contentType, 'audio/aacp');
        r.stream.destroy();
        await assert.rejects(urlSafety.openAudioUrl('https://cdn.example/bad.pls', { lookup, transport }), e => e.code === 'private_address');
    });
    await t.test('no answer within the header timeout', async () => {
        const transport = fakeTransport({ 'radio.example/slow': { hang: true } });
        await assert.rejects(urlSafety.openAudioUrl('http://radio.example/slow', { lookup, transport, headerTimeoutMs: 50 }), e => e.code === 'timeout');
        assert.equal(urlSafety.HEADER_TIMEOUT_MS, 10000);
    });
});

// ------------------------------------------------------------------ radio
test('radio search', async t => {
    const sample = [
        { stationuuid: '9617a958-0601-11e8-ae97-52543be04c81', name: '  Lofi   Hip Hop  ', url_resolved: 'https://lofi.example/stream', countrycode: 'US', bitrate: 128, codec: 'MP3', hls: 0, lastcheckok: 1 },
        { stationuuid: '9617a958-0601-11e8-ae97-52543be04c82', name: 'HLS one', url_resolved: 'https://x.example/a.m3u8', hls: 1, lastcheckok: 1 },
        { stationuuid: 'bad uuid', name: 'Bad', url_resolved: 'https://x.example/b' },
        { stationuuid: '9617a958-0601-11e8-ae97-52543be04c83', name: 'Broken', url_resolved: 'https://x.example/c', lastcheckok: 0 },
        { stationuuid: '9617a958-0601-11e8-ae97-52543be04c84', name: 'NoHttp', url_resolved: 'rtsp://x.example/d', lastcheckok: 1 },
        { stationuuid: '9617a958-0601-11e8-ae97-52543be04c85', name: 'Lofi Hip Hop', url_resolved: 'https://lofi.example/stream', lastcheckok: 1 },
        { stationuuid: '9617a958-0601-11e8-ae97-52543be04c86', name: 'J-Pop Sakura', url: 'http://jpop.example/;', countrycode: 'JP', bitrate: 0, codec: 'AAC+', lastcheckok: 1 }
    ];
    await t.test('parsing filters HLS, broken, bad entries and duplicates', () => {
        const out = radio.parseStations(sample);
        assert.deepEqual(out.map(s => s.name), ['Lofi Hip Hop', 'J-Pop Sakura']);
        assert.equal(out[0].country, 'US');
        assert.equal(out[0].bitrate, 128);
        assert.deepEqual(radio.parseStations('nope'), []);
        const many = Array.from({ length: 40 }, (_, i) => ({ stationuuid: '9617a958-0601-11e8-ae97-' + String(i).padStart(12, '0'), name: 'S' + i, url_resolved: 'https://s.example/' + i, lastcheckok: 1 }));
        assert.equal(radio.parseStations(many).length, 10);
    });
    await t.test('search calls Radio Browser with a plain User-Agent (no email) and falls back to the next server', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, ua: init.headers['User-Agent'] });
            if (url.startsWith('https://down.api.radio-browser.info')) throw new Error('down');
            return { ok: true, status: 200, json: async () => sample };
        };
        const out = await radio.searchStations('lofi hip hop', { fetchImpl, servers: ['down.api.radio-browser.info', 'de1.api.radio-browser.info'] });
        assert.equal(out.length, 2);
        assert.equal(calls.length, 2);
        const u = new URL(calls[1].url);
        assert.equal(u.hostname, 'de1.api.radio-browser.info');
        assert.equal(u.pathname, '/json/stations/search');
        assert.equal(u.searchParams.get('name'), 'lofi hip hop');
        assert.equal(u.searchParams.get('hidebroken'), 'true');
        assert.equal(calls[1].ua, 'PingwayBot/1.0');
        assert.ok(!/@/.test(calls[1].ua), 'no email in the User-Agent');
    });
    await t.test('server discovery uses the SRV record, with a fallback', async () => {
        radio._resetServerCache();
        const list = await radio.discoverServers({ resolveSrv: async () => [{ name: 'at1.api.radio-browser.info' }, { name: 'evil.example.com' }] });
        assert.deepEqual(list, ['at1.api.radio-browser.info']);
        radio._resetServerCache();
        const fb = await radio.discoverServers({ resolveSrv: async () => { throw new Error('no dns'); } });
        assert.ok(fb.includes('de1.api.radio-browser.info'));
        radio._resetServerCache();
    });
    await t.test('click counting returns the fresh URL or the cached one', async () => {
        const ok = await radio.clickStation('abc', 'https://old', { servers: ['de1.api.radio-browser.info'], fetchImpl: async u => ({ ok: true, json: async () => ({ ok: true, url: 'https://new.example/s' }), u }) });
        assert.equal(ok, 'https://new.example/s');
        const fb = await radio.clickStation('abc', 'https://old', { servers: ['de1.api.radio-browser.info'], fetchImpl: async () => { throw new Error('x'); } });
        assert.equal(fb, 'https://old');
    });
});

// ------------------------------------------------------------------ TTS
test('Google TTS request', async t => {
    const KEY = 'AIzaFAKE-test-key-123';
    await t.test('key only in the header, never in the URL; OGG_OPUS 48 kHz; voice params', () => {
        const { url, init } = tts.buildRequest('Ana says: hello', 'ja-JP-Wavenet-A', KEY);
        assert.equal(url, 'https://texttospeech.googleapis.com/v1/text:synthesize');
        assert.ok(!url.includes(KEY) && !url.includes('key='));
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['X-Goog-Api-Key'], KEY);
        const body = JSON.parse(init.body);
        assert.deepEqual(body.voice, { languageCode: 'ja-JP', name: 'ja-JP-Wavenet-A' });
        assert.equal(body.audioConfig.audioEncoding, 'OGG_OPUS');
        assert.equal(body.audioConfig.sampleRateHertz, 48000);
        assert.equal(body.input.text, 'Ana says: hello');
        assert.ok(!init.body.includes(KEY));
        assert.deepEqual(JSON.parse(tts.buildRequest('x', 'cmn-CN-Standard-A', KEY).init.body).voice.languageCode, 'cmn-CN');
        assert.deepEqual(JSON.parse(tts.buildRequest('x', 'fil-PH-Wavenet-A', KEY).init.body).voice.languageCode, 'fil-PH');
    });
    await t.test('synthesize decodes audioContent; 400 retries with the language only', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, body: JSON.parse(init.body), key: init.headers['X-Goog-Api-Key'] });
            if (JSON.parse(init.body).voice.name) return { ok: false, status: 400, json: async () => ({ error: { status: 'INVALID_ARGUMENT', message: 'bad voice' } }) };
            return { ok: true, status: 200, json: async () => ({ audioContent: Buffer.from('OggS123').toString('base64') }) };
        };
        const buf = await tts.synthesize('hello', 'ko-KR-Wavenet-A', { fetchImpl, key: KEY });
        assert.equal(buf.toString(), 'OggS123');
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].body.voice, { languageCode: 'ko-KR' });
        assert.ok(calls.every(c => !c.url.includes(KEY)));
    });
    await t.test('errors never include the key or the text', async () => {
        const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: { status: 'PERMISSION_DENIED', message: 'key ' + KEY + ' text secret words' } }) });
        await assert.rejects(tts.synthesize('secret words', 'en-US-Standard-C', { fetchImpl, key: KEY }), e => {
            assert.ok(!e.message.includes(KEY) && !e.message.includes('secret'));
            assert.equal(e.reason, 'PERMISSION_DENIED');
            return true;
        });
        await assert.rejects(tts.synthesize('x', 'en-US-Standard-C', { fetchImpl, key: null }), e => e.reason === 'NO_API_KEY');
    });
    await t.test('voice list filters the curated list to what Google offers', async () => {
        tts._resetVoiceCache();
        const fetchImpl = async (url, init) => {
            assert.ok(!url.includes(KEY));
            assert.equal(init.headers['X-Goog-Api-Key'], KEY);
            return { ok: true, json: async () => ({ voices: [{ name: 'en-US-Standard-C' }, { name: 'ja-JP-Wavenet-A' }, { name: 'ja-JP-Neural2-B' }, { name: 'xx-XX-Other' }] }) };
        };
        const set = await tts.availableVoices({ fetchImpl, key: KEY });
        assert.deepEqual([...set].sort(), ['en-US-Standard-C', 'ja-JP-Wavenet-A']);
        tts._resetVoiceCache();
    });
    await t.test('curated voices cover the required languages; resolve order user > server > en-US', () => {
        for (const code of ['en-US', 'en-GB', 'ja-JP', 'fil-PH', 'ko-KR', 'cmn-CN', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR']) {
            const list = voices.voicesFor(code);
            assert.ok(list.some(v => v.tier === 'Standard'), code + ' has Standard');
            assert.ok(list.some(v => v.tier !== 'Standard'), code + ' has WaveNet');
        }
        assert.equal(voices.resolveVoice('ja-JP-Standard-A', 'fr-FR-Standard-A'), 'ja-JP-Standard-A');
        assert.equal(voices.resolveVoice(null, 'fr-FR-Standard-A'), 'fr-FR-Standard-A');
        assert.equal(voices.resolveVoice('bogus', 'also-bogus'), 'en-US-Standard-C');
        assert.ok(voices.VOICES.every(v => v.name.length <= 48), 'fits VARCHAR(48)');
    });
});

// ------------------------------------------------------------------ queue / priority
test('queue and speech priority', async t => {
    await t.test('speech pauses music, speaks, then resumes the SAME stream (no restart)', async () => {
        const { s, deps, connection } = newSession();
        s.enqueueMusic({ url: 'https://cdn.example/song.mp3' });
        await flush();
        assert.equal(s.musicPlayer.state.status, 'playing');
        assert.equal(connection.subscribed, s.musicPlayer);
        const proc = deps.procs[0];

        assert.equal(s.enqueueTts('Ana says: hi', 'en-US-Standard-C'), true);
        await flush();
        assert.equal(deps.spoken.length, 1);
        assert.equal(s.musicPlayer.state.status, 'paused');
        assert.equal(connection.subscribed, s.ttsPlayer);
        assert.equal(s.ttsPlayer.state.resource.opts.inputType, 'ogg/opus');

        s.ttsPlayer.stop(); // speech finished
        await flush();
        assert.equal(connection.subscribed, s.musicPlayer);
        assert.equal(s.musicPlayer.state.status, 'playing');
        assert.equal(proc.killed, false, 'ffmpeg kept, music continues where it was');
        assert.equal(deps.opened.length, 1);
        s.destroy();
        assert.equal(proc.killed, true);
    });
    await t.test('several messages are spoken in a row before music resumes', async () => {
        const { s, deps, connection } = newSession();
        s.enqueueMusic({ url: 'https://cdn.example/song.mp3' });
        await flush();
        s.enqueueTts('one', 'v');
        s.enqueueTts('two', 'v');
        await flush();
        s.ttsPlayer.stop();
        await flush();
        assert.equal(deps.spoken.length, 2);
        assert.equal(connection.subscribed, s.ttsPlayer);
        assert.equal(s.musicPlayer.state.status, 'paused');
        s.ttsPlayer.stop();
        await flush();
        assert.equal(s.musicPlayer.state.status, 'playing');
        s.destroy();
    });
    await t.test('live radio held longer than 15 s is reconnected instead of resumed', async () => {
        const { s, deps, clock } = newSession();
        s.enqueueMusic({ url: 'https://radio.example/live' });
        await flush();
        s.enqueueTts('long speech', 'v');
        await flush();
        await clock.advance(20000);
        s.ttsPlayer.stop();
        await flush(); await flush();
        assert.equal(deps.procs[0].killed, true, 'old ffmpeg killed');
        assert.equal(deps.opened.length, 2, 'stream reopened');
        assert.equal(deps.procs.length, 2);
        assert.equal(deps.procs.filter(p => !p.killed).length, 1, 'only one ffmpeg alive');
        s.destroy();
    });
    await t.test('user pause stays paused after speech; resume works', async () => {
        const { s } = newSession();
        s.enqueueMusic({ url: 'https://cdn.example/a.mp3' });
        await flush();
        assert.equal(s.togglePause(), 'paused');
        s.enqueueTts('hi', 'v');
        await flush();
        s.ttsPlayer.stop();
        await flush();
        assert.equal(s.musicPlayer.state.status, 'paused');
        assert.equal(s.togglePause(), 'resumed');
        assert.equal(s.musicPlayer.state.status, 'playing');
        s.destroy();
    });
    await t.test('skip skips speech first, then music; queue moves on; one ffmpeg at a time', async () => {
        const { s, deps } = newSession();
        s.enqueueMusic({ url: 'https://cdn.example/1.mp3' });
        s.enqueueMusic({ url: 'https://cdn.example/2.mp3' });
        await flush();
        s.enqueueTts('hi', 'v');
        await flush();
        assert.equal(s.skip(), 'speech');
        await flush();
        assert.equal(s.skip(), 'music');
        await flush(); await flush();
        assert.equal(deps.opened[1], 'https://cdn.example/2.mp3');
        assert.equal(deps.procs[0].killed, true);
        assert.equal(deps.procs.filter(p => !p.killed).length, 1);
        assert.equal(s.skip(), 'music');
        await flush();
        assert.equal(s.current, null);
        assert.equal(s.skip(), null);
        s.destroy();
    });
    await t.test('speech queue max 15, music queue max 25, clear empties both', async () => {
        const { s } = newSession({ synthesize: () => new Promise(() => {}) }); // never finishes
        let ok = 0;
        for (let i = 0; i < 30; i++) if (s.enqueueTts('m' + i, 'v')) ok++;
        assert.equal(ok, 16); // 1 being spoken + 15 waiting
        s.enqueueMusic({ url: 'https://cdn.example/0.mp3' });
        let q = 0;
        for (let i = 0; i < 30; i++) if (s.enqueueMusic({ url: 'https://cdn.example/x' + i + '.mp3' }) > 0) q++;
        assert.equal(q, 25);
        assert.deepEqual(s.clear(), { music: 25, speech: 15 });
        s.destroy();
    });
    await t.test('a link that fails to open shows a notice and plays the next one', async () => {
        const { s, deps } = newSession({ openAudio: async url => { if (url.includes('bad')) throw new urlSafety.UrlRefused('not_audio', 'That link is not audio.'); return { stream: new PassThrough(), live: false, url }; } });
        s.enqueueMusic({ url: 'https://cdn.example/bad.html' });
        s.enqueueMusic({ url: 'https://cdn.example/good.mp3' });
        await flush(); await flush();
        assert.match(s.status().notice, /not audio/);
        assert.equal(s.current.item.url, 'https://cdn.example/good.mp3');
        assert.equal(deps.procs.length, 1);
        s.destroy();
    });
    await t.test('TTS off -> nothing is queued', () => {
        const { s } = newSession({ ttsEnabled: () => false });
        assert.equal(s.enqueueTts('hi', 'v'), false);
        s.destroy();
    });
});

// ------------------------------------------------------------------ reader
test('TTS reader picks only the right messages', async () => {
    reader._reset();
    const { s } = newSession();
    const spoken = [];
    s.enqueueTts = (text, voice) => { spoken.push({ text, voice }); return true; };
    const fakeStore = { getUserVoice: async id => (id === 'u2' ? 'ja-JP-Standard-A' : null), getGuildSettings: async () => ({ defaultVoice: 'en-GB-Standard-A', djRoleId: null }) };
    const getSession = () => s;
    const guild = { id: 'g1', members: { cache: new Map() }, roles: { cache: new Map() }, channels: { cache: new Map() } };
    const msg = (o = {}) => ({
        guild, content: 'hello there', channel: { id: 'vc1' }, author: { id: 'u1', bot: false },
        member: { displayName: 'Ana', voice: { channelId: 'vc1' } }, attachments: new Map(), mentions: {}, ...o
    });
    const h = (m, now) => reader.handleMessage(m, { getSession, store: fakeStore, now });
    assert.equal(await h(msg({ channel: { id: 'other' } }), 0), 'other_channel');
    assert.equal(await h(msg({ author: { id: 'b', bot: true } }), 0), 'not_human');
    assert.equal(await h(msg({ webhookId: 'w' }), 0), 'not_human');
    assert.equal(await h(msg({ member: { displayName: 'X', voice: { channelId: 'elsewhere' } } }), 0), 'not_in_voice');
    assert.equal(await h(msg({ content: '/vc' }), 0), 'empty');
    assert.equal(await h(msg(), 10000), 'queued');
    assert.equal(await h(msg({ content: 'spam' }), 11000), 'rate_limited');
    assert.equal(await h(msg({ content: 'later' }), 12500), 'queued');
    assert.equal(await h(msg({ author: { id: 'u2', bot: false }, member: { displayName: 'Ken', voice: { channelId: 'vc1' } }, content: 'yo' }), 13000), 'queued');
    assert.deepEqual(spoken, [
        { text: 'Ana says: hello there', voice: 'en-GB-Standard-A' },
        { text: 'later', voice: 'en-GB-Standard-A' },
        { text: 'Ken says: yo', voice: 'ja-JP-Standard-A' }
    ]);
    s.destroy();
});

// ------------------------------------------------------------------ permissions
test('DJ role / permission checks', () => {
    const member = ({ channel = 'vc1', roles = [], manage = false } = {}) => ({
        voice: { channelId: channel }, roles: { cache: new Map(roles.map(r => [r, {}])) }, permissions: { has: p => manage && p === 'ManageGuild' }
    });
    const noDj = { djRoleId: null };
    const dj = { djRoleId: '999999999999999999' };
    assert.equal(canUse('join', { member: member({ channel: null }), botChannelId: 'vc1', settings: dj }).ok, true);
    assert.equal(canUse('voice', { member: member({ channel: null }), botChannelId: null, settings: dj }).ok, true);
    assert.equal(canUse('skip', { member: member(), botChannelId: 'vc1', settings: noDj }).ok, true);
    assert.equal(canUse('skip', { member: member({ channel: 'vc2' }), botChannelId: 'vc1', settings: noDj }).ok, false);
    assert.equal(canUse('skip', { member: member(), botChannelId: null, settings: noDj }).ok, false);
    assert.equal(canUse('play', { member: member(), botChannelId: null, settings: noDj }).ok, true, 'play auto-joins');
    assert.equal(canUse('play', { member: member({ channel: null }), botChannelId: null, settings: noDj }).ok, false);
    for (const a of ['skip', 'clear', 'pause', 'play', 'leave']) {
        const r = canUse(a, { member: member(), botChannelId: 'vc1', settings: dj });
        assert.equal(r.ok, false, a + ' needs DJ');
        assert.match(r.reason, /<@&999999999999999999>/);
        assert.equal(canUse(a, { member: member({ roles: ['999999999999999999'] }), botChannelId: 'vc1', settings: dj }).ok, true);
        assert.equal(canUse(a, { member: member({ channel: 'vc9', manage: true }), botChannelId: 'vc1', settings: dj }).ok, true, 'Manage Server');
    }
    assert.equal(canUse('join', { member: member(), botChannelId: 'vc1', settings: dj }).ok, true, 'join is open');
});

// ------------------------------------------------------------------ auto-leave
test('auto-leave timers', async t => {
    await t.test('nobody in the channel for 60 s -> leave; someone coming back cancels it', async () => {
        const { s, clock, connection } = newSession();
        s.enqueueMusic({ url: 'https://radio.example/live' });
        await flush();
        s.setHumanCount(0);
        await clock.advance(59000);
        assert.equal(s.destroyed, false);
        s.setHumanCount(1);
        await clock.advance(120000);
        assert.equal(s.destroyed, false);
        s.setHumanCount(0);
        await clock.advance(60000);
        assert.equal(s.destroyed, true);
        assert.equal(connection.destroyed, true);
    });
    await t.test('15 min with nothing playing or spoken -> leave; activity resets it', async () => {
        const { s, clock } = newSession();
        s.setHumanCount(2);
        await clock.advance(14 * 60000);
        s.enqueueMusic({ url: 'https://cdn.example/a.mp3' });
        await flush();
        await clock.advance(30 * 60000);
        assert.equal(s.destroyed, false, 'playing keeps it');
        s.skip();
        await flush();
        await clock.advance(15 * 60000 - 1000);
        assert.equal(s.destroyed, false);
        await clock.advance(1000);
        assert.equal(s.destroyed, true);
        assert.equal(clock.pending(), 0, 'all timers cleaned up');
    });
    await t.test('manager: join, move, destroy cleans everything', async () => {
        const voice = fakeVoice();
        const clock = fakeClock();
        const deps = fakeDeps(clock);
        const guild = { id: 'gm', voiceAdapterCreator: () => ({}) };
        const s1 = await sessionMod.joinChannel({ guild, channel: { id: 'c1' }, voice, deps });
        assert.equal(sessionMod.getSession('gm'), s1);
        assert.equal(voice.conns[0].cfg.selfDeaf, true);
        const s2 = await sessionMod.joinChannel({ guild, channel: { id: 'c2' }, voice, deps });
        assert.equal(s2, s1);
        assert.equal(s1.channelId, 'c2');
        s1.enqueueMusic({ url: 'https://cdn.example/a.mp3' });
        await flush();
        sessionMod.destroySession('gm', 'test');
        assert.equal(sessionMod.getSession('gm'), null);
        assert.equal(deps.procs[0].killed, true);
        assert.equal(clock.pending(), 0);
    });
});

// ------------------------------------------------------------------ panel limits
function checkComponents(components) {
    assert.ok(components.length <= 5, 'max 5 rows');
    for (const r of components) {
        assert.equal(r.type, 1);
        const buttons = r.components.filter(c => c.type === 2);
        const selects = r.components.filter(c => c.type === 3);
        assert.ok(buttons.length <= 5, 'max 5 buttons per row');
        assert.ok(selects.length === 0 || (selects.length === 1 && r.components.length === 1), 'select alone in its row');
        for (const c of r.components) {
            assert.ok(c.custom_id.startsWith('vc_') && c.custom_id.length <= 100, 'customId ' + c.custom_id);
            assert.ok(!/release|evercold|warp|^btn_|^select_|^dc_|^pf_|^poll_|^ign_|^status_|^price_|^done_|^rem_|^todo_/.test(c.custom_id), 'no clash with other handlers: ' + c.custom_id);
            if (c.type === 2) assert.ok(c.label.length <= 80, 'button label');
            if (c.type === 3) {
                assert.ok(c.options.length >= 1 && c.options.length <= 25, 'options 1..25');
                assert.ok(!c.placeholder || c.placeholder.length <= 150);
                const vals = new Set();
                for (const o of c.options) {
                    assert.ok(o.label.length <= 80, 'option label ' + o.label);
                    assert.ok(String(o.value).length <= 100);
                    assert.ok(!o.description || o.description.length <= 100);
                    assert.ok(!vals.has(o.value), 'unique values');
                    vals.add(o.value);
                }
                assert.ok(c.options.filter(o => o.default).length <= 1);
            }
        }
    }
}

test('panel fits Discord limits', () => {
    const stations = Array.from({ length: 12 }, (_, i) => ({ uuid: '9617a958-0601-11e8-ae97-' + String(i).padStart(12, '0'), name: 'A very long station name '.repeat(6) + i, country: 'Philippines'.repeat(5), bitrate: 320, codec: 'AAC+' }));
    const statuses = [null, { channelId: '1', nowPlaying: { title: 'x'.repeat(300), live: true, paused: true }, speaking: true, musicQueue: 25, ttsQueue: 15, notice: 'n'.repeat(500) }];
    for (const status of statuses) {
        for (const lang of [null, ...voices.LANGUAGES.map(l => l.code)]) {
            const p = panel.buildPanel({
                status, voiceReady: true, ttsEnabled: !!status, voiceName: 'ja-JP-Wavenet-A', voiceIsDefault: false, ttsEngine: { mode: 'backup', reason: 'quota' }, selectedLang: lang,
                available: null, radioResults: stations, moveOffer: '2', djRoleId: '999999999999999999', notice: 'hello'
            });
            checkComponents(p.components);
            assert.ok(p.embeds[0].description.length <= 4096);
        }
    }
    const modal = panel.buildPlayModal();
    assert.ok(modal.title.length <= 45, 'modal title <= 45');
    assert.ok(modal.custom_id.startsWith('vc_') && modal.custom_id.length <= 100);
    const input = modal.components[0].components[0];
    assert.ok(input.label.length <= 45, 'text input label <= 45');
    assert.ok(input.placeholder.length <= 100);
    assert.ok(input.max_length <= 4000);
});

// ------------------------------------------------------------------ ffmpeg args (real ffmpeg if present)
test('ffmpeg turns any audio into Ogg Opus for Discord', async t => {
    const args = lib.ffmpegArgs({ seekSeconds: 42.7 });
    assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2), ['-ss', '42']);
    assert.ok(args.includes('libopus') && args.includes('ogg') && args.includes('pipe:0'));
    const info = lib.getFfmpeg();
    if (!info) return t.skip('no ffmpeg on this machine');
    const { spawn } = require('child_process');
    const gen = spawn(info.path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'mp3', 'pipe:1']);
    const { proc, ogg } = lib.spawnFfmpeg({});
    gen.stdout.pipe(proc.stdin);
    const chunks = [];
    for await (const c of proc.stdout) chunks.push(c);
    const out = Buffer.concat(chunks);
    if (ogg) assert.equal(out.subarray(0, 4).toString(), 'OggS');
    assert.ok(out.length > 1000);
});

// ------------------------------------------------------------------ command + handler
test('commands/vc.js loads and routes components correctly', async t => {
    const vc = require(path.join(ROOT, 'commands', 'vc.js'));
    assert.equal(vc.data.name, 'vc');
    assert.deepEqual(vc.data.contexts, [0]);
    assert.ok(vc.data.description.length <= 100);
    assert.equal(typeof vc.execute, 'function');
    assert.equal(typeof vc.handleInteraction, 'function');

    store._setPool({ execute: async sql => (/^\s*SELECT/i.test(sql) ? [[]] : [{}]) });
    const make = (customId, { inVoice = 'vc1', isButton = true } = {}) => {
        const calls = [];
        return {
            calls,
            customId, guildId: 'gX', user: { id: 'u1' }, guild: { id: 'gX', channels: { cache: new Map() }, members: { me: null } },
            member: { voice: { channelId: inVoice, channel: null }, roles: { cache: new Map() }, permissions: { has: () => false } },
            inGuild: () => true, isButton: () => isButton,
            showModal: async m => calls.push(['showModal', m.custom_id]),
            deferUpdate: async () => calls.push(['deferUpdate']),
            editReply: async p => calls.push(['editReply', p.components.length])
        };
    };
    await t.test('Play opens the modal as the first answer', async () => {
        const i = make('vc_play');
        await vc.handleInteraction(i);
        assert.deepEqual(i.calls, [['showModal', 'vc_playmodal']]);
    });
    await t.test('Play without being in voice: deferUpdate first, then the panel', async () => {
        const i = make('vc_play', { inVoice: null });
        await vc.handleInteraction(i);
        assert.equal(i.calls[0][0], 'deferUpdate');
        assert.equal(i.calls[1][0], 'editReply');
    });
    await t.test('every other control acks with deferUpdate before editing', async () => {
        for (const id of ['vc_skip', 'vc_clear', 'vc_pause', 'vc_leave', 'vc_refresh']) {
            const i = make(id);
            await vc.handleInteraction(i);
            assert.deepEqual(i.calls.map(c => c[0]), ['deferUpdate', 'editReply'], id);
        }
    });
    await t.test('ignores ids that are not ours', async () => {
        const i = make('poll_x');
        await vc.handleInteraction(i);
        assert.equal(i.calls.length, 0);
    });
});

// ------------------------------------------------------------------ Standard/WaveNet only + saved voice mapping
test('only Standard and WaveNet voices; old saved voices are mapped', async () => {
    assert.ok(voices.VOICES.every(v => v.tier === 'Standard' || v.tier === 'Wavenet'), 'no Neural2/Studio/Chirp');
    assert.ok(voices.VOICES.every(v => !/Neural2|Studio|Chirp|Journey|Polyglot|News/.test(v.name)));
    assert.equal(voices.normalizeVoice('ja-JP-Neural2-C'), 'ja-JP-Standard-C', 'same language + gender');
    assert.equal(voices.normalizeVoice('en-US-Neural2-F'), 'en-US-Standard-C');
    assert.equal(voices.normalizeVoice('de-DE-Studio-B'), 'de-DE-Standard-A', 'unknown gender -> first Standard');
    assert.equal(voices.normalizeVoice('fr-FR-Chirp3-HD-A'), null, 'not a classic voice name');
    assert.equal(voices.normalizeVoice('xx-YY-Standard-A'), null);
    assert.equal(voices.normalizeVoice('pt-BR-Wavenet-B'), 'pt-BR-Wavenet-B');
    assert.equal(voices.resolveVoice('ko-KR-Neural2-C', 'en-GB-Standard-A'), 'ko-KR-Standard-C');
    assert.equal(voices.resolveVoice(null, 'es-US-Neural2-A'), 'es-US-Standard-A');
    // store returns the mapped voice
    store._setPool({ execute: async sql => (/FROM voice_user_prefs/.test(sql) ? [[{ voice: 'ja-JP-Neural2-B' }]] : /FROM voice_settings/.test(sql) ? [[{ default_voice: 'fr-FR-Neural2-B', dj_role_id: null }]] : [[]]) });
    assert.equal(await store.getUserVoice('legacyUser'), 'ja-JP-Standard-A');
    assert.equal((await store.getGuildSettings('legacyGuild')).defaultVoice, 'fr-FR-Standard-B');
});

// ------------------------------------------------------------------ Pacific day + safety counter
const usageMod = V('usage');
function memStore(rows = {}) {
    const saves = [];
    return {
        saves, rows,
        getUsage: async day => rows[day] || { chars: 0, blocked: false },
        saveUsage: async (day, chars, blocked) => {
            saves.push({ day, chars, blocked });
            const old = rows[day] || { chars: 0, blocked: false };
            rows[day] = { chars: Math.max(old.chars, chars), blocked: old.blocked || blocked };
        }
    };
}

test('Google usage counter and Pacific midnight reset', async t => {
    await t.test('Pacific day follows America/Los_Angeles incl. DST', () => {
        assert.equal(usageMod.pacificDay(Date.parse('2026-11-05T07:59:00Z')), '2026-11-04'); // PST (UTC-8)
        assert.equal(usageMod.pacificDay(Date.parse('2026-11-05T08:00:00Z')), '2026-11-05');
        assert.equal(usageMod.pacificDay(Date.parse('2026-07-10T06:59:00Z')), '2026-07-09'); // PDT (UTC-7)
        assert.equal(usageMod.pacificDay(Date.parse('2026-07-10T07:00:00Z')), '2026-07-10');
    });
    await t.test('daily limit from env, default 120000', () => {
        const old = process.env.GOOGLE_TTS_DAILY_CHARS;
        delete process.env.GOOGLE_TTS_DAILY_CHARS;
        assert.equal(usageMod.dailyLimit(), 120000);
        process.env.GOOGLE_TTS_DAILY_CHARS = '5000';
        assert.equal(usageMod.dailyLimit(), 5000);
        process.env.GOOGLE_TTS_DAILY_CHARS = 'abc';
        assert.equal(usageMod.dailyLimit(), 120000);
        if (old === undefined) delete process.env.GOOGLE_TTS_DAILY_CHARS; else process.env.GOOGLE_TTS_DAILY_CHARS = old;
    });
    await t.test('counter survives a restart (loaded from DB) and stops at the limit', async () => {
        const clock = fakeClock();
        let now = Date.parse('2026-11-05T20:00:00Z');
        clock.now = () => now;
        const st = memStore({ '2026-11-05': { chars: 99990, blocked: false } });
        const u = usageMod.createUsage({ store: st, clock, limit: () => 100000 });
        assert.deepEqual(await u.check(10), { ok: true });
        u.add(10);
        assert.deepEqual(await u.check(1), { ok: false, reason: 'limit' });
        assert.equal(u.state().reason, 'limit');
        await clock.advance(10000); // debounced save
        await flush();
        assert.deepEqual(st.rows['2026-11-05'], { chars: 100000, blocked: false });
        // next Pacific day: fresh
        now = Date.parse('2026-11-06T08:00:01Z');
        assert.deepEqual(await u.check(500), { ok: true });
        assert.equal(u.state().reason, null);
    });
    await t.test('a quota error blocks Google until midnight Pacific, also after a restart', async () => {
        const clock = fakeClock();
        let now = Date.parse('2026-11-05T23:00:00Z'); // 15:00 PST
        clock.now = () => now;
        const st = memStore();
        const u = usageMod.createUsage({ store: st, clock, limit: () => 100000 });
        await u.check(5);
        u.block('RESOURCE_EXHAUSTED');
        await flush();
        assert.deepEqual(await u.check(5), { ok: false, reason: 'quota' });
        assert.equal(st.rows['2026-11-05'].blocked, true);
        const restarted = usageMod.createUsage({ store: st, clock, limit: () => 100000 });
        assert.deepEqual(await restarted.check(5), { ok: false, reason: 'quota' });
        now = Date.parse('2026-11-06T07:59:59Z'); // 23:59:59 PST - still blocked
        assert.equal((await u.check(5)).ok, false);
        now = Date.parse('2026-11-06T08:00:00Z'); // midnight PST
        assert.deepEqual(await u.check(5), { ok: true });
    });
});

// ------------------------------------------------------------------ engine choice
function fakeUsage() {
    const log = [];
    let blocked = null;
    let chars = 0;
    const limit = 1000;
    return {
        log,
        check: async n => (blocked ? { ok: false, reason: 'quota' } : chars + n > limit ? { ok: false, reason: 'limit' } : { ok: true }),
        add: n => { chars += n; log.push(['add', n]); },
        block: r => { blocked = 'quota'; log.push(['block', r]); },
        state: () => ({ reason: blocked ? 'quota' : chars >= limit ? 'limit' : null })
    };
}
const fakeEspeak = (installed = true) => {
    const calls = [];
    return { calls, isInstalled: () => installed, synthesize: async (text, voice) => { calls.push({ text, voice }); return Buffer.alloc(3840); } };
};
const googleOk = async () => ({ ok: true, status: 200, json: async () => ({ audioContent: Buffer.from('OggS').toString('base64') }) });
const googleErr = (status, st, reason) => async () => ({ ok: false, status, json: async () => ({ error: { status: st, message: 'x', details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] } }) });

test('Google or eSpeak backup', async t => {
    const KEY = 'AIzaFAKE';
    await t.test('no key -> always eSpeak, with the language-matched voice', async () => {
        const es = fakeEspeak();
        let fetched = 0;
        const out = await tts.speak('Ken says: hi', 'ja-JP-Wavenet-C', { key: null, espeak: es, usage: fakeUsage(), fetchImpl: async () => { fetched++; } });
        assert.equal(out.engine, 'espeak');
        assert.equal(out.type, 'pcm');
        assert.equal(fetched, 0);
        assert.deepEqual(es.calls[0], { text: 'Ken says: hi', voice: 'ja' });
        assert.equal((await tts.speak('x', 'fil-PH-Standard-A', { key: null, espeak: es, usage: fakeUsage() })).engine, 'espeak');
        assert.equal(es.calls[1].voice, 'en-us+f3', 'no Filipino in eSpeak -> English');
    });
    await t.test('Google success counts characters', async () => {
        const u = fakeUsage();
        const out = await tts.speak('héllo 世界', 'en-US-Standard-C', { key: KEY, espeak: fakeEspeak(), usage: u, fetchImpl: googleOk });
        assert.equal(out.engine, 'google');
        assert.equal(out.type, 'ogg');
        assert.deepEqual(u.log, [['add', 8]]);
    });
    for (const [label, fetchImpl, why] of [
        ['429 quota', googleErr(429, 'RESOURCE_EXHAUSTED'), 'RESOURCE_EXHAUSTED'],
        ['403 billing', googleErr(403, 'PERMISSION_DENIED', 'BILLING_DISABLED'), 'BILLING_DISABLED'],
        ['403 permission', googleErr(403, 'PERMISSION_DENIED'), 'PERMISSION_DENIED'],
        ['400 bad key', googleErr(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID'), 'API_KEY_INVALID']
    ]) {
        await t.test(label + ' -> backup now and for the rest of the day (no more Google calls)', async () => {
            const u = fakeUsage();
            const es = fakeEspeak();
            let calls = 0;
            const f = async (...a) => { calls++; return fetchImpl(...a); };
            const out = await tts.speak('hello', 'en-US-Standard-C', { key: KEY, espeak: es, usage: u, fetchImpl: f });
            assert.equal(out.engine, 'espeak');
            assert.deepEqual(u.log, [['block', why]]);
            assert.equal(calls, 1, 'blocking errors are not retried');
            await tts.speak('again', 'en-US-Standard-C', { key: KEY, espeak: es, usage: u, fetchImpl: f });
            assert.equal(calls, 1);
            assert.deepEqual(tts.engineStatus({ key: KEY, espeak: es, usage: u }), { mode: 'backup', reason: 'quota' });
        });
    }
    await t.test('a temporary Google error (500) uses the backup once, then Google again', async () => {
        const u = fakeUsage();
        const es = fakeEspeak();
        let n = 0;
        const f = async (...a) => (++n === 1 ? googleErr(500, 'INTERNAL')(...a) : googleOk(...a));
        assert.equal((await tts.speak('one', 'en-US-Standard-C', { key: KEY, espeak: es, usage: u, fetchImpl: f })).engine, 'espeak');
        assert.equal((await tts.speak('two', 'en-US-Standard-C', { key: KEY, espeak: es, usage: u, fetchImpl: f })).engine, 'google');
        assert.deepEqual(u.log, [['add', 3]]);
    });
    await t.test('over the safety limit -> backup without calling Google', async () => {
        const u = fakeUsage();
        u.add(1000);
        let calls = 0;
        const out = await tts.speak('hi', 'en-US-Standard-C', { key: KEY, espeak: fakeEspeak(), usage: u, fetchImpl: async () => { calls++; } });
        assert.equal(out.engine, 'espeak');
        assert.equal(calls, 0);
        assert.deepEqual(tts.engineStatus({ key: KEY, espeak: fakeEspeak(), usage: u }), { mode: 'backup', reason: 'limit' });
    });
    await t.test('no key and no eSpeak -> TTS off', async () => {
        await assert.rejects(tts.speak('hi', 'en-US-Standard-C', { key: null, espeak: fakeEspeak(false), usage: fakeUsage() }), e => e.reason === 'NO_ENGINE');
        assert.deepEqual(tts.engineStatus({ key: null, espeak: fakeEspeak(false), usage: fakeUsage() }), { mode: 'off', reason: 'no_key' });
        assert.deepEqual(tts.engineStatus({ key: KEY, espeak: fakeEspeak(), usage: fakeUsage() }), { mode: 'google', reason: null });
    });
    await t.test('panel shows the backup note', () => {
        const base = { status: null, voiceReady: true, ttsEnabled: true, voiceName: 'en-US-Standard-C', voiceIsDefault: true, selectedLang: null, available: null, radioResults: null, moveOffer: null, djRoleId: null, notice: null };
        assert.match(panel.buildPanel({ ...base, ttsEngine: { mode: 'backup', reason: 'no_key' } }).embeds[0].description, /Backup voice \(no Google key\)/);
        assert.match(panel.buildPanel({ ...base, ttsEngine: { mode: 'backup', reason: 'quota' } }).embeds[0].description, /Using the backup voice today/);
        assert.match(panel.buildPanel({ ...base, ttsEngine: { mode: 'backup', reason: 'limit' } }).embeds[0].description, /Using the backup voice today/);
        assert.doesNotMatch(panel.buildPanel({ ...base, ttsEngine: { mode: 'google', reason: null } }).embeds[0].description, /backup/i);
        assert.match(panel.buildPanel({ ...base, ttsEnabled: false, ttsEngine: { mode: 'off', reason: 'no_key' } }).embeds[0].description, /Text-to-speech:\*\* off/);
    });
});

// ------------------------------------------------------------------ eSpeak wrapper (mocked wasm module)
const espeakMod = V('espeak');
test('eSpeak NG wrapper', async t => {
    await t.test('PCM 22050 Hz mono -> 48 kHz stereo s16le', () => {
        const one = new Int16Array(22050).fill(1000);
        const out = espeakMod.toDiscordPcm(one, 22050);
        assert.equal(out.length / 4, Math.floor(22049 / (22050 / 48000)) + 1);
        assert.ok(Math.abs(out.length / 4 - 48000) <= 3, 'about one second');
        assert.equal(out.readInt16LE(0), 1000);
        assert.equal(out.readInt16LE(2), 1000, 'right channel = left');
        const ramp = espeakMod.toDiscordPcm(Int16Array.from([0, 22050]), 22050);
        assert.ok(ramp.readInt16LE(4) > 0 && ramp.readInt16LE(4) < 22050, 'interpolated');
        assert.equal(espeakMod.toDiscordPcm(new Int16Array(0), 22050).length, 0);
    });
    await t.test('markup characters are made safe', () => {
        assert.equal(espeakMod.safeText('a <b> & c'), 'a b and c');
    });
    await t.test('loads once (lazy import), sets voice + rate, converts output', async () => {
        const calls = [];
        let imports = 0;
        class Worker {
            get samplerate() { return 22050; }
            set_voice(v) { calls.push(['voice', v]); return v === 'xx+f3' || v === 'xx' ? 1 : 0; }
            set_rate(r) { calls.push(['rate', r]); }
            synthesize(text, cb) { calls.push(['say', text]); cb(new Int16Array(2205).fill(5), []); cb(new Int16Array(2205).fill(7), []); }
        }
        espeakMod._setImporter(async () => { imports++; return { default: async () => ({ eSpeakNGWorker: Worker }) }; }, () => '/fake/espeak-ng.js');
        assert.equal(espeakMod.isInstalled(), true);
        const pcm = await espeakMod.synthesize('hi <there>', 'ja+f3');
        assert.ok(Math.abs(pcm.length / 4 - 9600) <= 3, '0.2 s at 48 kHz');
        await espeakMod.synthesize('again', 'ja+f3');
        assert.equal(imports, 1);
        assert.deepEqual(calls.filter(c => c[0] === 'voice'), [['voice', 'ja+f3']], 'voice set once');
        assert.deepEqual(calls.find(c => c[0] === 'say'), ['say', 'hi there']);
        await espeakMod.synthesize('x', 'xx+f3');
        assert.deepEqual(calls.filter(c => c[0] === 'voice').slice(1), [['voice', 'xx+f3'], ['voice', 'xx'], ['voice', 'en-us']], 'falls back to English');
    });
    await t.test('missing package -> one clear error, then TTS reports not installed', async () => {
        const errs = [];
        const prev = console.error;
        console.error = m => errs.push(String(m));
        espeakMod._setImporter(async () => { throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' }); }, () => '/fake/espeak-ng.js');
        await assert.rejects(espeakMod.synthesize('hi', 'en-us'));
        console.error = prev;
        assert.equal(espeakMod.isInstalled(), false);
        assert.ok(errs.some(e => /eSpeak NG backup voice could not be loaded/.test(e)));
        espeakMod._setImporter(async () => { throw new Error('x'); }, () => { throw new Error('not installed'); });
        assert.equal(espeakMod.isInstalled(), false);
    });
    await t.test('session plays backup PCM as StreamType.Raw', async () => {
        const { s, connection } = newSession({ synthesize: async () => ({ type: 'pcm', data: Buffer.alloc(3840), engine: 'espeak' }) });
        s.enqueueTts('hi', 'en-US-Standard-C');
        await flush();
        assert.equal(connection.subscribed, s.ttsPlayer);
        assert.equal(s.ttsPlayer.state.resource.opts.inputType, 'raw');
        s.destroy();
    });
});

// ------------------------------------------------------------------ dependencies
test('@discordjs/voice dependency report', t => {
    let voice;
    try {
        voice = require('@discordjs/voice');
    } catch {
        return t.skip('@discordjs/voice is NOT installed in this folder (npm registry not reachable from this sandbox)');
    }
    const report = voice.generateDependencyReport();
    realLog('\n' + report);
    assert.match(report, /@snazzah\/davey: \d/);
    assert.match(report, /opusscript: \d|@discordjs\/opus: \d/);
    assert.match(report, /aes-256-gcm: yes/);
    assert.doesNotMatch(report, /FFmpeg\n- not found/);
});
