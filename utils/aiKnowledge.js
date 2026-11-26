// AI knowledge for the AI channel (/ailistenhere): Pingway FAQ + fight guides (Ultimate / Savage / Extreme).
// Pingway NEVER downloads this: the owner uploads the files himself, Pingway only reads them.
//   data/ai/faq.json          - the website FAQ in 4 languages (made by tools/build-ai-faq.js)
//   data/ai/fights/<id>.json  - one file per fight
// Memory: at startup only a small INDEX is kept (ids, names, aliases, strat names, mechanic names/aliases).
// A fight file is read only when a question needs it, and only the last few fights stay in memory (LRU cache).
// Missing folder or files = feature quietly off, the AI works as before (no knowledge attached).
// Search is local (no AI cost): the cleaned user text is matched against FAQ keywords and fight/mechanic names.
const fs = require('fs');
const path = require('path');
const { normalize } = require('./normalizeText');

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'ai');
const LANGS = ['en', 'fr', 'de', 'ja'];
const LANG_NAMES = { en: 'English', fr: 'French', de: 'German', ja: 'Japanese' };
const FIGHT_CACHE_MAX = 5;   // full fight files kept in memory at the same time
const FAQ_MIN = 4;           // FAQ score needed before an entry is attached
const FAQ_WITH_FIGHT_MIN = 6; // FAQ score needed when the message is already about a fight
const FIGHT_MIN = 5;         // fight / mechanic score needed before a fight is attached
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;

const STOP = new Set(('a an the i me my to do does did how what why is are can it in on of for and or with you your please there get ' +
    'this that be at as so if we our us when where which who will would should could about any some just tell know ' +
    'le la les un une des de du et ou je tu il mon ma mes ton ta tes est sont comment quoi que qui pour pas ne en au aux sur avec ce cette puis peux faire ' +
    'der die das ein eine und oder ich du mein meine dein deine ist sind wie was wer für fur nicht im am auf mit kann zu den dem des es').split(' '));

let dir = DEFAULT_DIR;
let faq = [];          // [{ id, link, linkLabel{}, q{}, a{}, idx{lang:{keys,qWords,cjk}} }]
let fights = [];       // index only: [{ id, type, expansion, file, names{}, nameKeys{lang:[...]}, strats:[{id,names{},keys[]}], mechs:[{id,phase,keys{lang:[...]}}] }]
let fightById = new Map();
const cache = new Map(); // fightId -> full parsed file (LRU: oldest first)
const counters = { fileLoads: 0 };

// For matching only: also drop accents (the website FAQ keywords are written without them, e.g. "hinzufugen")
const clean = text => normalize(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
const stem = w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = text => clean(text).split(' ').filter(Boolean).map(stem);
const pick = (obj, lang) => (obj && typeof obj === 'object' ? (obj[lang] || obj.en || '') : (typeof obj === 'string' ? obj : ''));

// Does the cleaned text contain this name? Latin: whole words; Japanese: anywhere (no spaces in Japanese).
function hasPhrase(normText, phrase) {
    if (!phrase || phrase.length < 2) return false;
    if (CJK.test(phrase)) return normText.includes(phrase);
    return (' ' + normText + ' ').includes(' ' + phrase + ' ');
}

function cleanList(list) {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
        const n = clean(x);
        if (n.length >= 2 && !out.includes(n)) out.push(n);
    }
    return out;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildFaqIndex(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : []);
    return list.filter(e => e && e.id && e.q && e.a).map(e => {
        const idx = {};
        for (const l of LANGS) {
            const kLocal = pick(e.k, l);
            const kEn = pick(e.k, 'en');
            idx[l] = {
                keys: new Set([...words(kLocal), ...words(kEn)].filter(w => !STOP.has(w))),
                qWords: new Set(words(pick(e.q, l)).filter(w => !STOP.has(w))),
                cjk: l === 'ja' ? clean(kLocal).split(' ').filter(w => w.length >= 2 && CJK.test(w)) : []
            };
        }
        return { id: String(e.id), link: e.link || null, linkLabel: e.linkLabel || null, q: e.q, a: e.a, idx };
    });
}

function indexFight(data, file) {
    if (!data || !data.id) return null;
    const nameKeys = {};
    for (const l of LANGS) nameKeys[l] = cleanList([data.names && data.names[l], ...((data.aliases && data.aliases[l]) || [])].filter(Boolean));
    const strats = (Array.isArray(data.strats_overview) ? data.strats_overview : []).filter(s => s && s.id).map(s => ({
        id: String(s.id),
        names: s.name || {},
        keys: cleanList([...LANGS.map(l => s.name && s.name[l]), String(s.id), String(s.id).replace(/[-_]/g, ' ')].filter(Boolean))
    }));
    const mechs = [];
    for (const ph of Array.isArray(data.phases) ? data.phases : []) {
        for (const m of (ph && Array.isArray(ph.mechanics)) ? ph.mechanics : []) {
            if (!m || !m.id) continue;
            const keys = {};
            for (const l of LANGS) keys[l] = cleanList([m.names && m.names[l], ...((m.aliases && m.aliases[l]) || [])].filter(Boolean));
            mechs.push({ id: String(m.id), phase: String(ph.id || ''), keys });
        }
    }
    return { id: String(data.id), type: data.type || '', expansion: data.expansion || '', file, names: data.names || {}, nameKeys, strats, mechs };
}

// (Re)build the index. Called once when the bot starts; tests pass their own fixture folder.
function init(folder) {
    dir = folder || DEFAULT_DIR;
    faq = [];
    fights = [];
    fightById = new Map();
    cache.clear();
    counters.fileLoads = 0;
    try {
        const faqFile = path.join(dir, 'faq.json');
        if (fs.existsSync(faqFile)) faq = buildFaqIndex(readJson(faqFile));
    } catch (e) {
        console.error('⚠️ [AI] Could not read data/ai/faq.json: ' + e.message);
        faq = [];
    }
    try {
        const fdir = path.join(dir, 'fights');
        if (fs.existsSync(fdir)) {
            for (const name of fs.readdirSync(fdir).filter(n => n.endsWith('.json')).sort()) {
                try {
                    const entry = indexFight(readJson(path.join(fdir, name)), path.join(fdir, name));
                    if (entry && !fightById.has(entry.id)) { fights.push(entry); fightById.set(entry.id, entry); }
                } catch (e) {
                    console.error('⚠️ [AI] Skipped fight file ' + name + ': ' + e.message);
                }
            }
        }
    } catch (e) {
        console.error('⚠️ [AI] Could not read data/ai/fights: ' + e.message);
    }
    if (faq.length || fights.length) console.log(`🧠 [AI] Knowledge ready: ${faq.length} FAQ entries, ${fights.length} fights`);
    return { faq: faq.length, fights: fights.length };
}

function enabled() { return faq.length > 0 || fights.length > 0; }

// Full fight file, read on demand; only the last FIGHT_CACHE_MAX fights stay in memory
function getFight(id) {
    const entry = fightById.get(id);
    if (!entry) return null;
    if (cache.has(id)) {
        const hit = cache.get(id);
        cache.delete(id);
        cache.set(id, hit);
        return hit;
    }
    let data = null;
    try {
        data = readJson(entry.file);
        counters.fileLoads++;
    } catch (e) {
        console.error('⚠️ [AI] Could not read fight file ' + id + ': ' + e.message);
        return null;
    }
    cache.set(id, data);
    while (cache.size > FIGHT_CACHE_MAX) cache.delete(cache.keys().next().value);
    return data;
}

function fightIndex(id) { return fightById.get(id) || null; }

// Rough language of a message (null = can't tell)
function detectLang(text) {
    const s = String(text || '');
    if (CJK.test(s)) return 'ja';
    const n = ' ' + normalize(s) + ' ';
    if (/[äöüß]/.test(n) || /\s(der|die|das|ist|wie|warum|und|ich|nicht|mit|wir|welche|kannst|bitte)\s/.test(n)) return 'de';
    if (/[éèêàçùœ]/.test(n) || /\s(le|la|les|est|comment|pourquoi|et|je|pas|avec|nous|quelle|quel|peux|stp)\s/.test(n)) return 'fr';
    return null;
}

function langsFor(userLang, text) {
    const out = [];
    for (const l of [userLang, detectLang(text), 'en']) if (LANGS.includes(l) && !out.includes(l)) out.push(l);
    return out;
}

function searchFaq(normText, langs) {
    if (!faq.length || !normText) return [];
    const ws = normText.split(' ').filter(Boolean).map(stem).filter(w => !STOP.has(w));
    const scored = [];
    for (const e of faq) {
        let best = 0;
        for (const l of langs) {
            const ix = e.idx[l];
            let score = 0;
            for (const w of ws) {
                if (ix.keys.has(w)) score += 3;
                if (ix.qWords.has(w)) score += 1;
            }
            for (const k of ix.cjk) if (normText.includes(k)) score += 3;
            if (score > best) best = score;
        }
        if (best >= FAQ_MIN) scored.push({ entry: e, score: best });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.length ? scored[0].score : 0;
    return scored.filter(x => x.score >= top / 2).slice(0, 3);
}

function searchFight(normText, langs, contextFightId) {
    if (!fights.length || !normText) return null;
    const results = [];
    for (const f of fights) {
        let fightScore = 0;
        for (const l of langs) for (const k of f.nameKeys[l] || []) if (hasPhrase(normText, k)) fightScore = 6;
        let mech = null;
        let mechScore = 0;
        for (const m of f.mechs) {
            for (const l of langs) {
                for (const k of m.keys[l] || []) {
                    if (!hasPhrase(normText, k)) continue;
                    const s = 5 + Math.min(k.length, 20) / 20; // longer names are more specific
                    if (s > mechScore) { mechScore = s; mech = m; }
                }
            }
        }
        const total = fightScore + mechScore;
        if (total >= FIGHT_MIN) results.push({ id: f.id, score: total, fightScore, mechId: mech ? mech.id : null });
    }
    if (!results.length) return null;
    results.sort((a, b) => b.score - a.score);
    const best = results[0];
    const tied = results.filter(r => r.score === best.score);
    if (tied.length > 1 && !best.fightScore) {
        // the same mechanic name in several fights and no fight named: the fight being talked about wins, else ask
        const ctx = tied.find(r => r.id === contextFightId);
        if (ctx) return ctx;
        return { id: null, ambiguous: tied.slice(0, 5).map(r => r.id), score: best.score };
    }
    return best;
}

// Local search: { faq: [{entry, score}], fight: {id, mechId, score} | {id:null, ambiguous:[ids]} | null }
function search(text, opts = {}) {
    const normText = clean(text);
    const langs = opts.langs || langsFor(opts.userLang || 'en', text);
    const fight = searchFight(normText, langs, opts.contextFightId || null);
    let faqHits = searchFaq(normText, langs);
    // A fight question: a FAQ entry is only added when the message clearly asks about Pingway too (2+ keywords)
    if (fight) faqHits = faqHits.filter(x => x.score >= FAQ_WITH_FIGHT_MIN);
    return { faq: faqHits, fight };
}

// Which strat of this fight does the text name? Exactly one strat named = its id; none or several = null.
function matchStrat(text, fightId) {
    const f = fightById.get(fightId);
    if (!f || !f.strats.length) return null;
    const normText = clean(text);
    const hits = f.strats.filter(s => s.keys.some(k => hasPhrase(normText, k)));
    return hits.length === 1 ? hits[0].id : null;
}

function stratName(fightId, stratId, lang) {
    const f = fightById.get(fightId);
    const s = f && f.strats.find(x => x.id === stratId);
    return s ? (pick(s.names, lang) || s.id) : stratId;
}

function findMechanic(data, mechId) {
    for (const ph of Array.isArray(data.phases) ? data.phases : []) {
        for (const m of (ph && Array.isArray(ph.mechanics)) ? ph.mechanics : []) {
            if (m && String(m.id) === mechId) return { phase: ph, mech: m };
        }
    }
    return null;
}

// How a strat resolves this mechanic (follows "same_as")
function stratHow(mech, stratId, lang) {
    const list = Array.isArray(mech.strats) ? mech.strats : [];
    let entry = list.find(s => s && s.strat === stratId);
    const seen = new Set();
    while (entry && !entry.how && entry.same_as && !seen.has(entry.same_as)) {
        seen.add(entry.same_as);
        entry = list.find(s => s && s.strat === entry.same_as);
    }
    return entry && entry.how ? pick(entry.how, lang) : '';
}

function faqText(results, lang) {
    return results.map(({ entry }) => {
        const link = entry.link ? `\nLink: ${entry.link}` : '';
        return `Q: ${pick(entry.q, lang)}\nA: ${pick(entry.a, lang)}${link}`;
    }).join('\n\n');
}

// Knowledge block for the AI about one fight.
// stratId: the user's saved strat (or null). Returns { text, askStrat } - askStrat = the AI must ask which strat first.
function fightText(match, lang, stratId) {
    if (!match) return { text: '', askStrat: false };
    if (!match.id && match.ambiguous) {
        const names = match.ambiguous.map(id => pick((fightById.get(id) || {}).names, lang) || id).join(', ');
        return { text: `The question may be about one of these fights: ${names}. Ask which fight they mean.`, askStrat: false };
    }
    const data = getFight(match.id);
    if (!data) return { text: '', askStrat: false };
    const idx = fightById.get(match.id);
    const stratsAll = idx.strats;
    const savedOk = stratId && stratsAll.some(s => s.id === stratId) ? stratId : null;
    const lines = [`FIGHT: ${pick(data.names, lang)} (${data.type || ''}, ${data.expansion || ''}) [fight id: ${data.id}]`];
    const stratList = stratsAll.map(s => `${pick(s.names, lang) || s.id} [strat id: ${s.id}]`).join('; ');
    const found = match.mechId ? findMechanic(data, match.mechId) : null;
    let askStrat = false;

    if (found) {
        const { phase, mech } = found;
        lines.push(`MECHANIC: ${pick(phase.names, lang)} - ${pick(mech.names, lang)}`);
        if (mech.how) lines.push(`How it works: ${pick(mech.how, lang)}`);
        if (mech.uncertain) lines.push(`Note: this info is not fully certain. ${pick(mech.note, lang)}`.trim());
        else if (mech.note) lines.push(`Note: ${pick(mech.note, lang)}`);
        const mechStrats = Array.isArray(mech.strats) ? mech.strats.filter(s => s && s.strat) : [];
        const chosen = savedOk || (stratsAll.length === 1 ? stratsAll[0].id : (stratsAll.length === 0 && mechStrats.length === 1 ? mechStrats[0].strat : null));
        if (chosen) {
            const how = stratHow(mech, chosen, lang);
            lines.push(`The user's group uses the strat: ${stratName(match.id, chosen, lang)}.`);
            lines.push(how ? `How this strat does it: ${how}` : 'This strat has no special notes for this mechanic.');
            lines.push('Explain ONLY this strat, never the other strats.');
        } else if (stratsAll.length > 1) {
            askStrat = true;
            lines.push(`Strats for this fight: ${stratList}.`);
            lines.push('The user has not told you their strat yet. Do NOT explain any strat now: say in one or two sentences what the mechanic is, then ask which of these strats their group uses (list the strat names).');
        }
    } else {
        if (data.summary) lines.push(`Summary: ${pick(data.summary, lang)}`);
        if (savedOk) lines.push(`The user's group uses the strat: ${stratName(match.id, savedOk, lang)}.`);
        else if (stratsAll.length) lines.push(`Strats for this fight: ${stratList}.`);
        const mechNames = [];
        for (const ph of Array.isArray(data.phases) ? data.phases : []) {
            const ms = ((ph && ph.mechanics) || []).map(m => pick(m.names, lang)).filter(Boolean);
            if (ms.length) mechNames.push(`${pick(ph.names, lang) || ph.id}: ${ms.join(', ')}`);
        }
        if (mechNames.length) lines.push('Mechanics: ' + mechNames.join(' | '));
        lines.push('If they ask about one mechanic, ask which one if it is not clear.');
    }
    return { text: lines.join('\n'), askStrat };
}

function stats() {
    return { fileLoads: counters.fileLoads, cached: [...cache.keys()], cacheMax: FIGHT_CACHE_MAX };
}

// Index the default folder when the bot starts
init(DEFAULT_DIR);

module.exports = {
    init, enabled, search, detectLang, langsFor, matchStrat, stratName, getFight, fightIndex,
    faqText, fightText, stats, hasPhrase, LANG_NAMES, FIGHT_CACHE_MAX
};
