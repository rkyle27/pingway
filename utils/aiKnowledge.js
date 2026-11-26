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
// Apostrophes are dropped without a space ("Titan's" = "titans"), so names match however people type them
const clean = text => normalize(String(text == null ? '' : text).replace(/['\u2018\u2019\u02bc`]/g, '')).normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
const stem = w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
// Names are compared word by word without a plural "s" ("gaols" = "gaol"); Japanese stays as it is
const stemPhrase = p => (CJK.test(p) ? p : p.split(' ').map(stem).join(' '));
// Words that say nothing about WHICH fight or mechanic (never used for partial matches)
const GENERIC = new Set(('savage ultimate extreme normal door final part phase the and with ex unreal trial raid fight boss mechanic mechanics ' +
    'how work tip tips strat strats guide do does wipe help explain').split(' '));
// Kinds of mechanics (the "tags" in the fight files) and the words people use for them, in all 4 languages
const TAG_WORDS = {
    tankbuster: ['tank buster', 'tankbuster', 'buster', 'tb', 'tank hit', 'tankbusters', 'タンクバスター', 'タンク強攻撃', '強攻撃', 'タンク攻撃', 'バスター'],
    tankswap: ['tank swap', 'tankswap', 'swap tank', 'tank switch', 'タンクスイッチ', 'タンクスワップ'],
    raidwide: ['raidwide', 'raid wide', 'raid damage', 'attaque de zone', 'raidschaden', '全体攻撃'],
    stack: ['stack', 'stack marker', 'partage', 'sammeln', '頭割り'],
    spread: ['spread', 'dispersion', 'verteilen', '散開'],
    knockback: ['knockback', 'knock back', 'kb', 'repoussement', 'projection', 'ruckstoss', 'ノックバック'],
    tower: ['tower', 'tour', 'turm', 'turme', '塔'],
    tether: ['tether', 'lien', 'verbindung', 'テザー', '線取り'],
    proximity: ['proximity', 'distance falloff', '距離減衰'],
    gaze: ['gaze', 'look away', 'regard', 'blick', '視線'],
    cleave: ['cleave', 'cone', 'クリーヴ', '扇範囲'],
    enrage: ['enrage', 'hard enrage', 'soft enrage', 'finale', '時間切れ'],
    adds: ['adds', 'add phase', 'ajouts', 'adds phase', '雑魚'],
    'dps-check': ['dps check', 'dps-check', 'dpsチェック'],
    'limit-cut': ['limit cut', 'リミットカット'],
    debuff: ['debuff', 'デバフ'],
    dodge: ['dodge', 'esquive', 'ausweichen', '回避'],
    transition: ['transition', 'phase change', 'フェーズ移行']
};
// Asking for a link / guide page, in all 4 languages
const LINK_WORDS = ['link', 'links', 'url', 'guide', 'guides', 'source', 'sources', 'website', 'site', 'page',
    'lien', 'liens', 'quelle', 'quellen', 'seite', 'webseite', 'リンク', 'url', 'ソース', 'サイト', '攻略サイト', '攻略ページ', 'ページ'];
let LINK_KEYS = null;
function wantsLinks(normText) {
    if (!LINK_KEYS) LINK_KEYS = LINK_WORDS.map(w => stemPhrase(clean(w))).filter(Boolean);
    const t = stemPhrase(normText);
    return LINK_KEYS.some(k => hasPhrase(t, k));
}
// Tool / data files listed as sources are not guides for players
const NOT_A_GUIDE = /raw\.githubusercontent\.com|xivapi\.com|github\.com|cactbot/i;
const LINKS_MAX = 4;

let TAG_KEYS = null; // [tag, phrase] built once (phrases cleaned like the message text)
function tagsIn(normText) {
    if (!TAG_KEYS) TAG_KEYS = Object.entries(TAG_WORDS).flatMap(([t, list]) => list.map(w => [t, stemPhrase(clean(w))]));
    const out = new Set();
    for (const [t, k] of TAG_KEYS) if (k && hasPhrase(normText, k)) out.add(t);
    return [...out];
}

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
        const n = stemPhrase(clean(x));
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
        keys: cleanList([...LANGS.map(l => s.name && s.name[l]), ...LANGS.flatMap(l => (s.aliases && Array.isArray(s.aliases[l]) ? s.aliases[l] : [])),
            String(s.id), String(s.id).replace(/[-_]/g, ' ')].filter(Boolean))
    }));
    const mechs = [];
    for (const ph of Array.isArray(data.phases) ? data.phases : []) {
        for (const m of (ph && Array.isArray(ph.mechanics)) ? ph.mechanics : []) {
            if (!m || !m.id) continue;
            const keys = {};
            const words = {};
            for (const l of LANGS) {
                // a name like "Infernal Nails / Hellfire" or "Snake form 1: Gorgomanteia" also matches each part
                const names = [m.names && m.names[l], ...((m.aliases && m.aliases[l]) || [])].filter(Boolean);
                const parts = [];
                for (const n of names) for (const part of String(n).split(/\s*[\/+(),;:\uff0f\uff08\uff09\u30fb]\s*/)) if (part && part.length >= 4) parts.push(part);
                keys[l] = cleanList(names);
                const partKeys = cleanList(parts).filter(k => !keys[l].includes(k));
                if (partKeys.length) (keys.parts = keys.parts || {})[l] = partKeys;
                words[l] = [...new Set([...keys[l], ...partKeys].filter(k => !CJK.test(k)).flatMap(k => k.split(' ')).filter(w => w.length >= 3 && !GENERIC.has(w) && !STOP.has(w)))];
            }
            const tags = (Array.isArray(m.tags) ? m.tags : []).map(t => String(t).toLowerCase()).filter(t => TAG_WORDS[t]);
            mechs.push({ id: String(m.id), phase: String(ph.id || ''), keys, words, tags });
        }
    }
    const nameWords = {};
    for (const l of LANGS) nameWords[l] = [...new Set((nameKeys[l] || []).filter(k => !CJK.test(k)).flatMap(k => k.split(' ')).filter(w => w.length >= 4 && !GENERIC.has(w)))];
    return { id: String(data.id), type: data.type || '', expansion: data.expansion || '', file, names: data.names || {}, nameKeys, nameWords, strats, mechs };
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

function searchFight(rawText, langs, contextFightId) {
    if (!fights.length || !rawText) return null;
    const normText = stemPhrase(rawText);
    const textWords = new Set(normText.split(' ').filter(w => w.length >= 3 && !STOP.has(w) && !GENERIC.has(w)));
    const results = [];
    for (const f of fights) {
        let fightScore = 0;
        for (const l of langs) {
            for (const k of f.nameKeys[l] || []) {
                if (!hasPhrase(normText, k)) continue;
                const sc = 6 + Math.min(k.length, 20) / 20; // longer names are more specific (極イフリート beats イフリート)
                if (sc > fightScore) fightScore = sc;
            }
        }
        let mech = null;
        let mechScore = 0;
        for (const m of f.mechs) {
            for (const l of langs) {
                for (const k of m.keys[l] || []) {
                    if (!hasPhrase(normText, k)) continue;
                    const sc = 5 + Math.min(k.length, 20) / 20;
                    if (sc > mechScore) { mechScore = sc; mech = m; }
                }
                // a part of a longer name counts a little less than a full name or alias
                for (const k of (m.keys.parts && m.keys.parts[l]) || []) {
                    if (!hasPhrase(normText, k)) continue;
                    const sc = 4.95 + Math.min(k.length, 20) / 20;
                    if (sc > mechScore) { mechScore = sc; mech = m; }
                }
            }
        }
        // The fight is named but no full mechanic name: the mechanic sharing the most words ("grand cross" -> Grand Cross Alpha)
        if (fightScore && !mech && textWords.size) {
            const fightWords = new Set(langs.flatMap(l => f.nameWords[l] || []));
            const query = [...textWords].filter(w => !fightWords.has(w));
            let bestHits = 0;
            for (const m of f.mechs) {
                const mw = new Set(langs.flatMap(l => m.words[l] || []));
                const hits = query.filter(w => mw.has(w)).length;
                if (hits > bestHits) { bestHits = hits; mech = m; }
            }
            if (mech) mechScore = 4 + Math.min(bestHits, 3) / 10;
        }
        // Only a mechanic matched: a fight word in the text breaks ties ("ifrit nails" -> Ifrit EX, not UWU)
        let bonus = 0;
        if (!fightScore && mech) {
            for (const l of langs) if ((f.nameWords[l] || []).some(w => textWords.has(w))) bonus = 1;
        }
        const total = fightScore + mechScore + bonus;
        if (total >= FIGHT_MIN) results.push({ id: f.id, score: total, fightScore, mechId: mech ? mech.id : null });
    }
    if (!results.length) return null;
    results.sort((a, b) => b.score - a.score);
    const best = results[0];
    const tied = results.filter(r => Math.abs(r.score - best.score) < 1e-9);
    if (tied.length > 1) {
        // the same name in several fights: the fight being talked about wins, else ask which fight
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
    let fight = searchFight(normText, langs, opts.contextFightId || null);
    // A kind of mechanic ("1st tank buster", "the towers") and no mechanic named: every mechanic of that kind, in fight order.
    // No fight named (or several): the fight the user is already talking about.
    const tags = tagsIn(stemPhrase(normText));
    if (tags.length && !(fight && fight.mechId)) {
        const ctxId = opts.contextFightId && fightById.has(opts.contextFightId) ? opts.contextFightId : null;
        if ((!fight || !fight.id) && ctxId) fight = { id: ctxId, mechId: null, score: 0, fromContext: true };
        const f = fight && fight.id ? fightById.get(fight.id) : null;
        if (f) {
            const ids = f.mechs.filter(m => m.tags.some(t => tags.includes(t))).map(m => m.id);
            fight = Object.assign({}, fight, { tags, tagMechIds: ids });
        }
    }
    // "Link?" / "guide?": the guide pages of the fight named, or of the fight the user is already talking about
    if (wantsLinks(normText)) {
        const ctxId = opts.contextFightId && fightById.has(opts.contextFightId) ? opts.contextFightId : null;
        if ((!fight || !fight.id) && ctxId) fight = { id: ctxId, mechId: null, score: 0, fromContext: true };
        if (fight && fight.id) fight = Object.assign({}, fight, { wantLinks: true });
    }
    let faqQuery = normText;
    const f = fight && fight.id ? fightById.get(fight.id) : null;
    if (f) {
        // A fight question: the fight's, mechanic's and strats' own words don't count for the FAQ ("top", "world", "pf")
        const m = fight.mechId ? f.mechs.find(x => x.id === fight.mechId) : null;
        const used = new Set();
        const addWords = list => (list || []).forEach(k => k.split(' ').forEach(w => used.add(w)));
        for (const l of LANGS) {
            addWords(f.nameKeys[l]);
            if (m) { addWords(m.keys[l]); addWords(m.keys.parts && m.keys.parts[l]); }
        }
        f.strats.forEach(st => addWords(st.keys));
        faqQuery = normText.split(' ').filter(w => !used.has(stem(w))).join(' ');
    }
    let faqHits = searchFaq(faqQuery, langs);
    // ...and a FAQ entry is only added when the message clearly asks about Pingway too (2+ keywords)
    if (fight) faqHits = faqHits.filter(x => x.score >= FAQ_WITH_FIGHT_MIN);
    return { faq: faqHits, fight };
}

// Which strat of this fight does the text name? Exactly one strat named = its id; none or several = null.
function matchStrat(text, fightId) {
    const f = fightById.get(fightId);
    if (!f || !f.strats.length) return null;
    const normText = stemPhrase(clean(text));
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

// How a strat resolves this mechanic (follows "same_as"): the strat entry, or null when this mechanic has none for it
function stratEntry(mech, stratId) {
    const list = Array.isArray(mech.strats) ? mech.strats : [];
    let entry = list.find(s => s && s.strat === stratId);
    const seen = new Set([stratId]);
    while (entry && !entry.how && entry.same_as && !seen.has(entry.same_as)) {
        seen.add(entry.same_as);
        const next = list.find(s => s && s.strat === entry.same_as);
        if (!next) break;
        // keep a "not certain" flag from any step of the chain
        entry = Object.assign({}, next, { uncertain: !!(entry.uncertain || next.uncertain), note: next.note || entry.note });
    }
    return entry && entry.how ? entry : null;
}

function stratHow(mech, stratId, lang) {
    const e = stratEntry(mech, stratId);
    return e ? pick(e.how, lang) : '';
}

function faqText(results, lang) {
    return results.map(({ entry }) => {
        const link = entry.link ? `\nLink: ${entry.link}` : '';
        return `Q: ${pick(entry.q, lang)}\nA: ${pick(entry.a, lang)}${link}`;
    }).join('\n\n');
}

const MECH_LIST_MAX = 1500; // fight-only question: the list of mechanic names stays this short (big fights)
const TAG_TEXT_MAX = 3000; // kind-of-mechanic question: the matching mechanics stay this short
const TAG_NAMES = { tankbuster: 'tank busters', tankswap: 'tank swaps', raidwide: 'raidwides', stack: 'stacks', spread: 'spreads', knockback: 'knockbacks',
    tower: 'towers', tether: 'tethers', proximity: 'proximity hits', gaze: 'gazes', cleave: 'cleaves', dodge: 'dodges', debuff: 'debuffs', adds: 'adds',
    enrage: 'enrages', 'dps-check': 'DPS checks', 'limit-cut': 'limit cuts', transition: 'transitions' };
const UNSURE = 'Tell the user the sources are not sure / they should check with their group; never state it as a fact.';

// Knowledge block for the AI about one fight: only the matched mechanic (+ the chosen strat), never the whole file.
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
    const overview = Array.isArray(data.strats_overview) ? data.strats_overview : [];
    const savedOk = stratId && stratsAll.some(s => s.id === stratId) ? stratId : null;
    const lines = [`FIGHT: ${pick(data.names, lang)} (${data.type || ''}, ${data.expansion || ''}) [fight id: ${data.id}]`];
    const stratList = overview.filter(s => s && s.id).map(s => {
        const region = s.region && s.region !== 'all' ? ` (${s.region})` : '';
        return `${pick(s.name, lang) || s.id}${region} [strat id: ${s.id}]`;
    }).join('; ');
    // Old content without strats: the fight's own note (e.g. "mostly cleared unsynced")
    if (!stratsAll.length && data.note) lines.push(`Fight note: ${pick(data.note, lang)}`);
    const found = match.mechId ? findMechanic(data, match.mechId) : null;
    let askStrat = false;

    if (match.wantLinks) {
        // Guide pages from the fight file only. The strat's own language first (JP strat -> Japanese guides), else the reply language.
        const st = overview.find(s => s && s.id === (savedOk || stratId));
        const first = st && /JP/i.test(String(st.region || '')) ? 'ja' : (lang === 'ja' ? 'ja' : 'en');
        const guides = (Array.isArray(data.sources) ? data.sources : [])
            .filter(x => x && typeof x.url === 'string' && /^https:\/\//.test(x.url) && !NOT_A_GUIDE.test(x.url));
        guides.sort((a, b) => (a.lang === first ? 0 : 1) - (b.lang === first ? 0 : 1));
        const list = guides.slice(0, LINKS_MAX).map(x => `${x.title || x.url} (${x.lang || '?'}): ${x.url}`);
        if (list.length) {
            lines.push(`Guide links for this fight (when they ask for a link, give ONLY links from this list, the ones that fit their strat/language; these come before any general reference links; never make up a link): ${list.join(' | ')}`);
        } else {
            lines.push('There are no guide links for this fight. Say you have no link for it; never make up a link.');
        }
        if (!found && !Array.isArray(match.tagMechIds)) {
            if (stratList) lines.push(`Strats for this fight: ${stratList}.`);
            if (savedOk) lines.push(`The user's group uses the strat: ${stratName(match.id, savedOk, lang)}.`);
            return { text: lines.join('\n'), askStrat: false };
        }
    }

    if (!found && Array.isArray(match.tagMechIds)) {
        // "who takes the 1st tank buster?": every mechanic of that kind, numbered in fight order, with the chosen strat's steps
        const kinds = (match.tags || []).map(t => TAG_NAMES[t] || t).join(', ');
        const chosen = savedOk || (stratsAll.length === 1 ? stratsAll[0].id : null);
        if (!match.tagMechIds.length) {
            lines.push(`The guide marks no ${kinds} for this fight. Say the guide has no info on that; do not answer from general knowledge.`);
            return { text: lines.join('\n'), askStrat: false };
        }
        if (chosen) lines.push(`The user's group uses the strat: ${stratName(match.id, chosen, lang)}. Explain ONLY this strat, never the other strats.`);
        lines.push(`The ${kinds} of this fight, in fight order (1 = first):`);
        let n = 0;
        let cut = false;
        for (const id of match.tagMechIds) {
            const hit = findMechanic(data, id);
            if (!hit) continue;
            let item = `${++n}. ${pick(hit.phase.names, lang)} - ${pick(hit.mech.names, lang)}: ${pick(hit.mech.how, lang)}`;
            if (hit.mech.uncertain) item += ` (not fully certain: ${pick(hit.mech.note, lang)})`;
            if (chosen) {
                const entry = stratEntry(hit.mech, chosen);
                item += entry ? ` | This strat: ${pick(entry.how, lang)}${entry.uncertain ? ` (not certain: ${pick(entry.note, lang) || 'single source'})` : ''}` : ' | This strat: the guide has no steps for this one.';
            }
            if (lines.join('\n').length + item.length > TAG_TEXT_MAX) { cut = true; break; }
            lines.push(item);
        }
        if (cut) lines.push('...more of them later in the fight (not listed).');
        if (!chosen && stratsAll.length > 1) {
            askStrat = true;
            lines.push(`Strats for this fight: ${stratList}.`);
            lines.push('The user has not told you their strat. Answer only what the list above says for every group (if anything), then ask which of these strats their group uses. Do NOT explain any strat now.');
        }
        lines.push('Who takes or does it is ONLY what the list above says. If it does not say (e.g. which tank), say the guide does not have that detail; never guess.');
        return { text: lines.join('\n'), askStrat };
    }

    if (found) {
        const { phase, mech } = found;
        lines.push(`MECHANIC: ${pick(phase.names, lang)} - ${pick(mech.names, lang)}`);
        if (mech.how) lines.push(`How it works: ${pick(mech.how, lang)}`);
        if (mech.uncertain) lines.push(`Note: this mechanic info is not fully certain. ${pick(mech.note, lang)} ${UNSURE}`.replace(/\s+/g, ' ').trim());
        else if (mech.note) lines.push(`Note: ${pick(mech.note, lang)}`);
        const chosen = savedOk || (stratsAll.length === 1 ? stratsAll[0].id : null);
        if (chosen) {
            const entry = stratEntry(mech, chosen);
            const ov = overview.find(s => s && s.id === chosen);
            lines.push(`The user's group uses the strat: ${stratName(match.id, chosen, lang)}.`);
            if (entry) {
                lines.push(`How this strat does it: ${pick(entry.how, lang)}`);
                if (entry.uncertain) lines.push(`Note: this strat info is not fully certain (single source). ${pick(entry.note, lang)} ${UNSURE}`.replace(/\s+/g, ' ').trim());
                else if (entry.note) lines.push(`Strat note: ${pick(entry.note, lang)}`);
            } else {
                if (ov && ov.note) lines.push(`Strat note: ${pick(ov.note, lang)}`);
                lines.push('The guide has no steps of this strat for this mechanic (only its name/note). Do NOT invent steps: explain how the mechanic works and say the guide has no details for this strat.');
            }
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
        let list = '';
        let cut = false;
        for (const ph of Array.isArray(data.phases) ? data.phases : []) {
            if (cut) break;
            const ms = ((ph && ph.mechanics) || []).map(m => pick(m.names, lang)).filter(Boolean);
            ms.forEach((name, i) => {
                if (cut) return;
                const part = i === 0 ? (list ? ' | ' : '') + `${pick(ph.names, lang) || ph.id}: ${name}` : ', ' + name;
                if (list.length + part.length > MECH_LIST_MAX) { cut = true; return; }
                list += part;
            });
        }
        if (list) lines.push('Mechanics: ' + list + (cut ? ' | ...and more' : ''));
        lines.push('Only the mechanic NAMES are given here, no details: do not explain any mechanic or say who does it. If they ask about one, ask which mechanic they mean.');
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
    faqText, fightText, stats, hasPhrase, LANG_NAMES, FIGHT_CACHE_MAX, FAQ_WITH_FIGHT_MIN
};
