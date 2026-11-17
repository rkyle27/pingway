// Tests for the Pingway Data Updater page (misc/pingway-data-updater.html, made by tools/build-data-updater.js): the page's
// Collect code runs here in a sandbox with a fake fetch() answering like FFXIV Collect, and its file must pass the bot's
// own parseListsFile(). The Trivia part is the same bundle as misc/trivia-builder.html (tested in trivia-builder.test.js).
//   node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FC = require(path.join(ROOT, 'utils', 'ffxivCollect'));
const gen = require(path.join(ROOT, 'tools', 'build-data-updater'));
const triviaGen = require(path.join(ROOT, 'tools', 'build-trivia-builder'));

const HTML = fs.readFileSync(gen.OUT, 'utf8');
const scriptOf = (html, id) => new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>').exec(html)[1];
const FIX = path.join(__dirname, 'fixtures', 'ffxivcollect');

// FFXIV Collect-like answers: the saved answers where there are some, else a small list in the same shape
function answer(url) {
    const u = new URL(url);
    const list = u.pathname.replace('/api/', '').replace('triad/', '');
    const lang = u.searchParams.get('language');
    for (const f of [list + '-' + lang + '.json', list + '-en.json']) {
        try { return JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')); } catch (e) { /* none */ }
    }
    return { results: [1, 2].map(id => ({ id, name: list + ' ' + lang + ' ' + id, owned: '12.5%', icon: 'https://ffxivcollect.com/x.png', sources: [] })) };
}
function loadCollect(fetchImpl) {
    const ctx = { fetch: fetchImpl, TextEncoder, setTimeout, clearTimeout, console };
    vm.createContext(ctx);
    vm.runInContext(scriptOf(HTML, 'collect-core') + '\n;this.CollectBuilder = CollectBuilder;', ctx);
    return ctx.CollectBuilder;
}

test('updater page is up to date with the code (run: node tools/build-data-updater.js)', () => {
    assert.equal(HTML, gen.html());
    assert.ok(!/<script[^>]+src=/i.test(HTML), 'no external scripts');
    assert.match(HTML, /<title>Pingway Data Updater<\/title>/);
    assert.equal(scriptOf(HTML, 'trivia-core'), scriptOf(triviaGen.html(), 'trivia-core'), 'same Trivia code as trivia-builder.html');
    assert.ok(!/https?:\/\/(?!ffxivcollect\.com)[^\s'"<]+/.test(scriptOf(HTML, 'collect-core').replace(/^\s*\/\/.*$/gm, '')), 'only FFXIV Collect is contacted');
    assert.match(HTML, /Data by FFXIV Collect/);
    new vm.Script(scriptOf(HTML, 'updater-ui'));
});

test('Collect part makes a file the bot accepts (parseListsFile), every list in every language', async () => {
    const calls = [];
    const CB = loadCollect(async url => { calls.push(url); return { ok: true, status: 200, json: async () => answer(url) }; });
    const progress = [];
    const res = await CB.build({ pauseMs: 0, retryMs: 0, onProgress: p => progress.push(p) });
    assert.equal(calls.length, 32);
    assert.ok(calls.every(u => u.startsWith('https://ffxivcollect.com/api/')));
    assert.ok(calls.includes('https://ffxivcollect.com/api/triad/cards?language=ja'));
    assert.equal(progress.filter(p => p.count !== null).length, 32);
    const raw = JSON.parse(res.text);
    assert.equal(raw.format, FC.LISTS_FORMAT);
    const parsed = FC.parseListsFile(raw);
    assert.ok(parsed);
    assert.equal(parsed.dropped, 0);
    for (const l of ['en', 'fr', 'de', 'ja']) for (const c of FC.COLLECTION_KEYS) assert.ok(parsed.langs[l][c].length > 0, l + ' ' + c);
    // the same items as the bot's own slimItem (except: no https icon = '' in the file, null in the bot; both mean no icon)
    const mounts = answer('https://ffxivcollect.com/api/mounts?language=en').results;
    assert.deepEqual(raw.langs.en.mounts, mounts.map(m => FC.slimItem('mounts', m)).filter(Boolean).map(m => Object.assign(m, { icon: m.icon || '' })));
    const c = CB.check(res.text);
    assert.equal(c.ok, true);
    assert.equal(c.counts.en.mounts, mounts.length);
    assert.equal(res.bytes.length, Buffer.byteLength(res.text));
});

test('Collect part: a list that keeps failing stops it (nothing saved); the check refuses a bad file', async () => {
    const lines = [];
    const CB = loadCollect(async url => (/emotes\?language=fr/.test(url) ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => answer(url) }));
    await assert.rejects(() => CB.build({ pauseMs: 0, retryMs: 0, log: t => lines.push(t) }), /Could not download https:\/\/ffxivcollect\.com\/api\/emotes\?language=fr/);
    assert.equal(lines.filter(t => /HTTP 500/.test(t)).length, 3);
    const empty = loadCollect(async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }));
    await assert.rejects(() => empty.build({ pauseMs: 0, retryMs: 0 }), /English mounts list is empty/);
    assert.equal(CB.check('{').ok, false);
    assert.equal(CB.check(JSON.stringify({ format: 'other', langs: {} })).ok, false);
    const noFr = CB.check(JSON.stringify({ format: FC.LISTS_FORMAT, langs: { en: Object.fromEntries(FC.COLLECTION_KEYS.map(k => [k, [{ id: 1, name: 'A', owned: 1 }]])) } }));
    assert.equal(noFr.ok, false);
    assert.match(noFr.problems.join(' '), /language fr is missing/);
});
