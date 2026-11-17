// Browser side of the FFXIV Collect lists builder (inlined into misc/pingway-data-updater.html by tools/build-data-updater.js).
// The download and trim code is the code of the owner's collect-builder.html, unchanged (same lists, languages, item shape,
// retries and pacing); only the page parts (log, button) are given by the caller. Builds data/ffxivcollect-lists.json
// (format "pingway-collect-1") and checks it with the bot's own parseListsFile() from utils/ffxivCollect.js (bundled too).
// Data by FFXIV Collect (https://ffxivcollect.com).

const FC = require('./ffxivCollect');

const BASE = 'https://ffxivcollect.com/api';
const LISTS = { mounts: '/mounts', minions: '/minions', achievements: '/achievements', orchestrions: '/orchestrions',
  emotes: '/emotes', hairstyles: '/hairstyles', bardings: '/bardings', cards: '/triad/cards' };
const LANGS = ['en', 'fr', 'de', 'ja'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpsOnly = u => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u : '';
const pct = v => { const n = parseFloat(String(v == null ? '' : v).replace('%', '')); return Number.isFinite(n) ? n : 0; };

function slim(collection, raw) {
  if (!raw || raw.id === undefined) return null;
  if (collection === 'minions' && raw.owned === undefined) return null; // minion variants
  const it = { id: Number(raw.id), name: String(raw.name || ''), icon: httpsOnly(raw.icon), owned: pct(raw.owned),
    sources: Array.isArray(raw.sources) ? raw.sources.slice(0, 4).map(s => ({ type: String(s.type || ''), text: String(s.text || '') })) : [] };
  if (collection === 'achievements') { it.desc = String(raw.description || '').slice(0, 300); it.points = Number(raw.points) || 0; }
  return it;
}

// log(msg, cls) = a line on the page; retryMs (2000) = wait after a failed try (x1, x2, x3)
function makeGetJson(log, retryMs) {
  return async function getJson(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(url);
        if (r.ok) return await r.json();
        log(`  ${url} → HTTP ${r.status} (try ${attempt}/3)`, 'bad');
      } catch (e) { log(`  ${url} → ${e.message} (try ${attempt}/3)`, 'bad'); }
      await sleep(retryMs * attempt);
    }
    throw new Error('Could not download ' + url);
  };
}

// opts: { log(msg, cls), onProgress({ lang, key, step, steps, count }), pauseMs (400), retryMs (2000) }
// Returns { text (the file), bytes (Uint8Array), out (the object) }. Throws when a list can't be downloaded.
async function build(opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const progress = o.onProgress || (() => {});
  const pauseMs = o.pauseMs === undefined ? 400 : o.pauseMs;
  const getJson = makeGetJson(log, o.retryMs === undefined ? 2000 : o.retryMs);
  const steps = LANGS.length * Object.keys(LISTS).length;
  let step = 0;
  const out = { format: 'pingway-collect-1', builtAt: new Date().toISOString(), langs: {} };
  for (const lang of LANGS) {
    out.langs[lang] = {};
    for (const [key, path] of Object.entries(LISTS)) {
      progress({ lang, key, step: ++step, steps, count: null });
      const j = await getJson(`${BASE}${path}?language=${lang}`);
      const items = (Array.isArray(j.results) ? j.results : []).map(r => slim(key, r)).filter(Boolean);
      out.langs[lang][key] = items;
      log(`✓ ${lang} ${key}: ${items.length}`, 'ok');
      progress({ lang, key, step, steps, count: items.length });
      await sleep(pauseMs); // gentle on FFXIV Collect
    }
  }
  for (const key of Object.keys(LISTS)) {
    const n = out.langs.en[key].length;
    if (!n) throw new Error(`English ${key} list is empty — not saving.`);
  }
  const text = JSON.stringify(out);
  return { text, bytes: new TextEncoder().encode(text), out };
}

// The bot's own check on the file text (utils/ffxivCollect.js parseListsFile, the code Pingway runs when it reads the file).
// Returns { ok, problems: [], warnings: [], counts: { en: { mounts: n, ... } }, builtAt }
function check(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, problems: ['the file is not valid JSON'], warnings: [], counts: {}, builtAt: null }; }
  const parsed = FC.parseListsFile(raw);
  if (!parsed) return { ok: false, problems: ['Pingway would not load it (not a valid ' + FC.LISTS_FORMAT + ' file)'], warnings: [], counts: {}, builtAt: null };
  const problems = [];
  const warnings = [];
  const counts = {};
  for (const l of LANGS) {
    if (!parsed.langs[l]) { problems.push('language ' + l + ' is missing'); continue; }
    counts[l] = {};
    for (const c of FC.COLLECTION_KEYS) {
      if (!Array.isArray(parsed.langs[l][c])) { problems.push(l + ' ' + c + ' list is missing'); continue; }
      counts[l][c] = parsed.langs[l][c].length;
    }
  }
  if (parsed.dropped) warnings.push(parsed.dropped + ' item(s) did not pass the check and will be left out by Pingway');
  return { ok: !problems.length, problems, warnings, counts, builtAt: parsed.builtAt };
}

module.exports = { build, check, slim, BASE, LISTS, LANGS, LISTS_FORMAT: FC.LISTS_FORMAT, COLLECTION_KEYS: FC.COLLECTION_KEYS };
