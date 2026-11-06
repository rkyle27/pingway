// Makes misc/trivia-builder.html: the Trivia data builder page the owner opens locally in Chrome (file://).
// It builds data/trivia_bank.json in the browser (the bot server has too little memory to do it).
//   node tools/build-trivia-builder.js        (run again after changing the Trivia bank code or locales/*/trivia.json)
// The page contains the REAL server code, bundled as it is: utils/triviaBank.js, utils/triviaWords.js, utils/i18n.js
// (+ locales/<lang>/trivia.json) and tools/trivia-builder-runtime.js. fs/path/crypto are small stand-ins in the page
// (only the locale files are read, and nothing from crypto is used to build the bank). No external scripts.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'misc', 'trivia-builder.html');
const LANGS = ['en', 'fr', 'de', 'ja'];
const MODULES = { triviaBank: 'utils/triviaBank.js', triviaWords: 'utils/triviaWords.js', i18n: 'utils/i18n.js', runtime: 'tools/trivia-builder-runtime.js' };

// The bundle: defines the global TriviaBuilder (= tools/trivia-builder-runtime.js exports)
function bundleSource() {
    const locales = {};
    for (const l of LANGS) locales[l + '/trivia'] = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', l, 'trivia.json'), 'utf8'));
    const parts = [];
    parts.push('var TriviaBuilder = (function () {');
    parts.push('var LOCALES = ' + JSON.stringify(locales) + ';');
    parts.push(`var SHIMS = {
    fs: { readFileSync: function (file) {
        var m = /([a-z]{2})[\\\\/]([A-Za-z0-9_-]+)\\.json$/.exec(String(file));
        var key = m ? m[1] + '/' + m[2] : '';
        if (Object.prototype.hasOwnProperty.call(LOCALES, key)) return JSON.stringify(LOCALES[key]);
        var e = new Error('ENOENT: ' + file); e.code = 'ENOENT'; throw e;
    }, writeFileSync: function () { throw new Error('no files in the browser'); }, mkdirSync: function () {} },
    path: { join: function () { return Array.prototype.slice.call(arguments).join('/'); }, dirname: function (p) { return String(p).replace(/[\\\\/][^\\\\/]*$/, ''); } },
    crypto: {}
};
var DEFS = {}, CACHE = {};
function req(name) {
    var key = String(name).replace(/^\\.\\.?\\//, '').replace(/\\.js$/, '');
    if (SHIMS[key]) return SHIMS[key];
    if (CACHE[key]) return CACHE[key].exports;
    if (!DEFS[key]) throw new Error('module not in the page: ' + name);
    var module = { exports: {} };
    CACHE[key] = module;
    DEFS[key](module, module.exports, req, 'utils');
    return module.exports;
}`);
    for (const [name, file] of Object.entries(MODULES)) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        parts.push('// ---- ' + file + ' ----');
        parts.push('DEFS[' + JSON.stringify(name) + '] = function (module, exports, require, __dirname) {\n' + src + '\n};');
    }
    parts.push('return req("runtime");');
    parts.push('})();');
    const out = parts.join('\n');
    if (/<!--|<\/script/i.test(out)) throw new Error('the bundled code contains "<!--" or "</script": it would break the page');
    return out;
}

const UI = `
(function () {
    var $ = function (id) { return document.getElementById(id); };
    var btn = $('build'), bar = $('bar'), barText = $('barText'), log = $('log');
    var started = 0;
    function line(text, cls) {
        var d = document.createElement('div');
        d.textContent = text;
        if (cls) d.className = cls;
        log.appendChild(d);
        log.scrollTop = log.scrollHeight;
    }
    function show(id, on) { $(id).hidden = !on; }
    function setBar(step, steps, text) {
        bar.style.width = Math.round(step / steps * 100) + '%';
        barText.textContent = text;
    }
    var LANG_NAMES = { en: 'English', fr: 'French', de: 'German', ja: 'Japanese' };
    function fail(title, text) {
        $('errTitle').textContent = title;
        $('errText').textContent = text;
        show('error', true);
        btn.disabled = false;
        btn.textContent = 'Try again';
    }
    btn.addEventListener('click', async function () {
        btn.disabled = true;
        btn.textContent = 'Building…';
        show('error', false); show('result', false);
        log.textContent = '';
        setBar(0, 1, 'Checking that the browser can reach XIVAPI…');
        started = Date.now();
        var p = await TriviaBuilder.probe({});
        if (!p.ok) {
            if (p.blocked) {
                fail('The browser could not reach XIVAPI', 'Chrome blocked the request or there is no connection (' + p.message + ').\\n\\n' +
                    'Most likely cause: XIVAPI does not allow pages opened from a file on your PC (file://, "Origin: null") — this is CORS, ' +
                    'and a page opened from a file cannot get around it. Check your internet connection and turn off ad blockers for this page, then try again. ' +
                    'If it still fails, open DevTools (F12) → Console: a message with "CORS" or "Access-Control-Allow-Origin" confirms it.');
            } else {
                fail('XIVAPI did not answer properly', p.message + '. XIVAPI may be down or busy: try again in a few minutes.');
            }
            setBar(0, 1, 'Stopped.');
            return;
        }
        line('XIVAPI can be reached. Fetching everything (this takes several minutes, keep this tab open)…');
        try {
            var res = await TriviaBuilder.build({
                strict: !$('allowMissing').checked,
                onProgress: function (x) {
                    var text = 'Fetching ' + x.label + ' (' + x.lang + ') ' + x.step + '/' + x.steps + (x.page ? ' — page ' + x.page + ', ' + x.rows.toLocaleString('en-US') + ' rows' : '') + '…';
                    setBar(x.step - 1 + (x.page ? 0.5 : 0), x.steps, text);
                    if (!x.page) line(text);
                },
                onRetry: function (err, n) { line('  ↻ ' + err.message + ' — retrying (' + n + '/2)…', 'warn'); },
                warn: function (text) { line(text, 'warn'); }
            });
            setBar(1, 1, 'Done in ' + Math.round((Date.now() - started) / 1000) + ' s.');
            var s = res.summary;
            var rows = s.difficulties.map(function (d) {
                return '<tr><td>' + d.emoji + ' ' + d.name + '</td><td>' + d.words.toLocaleString('en-US') + '</td><td>' + d.complete.toLocaleString('en-US') + '</td></tr>';
            }).join('');
            $('summary').innerHTML = '<table><tr><th>Difficulty</th><th>Words</th><th>Usable in all 4 languages</th></tr>' + rows + '</table>';
            $('meta').textContent = 'Format ' + s.format + ' · languages: ' + s.langs.map(function (l) { return LANG_NAMES[l] || l; }).join(', ') +
                ' · ' + (s.size / 1048576).toFixed(1) + ' MB' + (s.incomplete ? ' · INCOMPLETE (missing: ' + s.failed.join(', ') + ')' : '');
            $('sha').textContent = res.sha256;
            var url = URL.createObjectURL(new Blob([res.bytes], { type: 'application/json' }));
            var a = $('download');
            a.href = url;
            a.download = 'trivia_bank.json';
            show('incompleteNote', s.incomplete);
            show('result', true);
            a.click();
            line('Finished. trivia_bank.json is downloading.', 'ok');
        } catch (err) {
            setBar(0, 1, 'Stopped.');
            var blocked = /could not reach XIVAPI/.test(err.message);
            fail('The build stopped', err.message + (blocked ? '\\n\\nThe connection was lost or blocked in the middle. Try again.' :
                /languages missing/.test(err.message) ? '\\n\\nOne language could not be downloaded. Try again later, or tick "Allow a bank with missing languages".' : ''));
            return;
        }
        btn.disabled = false;
        btn.textContent = 'Build again';
    });
})();`;

function html() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trivia Data Builder</title>
<!-- Made by tools/build-trivia-builder.js — do not edit by hand, run: node tools/build-trivia-builder.js -->
<style>
:root { --bg: #f6f7fb; --card: #fff; --text: #1d2130; --muted: #5d6478; --accent: #5865f2; --ok: #1f8b4c; --warn: #b26a00; --err: #c0392b; --line: #e3e6ef; }
@media (prefers-color-scheme: dark) { :root { --bg: #15171e; --card: #1f222b; --text: #e8eaf1; --muted: #a0a6b8; --line: #343846; --warn: #f0a640; --err: #ff6b5b; --ok: #4cc77f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 60px; }
h1 { font-size: 26px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
ol { margin: 0; padding-left: 20px; } li { margin: 4px 0; }
button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 12px 28px; font-size: 16px; font-weight: 600; cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
label { color: var(--muted); font-size: 14px; margin-left: 12px; }
.track { height: 10px; background: var(--line); border-radius: 5px; overflow: hidden; margin: 18px 0 6px; }
#bar { height: 100%; width: 0; background: var(--accent); transition: width .3s; }
#barText { color: var(--muted); font-size: 14px; min-height: 21px; }
#log { font: 12.5px/1.45 ui-monospace, Consolas, monospace; max-height: 240px; overflow: auto; margin-top: 10px; color: var(--muted); }
#log .warn { color: var(--warn); } #log .ok { color: var(--ok); font-weight: 600; }
#error { border-color: var(--err); } #error h2 { color: var(--err); font-size: 18px; margin: 0 0 6px; } #errText { white-space: pre-wrap; margin: 0; }
#result h2 { color: var(--ok); font-size: 18px; margin: 0 0 10px; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: 13px; } td:nth-child(n+2), th:nth-child(n+2) { text-align: right; }
#meta { color: var(--muted); font-size: 14px; }
code, #sha { font-family: ui-monospace, Consolas, monospace; } #sha { word-break: break-all; display: block; background: var(--bg); padding: 8px 10px; border-radius: 6px; margin-top: 4px; user-select: all; }
a.dl { display: inline-block; margin: 12px 0 4px; font-weight: 600; color: var(--accent); }
.note { color: var(--warn); }
</style>
</head>
<body>
<main>
<h1>🧩 Trivia Data Builder</h1>
<p class="sub">Makes the Pingway Trivia word bank (<code>trivia_bank.json</code>) from XIVAPI in English, French, German and Japanese — right here in your browser.</p>
<div class="card">
<ol>
<li>Press <b>Build</b> and keep this tab open (it takes a few minutes).</li>
<li>When it's done, <b>trivia_bank.json</b> downloads.</li>
<li>Upload it to the bot server as <code>data/trivia_bank.json</code> (replace the old one) and restart the bot.</li>
<li>Optional: check the file's SHA-256 on the server (<code>sha256sum data/trivia_bank.json</code>) — it must match the one shown below.</li>
</ol>
<p class="sub" style="margin:12px 0 0">Build a new one when FFXIV adds new content (a patch with new jobs, duties, mounts, minions or items).</p>
</div>
<div class="card">
<button id="build">Build</button><label><input type="checkbox" id="allowMissing"> Allow a bank with missing languages</label>
<div class="track"><div id="bar"></div></div>
<div id="barText">Ready.</div>
<div id="log"></div>
</div>
<div class="card" id="error" hidden><h2 id="errTitle"></h2><p id="errText"></p></div>
<div class="card" id="result" hidden>
<h2>✅ Word bank ready</h2>
<div id="summary"></div>
<div id="meta"></div>
<p class="note" id="incompleteNote" hidden>Some languages are missing: players of those languages will see the English words. Build again later for a full bank.</p>
<a class="dl" id="download">⬇ Download trivia_bank.json again</a>
<div>SHA-256:<span id="sha"></span></div>
</div>
</main>
<script id="trivia-core">
${bundleSource()}
</script>
<script id="trivia-ui">${UI}
</script>
</body>
</html>
`;
}

if (require.main === module) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, html());
    console.log('Wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB).');
}

module.exports = { OUT, bundleSource, html };
