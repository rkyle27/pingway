// Pingway Trivia word bank builder: fetches the XIVAPI v2 rows in en/fr/de/ja and makes the bank object that is saved
// as data/trivia_bank.json. Pure code (no fs, no axios, no Discord): the same file runs on the server (utils/trivia.js)
// and in the browser (misc/trivia-builder.html, made by tools/build-trivia-builder.js). The caller gives getJson(url)
// (with its own retries) and pause() (wait between pages).
// Bank: { builtAt, format, langs, pools, incomplete? } — pools = { easy: [{ id, word, category, hints, lore, i18n }], ... }

const W = require('./triviaWords');

const XIV = 'https://v2.xivapi.com/api';
const BANK_FORMAT = 4; // 2 = more hints per word, no word-count hint, First letter as { text, letter }; 3 = no "Nowheresville" starting city;
                       // 4 = ids and fr/de/ja names, clues and lore (entry.i18n)
const MIN_POOL = 15;
const OTHER_LANGS = W.LANGS.filter(l => l !== 'en');
// XIVAPI v2 language (English is the default, no parameter)
const langParam = lang => (lang && lang !== 'en' ? '&language=' + lang : '');

// The sheets fetched for one language, in order (label = shown in the progress)
const SHEETS = [
    ['classJobs', 'sheet', 'ClassJob', 'Name,Abbreviation,Role,ClassJobParent.Name,JobIndex,ClassJobCategory.Name,StartingTown.Name,StartingLevel,PrimaryStat,IsLimitedJob', 200, 'jobs'],
    ['territories', 'sheet', 'TerritoryType', 'PlaceName.Name,PlaceNameRegion.Name,PlaceNameZone.Name,ExVersion.Name,TerritoryIntendedUse', 200, 'zones'],
    ['content', 'sheet', 'ContentFinderCondition', 'Name,ContentType.Name,ClassJobLevelRequired,ClassJobLevelSync,ItemLevelRequired,ItemLevelSync,HighEndDuty,' +
        'LevelingRoulette,HighLevelRoulette,ExpertRoulette,TrialRoulette,AllianceRoulette,NormalRaidRoulette,MSQRoulette,' +
        'TerritoryType.PlaceName.Name,TerritoryType.PlaceNameRegion.Name,TerritoryType.ExVersion.Name', 200, 'duties'],
    ['contentLore', 'sheet', 'ContentFinderConditionTransient', 'Description', 200, 'duty texts'],
    ['mounts', 'sheet', 'Mount', 'Singular,ExtraSeats', 200, 'mounts'],
    ['mountLore', 'sheet', 'MountTransient', 'Description,DescriptionEnhanced,Tooltip', 200, 'mount texts'],
    ['minions', 'sheet', 'Companion', 'Singular,MinionRace.Name,Behavior.Name', 200, 'minions'],
    ['minionLore', 'sheet', 'CompanionTransient', 'Description,DescriptionEnhanced,Tooltip,SpecialActionName,MinionSkillType.Name,Attack,Defense,Speed', 200, 'minion texts'],
    ['actions', 'search', 'Action', 'Name,ClassJob.Name,ClassJobLevel,IsPvP,IsPlayerAction,ActionCategory.Name,ClassJobCategory.Name,' +
        'Cast100ms,Recast100ms,Range,EffectRange,MaxCharges,IsRoleAction,CanTargetHostile,CanTargetParty,CanTargetSelf,TargetArea', 40, 'actions'],
    ['items', 'sheet', 'Item', 'Name,Description,ItemSearchCategory.Name,LevelItem,ItemUICategory.Name,LevelEquip,ClassJobCategory.Name,Rarity,' +
        'GrandCompany.Name,ItemSeries.Name,MateriaSlotCount,DyeCount,StackSize,CanBeHq,IsUnique,IsCollectable', 200, 'items'],
    // Who crafts what (joined to the items in memory): English only, other languages use the English recipes with their own job names
    ['recipes', 'sheet', 'Recipe', 'ItemResult.Name,CraftType.Name,IsExpert', 200, 'recipes', 'en'],
    // Lore of actions: only the rows of the actions found above (ActionTransient has the same row_id)
    ['actionLore', 'sheet', 'ActionTransient', 'Description', 400, 'action texts']
];
const sheetsFor = lang => SHEETS.filter(s => !s[6] || s[6] === (lang || 'en'));
const TOTAL_STEPS = W.LANGS.reduce((n, l) => n + sheetsFor(l).length, 0);

// opts: { getJson(url) -> data, pause() -> Promise, onProgress?({ lang, label, step, steps, page, rows }) }
function fetcher(opts) {
    const pause = opts.pause || (() => Promise.resolve());
    const progress = opts.onProgress || (() => {});
    let step = 0;
    // Every row of a sheet, 500 at a time
    async function sheetRows(sheet, fields, maxPages, lang, info) {
        const out = [];
        let after = null;
        for (let page = 0; page < maxPages; page++) {
            const url = XIV + '/sheet/' + sheet + '?limit=500&fields=' + encodeURIComponent(fields) + (after !== null ? '&after=' + after : '') + langParam(lang);
            const data = await opts.getJson(url);
            const rows = (data && Array.isArray(data.rows)) ? data.rows : [];
            if (!rows.length) break;
            out.push(...rows);
            if (info) progress(Object.assign({}, info, { page: page + 1, rows: out.length }));
            after = rows[rows.length - 1].row_id;
            await pause();
        }
        return out;
    }
    // Every result of a search
    async function searchRows(sheet, query, fields, maxPages, lang, info) {
        const out = [];
        let url = XIV + '/search?sheets=' + sheet + '&query=' + encodeURIComponent(query) + '&fields=' + encodeURIComponent(fields) + '&limit=500' + langParam(lang);
        for (let page = 0; page < maxPages && url; page++) {
            const data = await opts.getJson(url);
            const rows = (data && Array.isArray(data.results)) ? data.results : [];
            out.push(...rows);
            if (info) progress(Object.assign({}, info, { page: page + 1, rows: out.length }));
            if (!rows.length || !data.next) break;
            url = XIV + '/search?cursor=' + encodeURIComponent(data.next) + '&limit=500' + langParam(lang);
            await pause();
        }
        return out;
    }
    // All the rows the bank needs, in one language
    async function fetchRaw(lang) {
        const raw = {};
        for (const [key, kind, sheet, fields, maxPages, label] of sheetsFor(lang)) {
            const info = { lang: lang || 'en', label, sheet, step: ++step, steps: TOTAL_STEPS, page: 0, rows: 0 };
            progress(info);
            if (kind === 'search') raw[key] = await searchRows(sheet, '+IsPlayerAction=true +IsPvP=false', fields, maxPages, lang, info);
            else raw[key] = await sheetRows(sheet, fields, maxPages, lang, info);
            if (key === 'actionLore') {
                const actionIds = new Set(raw.actions.map(r => Number(r.row_id)));
                raw.actionLore = raw.actionLore.filter(r => actionIds.has(Number(r.row_id)));
            }
        }
        return raw;
    }
    return { sheetRows, searchRows, fetchRaw };
}

// Builds the bank. opts as fetcher() plus: strict (a language that can't be fetched = error, else the bank is made
// without it and marked incomplete), warn(text) for problems, now() for builtAt.
// Returns { bank, complete: { easy: n, ... } (words that work in all languages), failed: [langs] }.
async function buildBankData(opts) {
    const warn = opts.warn || (() => {});
    const now = opts.now || Date.now;
    const f = fetcher(opts);
    const rawEn = await f.fetchRaw('en');
    const pools = W.buildPools(rawEn);
    const small = W.DIFFICULTIES.filter(d => pools[d.key].length < MIN_POOL).map(d => d.name);
    if (small.length) throw new Error('too few words for ' + small.join(', '));
    // fr/de/ja: the same rows in each language (one language at a time, to keep memory low)
    const byLang = {};
    const failed = [];
    for (const lang of OTHER_LANGS) {
        try {
            byLang[lang] = W.buildPools(await f.fetchRaw(lang), { lang, en: rawEn });
        } catch (err) {
            failed.push(lang);
            warn('⚠️ [TRIVIA] Word bank: could not fetch ' + lang + ' (' + err.message + ').');
        }
    }
    if (failed.length && opts.strict) throw new Error('languages missing: ' + failed.join(', '));
    W.mergeLangPools(pools, byLang);
    const complete = Object.fromEntries(W.DIFFICULTIES.map(d => [d.key, pools[d.key].filter(W.isComplete).length]));
    const thin = W.DIFFICULTIES.filter(d => !failed.length && complete[d.key] < MIN_POOL).map(d => d.name + ' ' + complete[d.key]);
    if (thin.length) warn('⚠️ [TRIVIA] Word bank: few words that work in all languages (' + thin.join(', ') + ').');
    const bank = { builtAt: now(), format: BANK_FORMAT, langs: ['en', ...Object.keys(byLang)], pools };
    if (failed.length) bank.incomplete = true;
    return { bank, complete, failed };
}

module.exports = { XIV, BANK_FORMAT, MIN_POOL, SHEETS, TOTAL_STEPS, fetcher, buildBankData };
