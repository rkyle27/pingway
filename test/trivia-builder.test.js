// Tests for the Trivia data builder page (misc/trivia-builder.html, made by tools/build-trivia-builder.js): the page's code
// runs here in a sandbox with a fake fetch() answering from the mocked XIVAPI, and must make exactly the file the
// server's buildBank() makes.   node --test test/
'use strict';

const env = require('./fixtures/trivia-env').setup();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const ROOT = env.ROOT;
const fx = require('./fixtures/trivia-xivapi');
const T = require(path.join(ROOT, 'utils', 'trivia'));
const W = require(path.join(ROOT, 'utils', 'triviaWords'));
const gen = require(path.join(ROOT, 'tools', 'build-trivia-builder'));
T._setPause(0, 0);

const HTML = fs.readFileSync(gen.OUT, 'utf8');
const scriptOf = id => new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>').exec(HTML)[1];
const FIXED = Date.parse('2026-11-07T01:02:03Z');

// The page's core script in a fresh sandbox; fetchImpl(url) = what fetch() does there
function loadPage(fetchImpl) {
    const ctx = {
        fetch: fetchImpl, TextEncoder, URL, AbortController, setTimeout, clearTimeout, console,
        crypto: nodeCrypto.webcrypto
    };
    vm.createContext(ctx);
    vm.runInContext(scriptOf('trivia-core') + '\n;this.TriviaBuilder = TriviaBuilder;', ctx);
    return ctx.TriviaBuilder;
}
const okFetch = get => async url => {
    const { data } = await get(url);
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) };
};

test('builder page is up to date with the code (run: node tools/build-trivia-builder.js)', () => {
    assert.equal(HTML, gen.html());
    assert.ok(!/<script[^>]+src=/i.test(HTML), 'no external scripts');
    assert.ok(!/https?:\/\/(?!v2\.xivapi\.com)[^\s'"<]+/.test(scriptOf('trivia-core').replace(/https:\/\/pingway\.app/g, '')), 'only XIVAPI is contacted');
    new vm.Script(scriptOf('trivia-ui'));
});

test('builder page makes byte for byte the same trivia_bank.json as the server buildBank()', async () => {
    // server
    try { fs.unlinkSync(T.BANK_FILE); } catch (e) { /* none */ }
    T._reset();
    const realNow = Date.now;
    Date.now = () => FIXED;
    let serverBank;
    try { serverBank = await T.buildBank(); } finally { Date.now = realNow; }
    const serverText = fs.readFileSync(T.BANK_FILE, 'utf8');
    // page
    const calls = [];
    const fake = fx.makeFakeGet();
    const TBP = loadPage(okFetch(url => { calls.push(url); return fake.get(url); }));
    const progress = [];
    const res = await TBP.build({ pauseMs: 0, retryMs: 0, now: () => FIXED, onProgress: p => progress.push(p) });
    assert.equal(res.text, serverText, 'same file');
    assert.deepEqual(JSON.parse(res.text), JSON.parse(JSON.stringify(serverBank)));
    assert.equal(res.sha256, nodeCrypto.createHash('sha256').update(serverText, 'utf8').digest('hex'));
    assert.equal(res.bytes.length, Buffer.byteLength(serverText));
    // summary
    assert.equal(res.summary.format, 4);
    assert.deepEqual([...res.summary.langs], ['en', 'fr', 'de', 'ja']);
    assert.equal(res.summary.incomplete, false);
    for (const d of res.summary.difficulties) {
        assert.equal(d.words, serverBank.pools[d.key].length);
        assert.equal(d.complete, serverBank.pools[d.key].filter(W.isComplete).length);
    }
    // progress: every step of every language, in order
    const starts = progress.filter(p => !p.page);
    assert.equal(starts.length, TBP.TOTAL_STEPS);
    assert.deepEqual(starts.map(p => p.step), Array.from({ length: TBP.TOTAL_STEPS }, (x, i) => i + 1));
    assert.deepEqual([...new Set(starts.map(p => p.lang))], ['en', 'fr', 'de', 'ja']);
    assert.ok(starts.some(p => p.label === 'jobs' && p.lang === 'fr'));
    assert.ok(calls.every(u => u.startsWith('https://v2.xivapi.com/api/')));
    // the server keeps working with this file
    T._reset();
    assert.equal(T.getBank().format, T.BANK_FORMAT);
    assert.equal(T.getBank().builtAt, FIXED);
});

test('builder: blocked browser (CORS) is detected before the download', async () => {
    const TBP = loadPage(async () => { throw new TypeError('Failed to fetch'); });
    const p = await TBP.probe({ retryMs: 0 });
    assert.equal(p.ok, false);
    assert.equal(p.blocked, true);
    assert.match(p.message, /could not reach XIVAPI \(Failed to fetch\)/);
    const http = loadPage(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const q = await http.probe({ retryMs: 0 });
    assert.deepEqual([q.ok, q.blocked], [false, false]);
    assert.match(q.message, /HTTP 503/);
});

test('builder: retries, and a language that fails stops the build (or makes an incomplete bank when allowed)', async () => {
    // a 500 then fine: retried
    let n = 0;
    const fake = fx.makeFakeGet();
    const flaky = okFetch(fake.get);
    const retries = [];
    const TBP = loadPage(async url => (++n === 2 ? { ok: false, status: 500, json: async () => ({}) } : flaky(url)));
    const res = await TBP.build({ pauseMs: 0, retryMs: 0, onRetry: (e, k) => retries.push(k) });
    assert.deepEqual(retries, [1]);
    assert.equal(res.summary.incomplete, false);
    // German down
    const down = loadPage(okFetch(fx.makeFakeGet({ failLang: 'de' }).get));
    const warns = [];
    await assert.rejects(() => down.build({ pauseMs: 0, retryMs: 0, warn: t => warns.push(t) }), /languages missing: de/);
    assert.match(warns[0], /could not fetch de/);
    const part = await down.build({ pauseMs: 0, retryMs: 0, strict: false });
    assert.equal(part.summary.incomplete, true);
    assert.deepEqual([...part.summary.failed], ['de']);
    assert.equal(JSON.parse(part.text).incomplete, true);
});

test('builder: SHA-256 fallback (no crypto.subtle) is correct', () => {
    const TBP = loadPage(async () => { throw new Error('unused'); });
    for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'ナイト Weißmagier '.repeat(500)]) {
        assert.equal(TBP.sha256Plain(new TextEncoder().encode(s)), nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 20)));
    }
});
