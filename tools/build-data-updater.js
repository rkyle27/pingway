// Makes misc/pingway-data-updater.html: ONE local page the owner opens in Chrome (file://, double-click) that builds BOTH
// data files Pingway reads and saves them with their exact names:
//   data/trivia_bank.json         (Trivia word bank, from XIVAPI)  — the Trivia Data Builder code
//   data/ffxivcollect-lists.json  (FFXIV Collect item lists)       — the Collect List Builder code
//   node tools/build-data-updater.js     (run again after changing the Trivia bank code, locales/*/trivia.json,
//                                          utils/ffxivCollect.js or tools/collect-builder-runtime.js)
// Pingway itself never downloads these lists: this page runs in the owner's browser and is the way to make them.
// The page contains the REAL code, bundled as it is:
//   * Trivia: the same bundle as misc/trivia-builder.html (bundleSource() of tools/build-trivia-builder.js).
//   * Collect: utils/ffxivCollect.js (for the bot's own parseListsFile check) + tools/collect-builder-runtime.js.
//     fs/path/process are small stand-ins in the page (nothing is read from them to build or check the lists).
// No external scripts.
'use strict';

const fs = require('fs');
const path = require('path');
const trivia = require('./build-trivia-builder');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'misc', 'pingway-data-updater.html');
const COLLECT_MODULES = { ffxivCollect: 'utils/ffxivCollect.js', runtime: 'tools/collect-builder-runtime.js' };

// The Collect bundle: defines the global CollectBuilder (= tools/collect-builder-runtime.js exports)
function collectBundleSource() {
    const parts = [];
    parts.push('var CollectBuilder = (function () {');
    parts.push(`var SHIMS = {
    fs: { promises: {} },
    path: { join: function () { return Array.prototype.slice.call(arguments).join('/'); }, dirname: function (p) { return String(p).replace(/[\\\\/][^\\\\/]*$/, ''); } }
};
var PROCESS = { env: {} };
var DEFS = {}, CACHE = {};
function req(name) {
    var key = String(name).replace(/^\\.\\.?\\//, '').replace(/\\.js$/, '');
    if (SHIMS[key]) return SHIMS[key];
    if (CACHE[key]) return CACHE[key].exports;
    if (!DEFS[key]) throw new Error('module not in the page: ' + name);
    var module = { exports: {} };
    CACHE[key] = module;
    DEFS[key](module, module.exports, req, 'utils', PROCESS);
    return module.exports;
}`);
    for (const [name, file] of Object.entries(COLLECT_MODULES)) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        parts.push('// ---- ' + file + ' ----');
        parts.push('DEFS[' + JSON.stringify(name) + '] = function (module, exports, require, __dirname, process) {\n' + src + '\n};');
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
    var LANGS = ['en', 'fr', 'de', 'ja'];
    var LANG_NAMES = { en: 'English', fr: 'French', de: 'German', ja: 'Japanese' };
    var buttons = [$('all'), $('triviaOnly'), $('collectOnly')];
    var nf = function (n) { return Number(n).toLocaleString('en-US'); };
    var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
    var size = function (n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB'; };

    // One part of the page (p = 'trivia' or 'collect')
    function part(p) {
        var el = function (id) { return $(p + '-' + id); };
        return {
            line: function (text, cls) {
                var d = document.createElement('div');
                d.textContent = text;
                if (cls) d.className = cls;
                el('log').appendChild(d);
                el('log').scrollTop = el('log').scrollHeight;
            },
            bar: function (frac, text) { el('bar').style.width = Math.round(frac * 100) + '%'; el('barText').textContent = text; },
            state: function (text, cls) { el('state').textContent = text; el('state').className = 'state ' + (cls || ''); },
            reset: function () {
                el('log').textContent = ''; el('error').hidden = true; el('result').hidden = true;
                el('bar').style.width = '0'; el('barText').textContent = 'Waiting…';
            },
            fail: function (title, text) {
                el('errTitle').textContent = title; el('errText').textContent = text; el('error').hidden = false;
                this.state('Failed — not saved', 'bad');
            },
            el: el
        };
    }
    function save(a, bytes, name) {
        if (a.href) URL.revokeObjectURL(a.href);
        a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
        a.download = name;
        a.click();
    }

    // ---------- Trivia (data/trivia_bank.json) ----------
    // The checks Pingway does when it reads the file (utils/trivia.js loadBankFile + bankIsOld)
    function checkTrivia(text, res) {
        var problems = [], warnings = [], b = null;
        try { b = JSON.parse(text); } catch (e) { problems.push('the file is not valid JSON'); }
        if (b) {
            if (!b.pools) problems.push('no word pools');
            res.summary.difficulties.forEach(function (d) {
                if (!b.pools || !Array.isArray(b.pools[d.key]) || !b.pools[d.key].length) problems.push(d.name + ' has no words');
            });
            if ((Number(b.format) || 1) !== TriviaBuilder.BANK_FORMAT) problems.push('format ' + b.format + ' (Pingway expects ' + TriviaBuilder.BANK_FORMAT + ')');
            if (!Number(b.builtAt)) problems.push('no build date');
            if (b.incomplete) warnings.push('the bank is marked incomplete (missing: ' + res.summary.failed.join(', ') + '): players of those languages see the English words');
        }
        return { ok: !problems.length, problems: problems, warnings: warnings, bank: b };
    }
    async function runTrivia() {
        var P = part('trivia');
        P.reset(); P.state('Running…', 'run');
        var started = Date.now();
        P.bar(0, 'Checking that the browser can reach XIVAPI…');
        var p = await TriviaBuilder.probe({});
        if (!p.ok) {
            P.bar(0, 'Stopped.');
            if (p.blocked) {
                P.fail('The browser could not reach XIVAPI', 'Chrome blocked the request or there is no connection (' + p.message + ').\\n\\n' +
                    'Most likely cause: XIVAPI does not allow pages opened from a file on your PC (file://, "Origin: null") — this is CORS, ' +
                    'and a page opened from a file cannot get around it. Check your internet connection and turn off ad blockers for this page, then try again. ' +
                    'If it still fails, open DevTools (F12) → Console: a message with "CORS" or "Access-Control-Allow-Origin" confirms it.');
            } else {
                P.fail('XIVAPI did not answer properly', p.message + '. XIVAPI may be down or busy: try again in a few minutes.');
            }
            return false;
        }
        P.line('XIVAPI can be reached. Fetching everything (this takes several minutes, keep this tab open)…');
        var res;
        try {
            res = await TriviaBuilder.build({
                strict: !$('allowMissing').checked,
                onProgress: function (x) {
                    var text = 'Fetching ' + x.label + ' (' + x.lang + ') ' + x.step + '/' + x.steps + (x.page ? ' — page ' + x.page + ', ' + nf(x.rows) + ' rows' : '') + '…';
                    P.bar((x.step - 1 + (x.page ? 0.5 : 0)) / x.steps, text);
                    if (!x.page) P.line(text);
                },
                onRetry: function (err, n) { P.line('  ↻ ' + err.message + ' — retrying (' + n + '/2)…', 'warn'); },
                warn: function (text) { P.line(text, 'warn'); }
            });
        } catch (err) {
            P.bar(0, 'Stopped.');
            var blocked = /could not reach XIVAPI/.test(err.message);
            P.fail('The Trivia build stopped', err.message + (blocked ? '\\n\\nThe connection was lost or blocked in the middle. Try again.' :
                /languages missing/.test(err.message) ? '\\n\\nOne language could not be downloaded. Try again later, or tick "Allow a bank with missing languages".' : ''));
            return false;
        }
        var c = checkTrivia(res.text, res);
        if (!c.ok) {
            P.bar(0, 'Stopped.');
            P.fail('The Trivia file did not pass Pingway\\'s check', c.problems.join('\\n') + '\\n\\nNothing was saved. Try again.');
            return false;
        }
        P.bar(1, 'Done in ' + Math.round((Date.now() - started) / 1000) + ' s.');
        var s = res.summary, b = c.bank;
        var head = '<tr><th>Difficulty</th>' + LANGS.map(function (l) { return '<th>' + l.toUpperCase() + '</th>'; }).join('') + '<th>All 4</th></tr>';
        var rows = s.difficulties.map(function (d) {
            var pool = b.pools[d.key];
            var per = LANGS.map(function (l) {
                var n = l === 'en' ? pool.length : pool.filter(function (e) { return e && e.i18n && e.i18n[l] && e.i18n[l].word; }).length;
                return '<td>' + nf(n) + '</td>';
            }).join('');
            return '<tr><td>' + d.emoji + ' ' + esc(d.name) + '</td>' + per + '<td>' + nf(d.complete) + '</td></tr>';
        }).join('');
        P.el('summary').innerHTML = '<table>' + head + rows + '</table>';
        P.el('meta').textContent = 'Built ' + new Date(Number(b.builtAt)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC · format ' + s.format +
            ' · languages: ' + s.langs.map(function (l) { return LANG_NAMES[l] || l; }).join(', ') + ' · ' + size(s.size) +
            (s.incomplete ? ' · INCOMPLETE (missing: ' + s.failed.join(', ') + ')' : '');
        P.el('warn').textContent = c.warnings.join('\\n');
        P.el('warn').hidden = !c.warnings.length;
        P.el('sha').textContent = res.sha256;
        P.el('result').hidden = false;
        save(P.el('download'), res.bytes, 'trivia_bank.json');
        P.line('Finished. trivia_bank.json is downloading.', 'ok');
        P.state('Saved ✓', 'ok');
        return true;
    }

    // ---------- Collect (data/ffxivcollect-lists.json) ----------
    async function runCollect() {
        var P = part('collect');
        P.reset(); P.state('Running…', 'run');
        var started = Date.now();
        P.bar(0, 'Starting…');
        var res;
        try {
            res = await CollectBuilder.build({
                log: function (msg, cls) { P.line(msg, cls === 'bad' ? 'warn' : cls); },
                onProgress: function (x) {
                    if (x.count === null) P.bar((x.step - 1) / x.steps, 'Fetching ' + x.key + ' (' + x.lang + ') ' + x.step + '/' + x.steps + '…');
                    else P.bar(x.step / x.steps, 'Fetched ' + x.key + ' (' + x.lang + ') ' + x.step + '/' + x.steps + '.');
                }
            });
        } catch (err) {
            P.bar(0, 'Stopped.');
            P.fail('The Collect build stopped', err.message + (/[.!?]$/.test(err.message) ? '' : '.') + ' Nothing was saved. Try again in a minute.');
            return false;
        }
        var c = CollectBuilder.check(res.text);
        if (!c.ok) {
            P.bar(0, 'Stopped.');
            P.fail('The Collect file did not pass Pingway\\'s check', c.problems.join('\\n') + '\\n\\nNothing was saved. Try again.');
            return false;
        }
        P.bar(1, 'Done in ' + Math.round((Date.now() - started) / 1000) + ' s.');
        var head = '<tr><th>List</th>' + LANGS.map(function (l) { return '<th>' + l.toUpperCase() + '</th>'; }).join('') + '</tr>';
        var rows = CollectBuilder.COLLECTION_KEYS.map(function (k) {
            return '<tr><td>' + esc(k) + '</td>' + LANGS.map(function (l) { return '<td>' + nf(c.counts[l][k]) + '</td>'; }).join('') + '</tr>';
        }).join('');
        P.el('summary').innerHTML = '<table>' + head + rows + '</table>';
        P.el('meta').textContent = 'Built ' + String(c.builtAt).replace('T', ' ').slice(0, 19) + ' UTC · format ' + CollectBuilder.LISTS_FORMAT + ' · ' + size(res.bytes.length);
        P.el('warn').textContent = c.warnings.join('\\n');
        P.el('warn').hidden = !c.warnings.length;
        P.el('result').hidden = false;
        save(P.el('download'), res.bytes, 'ffxivcollect-lists.json');
        P.line('✅ Finished. ffxivcollect-lists.json is downloading.', 'ok');
        P.state('Saved ✓', 'ok');
        return true;
    }

    // ---------- buttons ----------
    async function run(which) {
        buttons.forEach(function (b) { b.disabled = true; });
        $('overall').textContent = 'Working… keep this tab open.';
        $('overall').className = '';
        var jobs = [];
        if (which !== 'collect') { part('trivia').reset(); part('trivia').state('Waiting…', ''); }
        if (which !== 'trivia') { part('collect').reset(); part('collect').state('Waiting…', ''); }
        // Each part catches its own errors: when one fails, the other still finishes and is saved
        var safe = function (fn, p) { return fn().catch(function (err) { part(p).fail('Unexpected error', String(err && err.message || err)); return false; }); };
        if (which !== 'collect') jobs.push(safe(runTrivia, 'trivia'));
        if (which !== 'trivia') jobs.push(safe(runCollect, 'collect'));
        var ok = await Promise.all(jobs);
        var good = ok.filter(Boolean).length;
        $('overall').textContent = good === ok.length ? '✅ Done: ' + good + ' of ' + ok.length + ' file' + (ok.length > 1 ? 's' : '') + ' saved.'
            : '⚠ ' + good + ' of ' + ok.length + ' file' + (ok.length > 1 ? 's' : '') + ' saved — see the error below.';
        $('overall').className = good === ok.length ? 'ok' : 'bad';
        buttons.forEach(function (b) { b.disabled = false; });
    }
    $('all').addEventListener('click', function () { run('all'); });
    $('triviaOnly').addEventListener('click', function () { run('trivia'); });
    $('collectOnly').addEventListener('click', function () { run('collect'); });
})();`;

function partCard(p, title, file, extra) {
    return `<div class="card part" id="${p}">
<div class="phead"><h2>${title}</h2><span class="state" id="${p}-state">Not started</span></div>
<div class="sub small"><code>${file}</code></div>
<div class="track"><div class="bar" id="${p}-bar"></div></div>
<div class="barText" id="${p}-barText">Ready.</div>
<div class="log" id="${p}-log"></div>
<div class="error" id="${p}-error" hidden><h3 id="${p}-errTitle"></h3><p id="${p}-errText"></p></div>
<div class="result" id="${p}-result" hidden>
<h3>✅ ${file} saved</h3>
<div id="${p}-summary"></div>
<div class="meta" id="${p}-meta"></div>
<p class="note" id="${p}-warn" hidden></p>
<a class="dl" id="${p}-download">⬇ Download ${file} again</a>${extra}
</div>
</div>`;
}

function html() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pingway Data Updater</title>
<!-- Made by tools/build-data-updater.js — do not edit by hand, run: node tools/build-data-updater.js -->
<style>
:root { --bg: #f6f7fb; --card: #fff; --text: #1d2130; --muted: #5d6478; --accent: #5865f2; --ok: #1f8b4c; --warn: #b26a00; --err: #c0392b; --line: #e3e6ef; }
@media (prefers-color-scheme: dark) { :root { --bg: #15171e; --card: #1f222b; --text: #e8eaf1; --muted: #a0a6b8; --line: #343846; --warn: #f0a640; --err: #ff6b5b; --ok: #4cc77f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 32px 16px 60px; }
h1 { font-size: 26px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; } .small { font-size: 13px; margin: 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
ol { margin: 0; padding-left: 20px; } li { margin: 4px 0; }
button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 10px 20px; font-size: 15px; font-weight: 600; cursor: pointer; margin: 0 8px 8px 0; }
button.big { padding: 16px 40px; font-size: 20px; display: block; width: 100%; margin: 0 0 12px; }
button.second { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
button:disabled { opacity: .6; cursor: default; }
label { color: var(--muted); font-size: 14px; }
#overall { font-weight: 600; margin-top: 8px; min-height: 22px; } #overall.ok { color: var(--ok); } #overall.bad { color: var(--err); }
.phead { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.part h2 { font-size: 19px; margin: 0; }
.state { font-size: 13px; font-weight: 600; color: var(--muted); } .state.run { color: var(--accent); } .state.ok { color: var(--ok); } .state.bad { color: var(--err); }
.track { height: 10px; background: var(--line); border-radius: 5px; overflow: hidden; margin: 14px 0 6px; }
.bar { height: 100%; width: 0; background: var(--accent); transition: width .3s; }
.barText { color: var(--muted); font-size: 14px; min-height: 21px; }
.log { font: 12.5px/1.45 ui-monospace, Consolas, monospace; max-height: 200px; overflow: auto; margin-top: 10px; color: var(--muted); }
.log .warn { color: var(--warn); } .log .ok { color: var(--ok); font-weight: 600; }
.error { border: 1px solid var(--err); border-radius: 8px; padding: 12px 14px; margin-top: 12px; }
.error h3 { color: var(--err); font-size: 16px; margin: 0 0 6px; } .error p { white-space: pre-wrap; margin: 0; }
.result { margin-top: 12px; } .result h3 { color: var(--ok); font-size: 16px; margin: 0 0 8px; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: 13px; } td:nth-child(n+2), th:nth-child(n+2) { text-align: right; }
.meta { color: var(--muted); font-size: 14px; }
code, .sha { font-family: ui-monospace, Consolas, monospace; } .sha { word-break: break-all; display: block; background: var(--bg); padding: 8px 10px; border-radius: 6px; margin-top: 4px; user-select: all; }
a.dl { display: inline-block; margin: 10px 0 4px; font-weight: 600; color: var(--accent); cursor: pointer; }
.note { color: var(--warn); white-space: pre-wrap; }
footer { color: var(--muted); font-size: 14px; } footer p { margin: 6px 0; }
</style>
</head>
<body>
<main>
<h1>🔄 Pingway Data Updater</h1>
<p class="sub">Builds both data files Pingway reads — the Trivia word bank (<code>trivia_bank.json</code>, from XIVAPI) and the FFXIV Collect item lists (<code>ffxivcollect-lists.json</code>) — in English, French, German and Japanese, right here in your browser.</p>
<div class="card">
<ol>
<li>Press <b>Update all</b> and keep this tab open (it takes a few minutes).</li>
<li>Each file downloads as soon as its part is done, with its exact name. If Chrome asks to allow downloading multiple files, click <b>Allow</b> (or use the "Download again" links).</li>
<li>Each file is checked with Pingway's own checks before it is saved.</li>
<li>Optional: check trivia_bank.json's SHA-256 on the server (<code>sha256sum data/trivia_bank.json</code>) — it must match the one shown below.</li>
</ol>
<p class="sub" style="margin:12px 0 0">Run it again when FFXIV adds new content (a patch with new jobs, duties, mounts, minions, items, achievements, cards…).</p>
</div>
<div class="card">
<button id="all" class="big">Update all</button>
<button id="triviaOnly" class="second">Trivia only</button><button id="collectOnly" class="second">Collect only</button>
<div><label><input type="checkbox" id="allowMissing"> Trivia: allow a bank with missing languages</label></div>
<div id="overall"></div>
</div>
${partCard('trivia', '🧩 Trivia word bank', 'trivia_bank.json', `
<div>SHA-256:<span class="sha" id="trivia-sha"></span></div>`)}
${partCard('collect', '📚 FFXIV Collect lists', 'ffxivcollect-lists.json', '')}
<footer>
<p><b>Upload both files to Cybrancee → Files → data/ (replace the old ones). Trivia needs a Pingway restart; Collect is picked up within a minute.</b></p>
<p>Trivia words from XIVAPI. Data by FFXIV Collect.</p>
</footer>
</main>
<script id="trivia-core">
${trivia.bundleSource()}
</script>
<script id="collect-core">
${collectBundleSource()}
</script>
<script id="updater-ui">${UI}
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

module.exports = { OUT, collectBundleSource, html };
