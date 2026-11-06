// Pingway translations (bot side).
// Languages: en (English), fr (Français), de (Deutsch), ja (日本語). The /pingway command shows Japanese as "jp".
// Texts live in locales/<lang>/<namespace>.json (one file per feature, e.g. locales/fr/vc.json).
// Use: const { t } = require('./i18n');  t(lang, 'vc.joined', { channel: '#general' })
//   - key = '<namespace>.<path.inside.the.file>'
//   - {name} placeholders are filled from vars
//   - missing text in a language falls back to English, then to the key itself (never throws)
const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'fr', 'de', 'ja'];
const DEFAULT_LANG = 'en';
const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const cache = new Map(); // 'lang/ns' -> object | null

function isLang(v) { return LANGS.includes(v); }

// Discord locale (interaction.locale / guild.preferredLocale) -> one of our languages
function fromDiscordLocale(locale) {
    const l = String(locale || '').toLowerCase();
    if (l.startsWith('en')) return 'en';
    if (l.startsWith('fr')) return 'fr';
    if (l.startsWith('de')) return 'de';
    if (l.startsWith('ja')) return 'ja';
    return null; // not one of ours
}

function load(lang, ns) {
    const key = lang + '/' + ns;
    if (cache.has(key)) return cache.get(key);
    let data = null;
    try {
        data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang, ns + '.json'), 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.error('⚠️ [I18N] Could not read locales/' + key + '.json: ' + e.message);
    }
    cache.set(key, data);
    return data;
}

function lookup(lang, key) {
    const dot = key.indexOf('.');
    if (dot < 1) return undefined;
    const ns = key.slice(0, dot);
    let cur = load(lang, ns);
    for (const part of key.slice(dot + 1).split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[part];
    }
    return cur;
}

function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null ? String(vars[name]) : m));
}

// Translate. Arrays/objects are returned as they are (e.g. a list of lines); strings get {vars} filled.
function t(lang, key, vars) {
    const l = isLang(lang) ? lang : DEFAULT_LANG;
    let v = lookup(l, key);
    if (v === undefined && l !== DEFAULT_LANG) v = lookup(DEFAULT_LANG, key);
    if (v === undefined) return key;
    if (typeof v === 'string') return fill(v, vars);
    if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? fill(x, vars) : x));
    return v;
}

// Like t(), but returns fallback when the text does not exist (e.g. a job or item name that has no translation)
function tOr(lang, key, fallback, vars) {
    const v = t(lang, key, vars);
    return v === key ? fallback : v;
}

// Same key in all 4 languages, for Discord command localizations ({ fr: '...', de: '...', ja: '...' }).
// Only languages that really have the text are included (Discord rejects empty strings).
const DISCORD_CODES = { fr: 'fr', de: 'de', ja: 'ja' };
function discordLocalizations(key) {
    const out = {};
    for (const [lang, code] of Object.entries(DISCORD_CODES)) {
        const v = lookup(lang, key);
        if (typeof v === 'string' && v.trim()) out[code] = v;
    }
    return out;
}

function clearCache() { cache.clear(); }

// Locale for numbers and dates written as text (toLocaleString / toLocaleDateString)
const LOCALES = { en: 'en-US', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP' };
function localeOf(lang) { return LOCALES[isLang(lang) ? lang : DEFAULT_LANG]; }

module.exports = { LANGS, DEFAULT_LANG, isLang, fromDiscordLocale, t, tOr, discordLocalizations, clearCache, localeOf };
