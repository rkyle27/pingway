// Bot languages (en, fr, de, ja): /pingway, the "reviews" console command, and sample texts in every language.
// Plain node, no Discord connection and no database:  node --test test/i18n-commands.test.js
// discord.js / the database are replaced with small stand-ins when they are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------- module stand-ins ----------
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}
function canLoad(name) { try { require.resolve(name); return true; } catch (e) { return false; } }
const shims = {};
if (!canLoad('discord.js')) {
    const chain = (rec = {}) => new Proxy(rec, {
        get(o, k) {
            if (k === 'toJSON') return () => ({ ...o });
            if (k in o) return o[k];
            return (...args) => {
                if (k === 'setName') o.name = args[0];
                if (k === 'setDescription') o.description = args[0];
                if (k === 'setDescriptionLocalizations') o.description_localizations = args[0];
                if (k === 'addSubcommand') { const sub = chain({}); args[0](sub); (o.options = o.options || []).push(sub.toJSON()); return chain(o); }
                for (const a of args) if (typeof a === 'function') a(chain({}));
                return chain(o);
            };
        }
    });
    // Builders that remember what was set (enough to read texts back)
    class Recorder {
        constructor() { this.data = {}; }
        setTitle(v) { this.data.title = v; return this; }
        setDescription(v) { this.data.description = v; return this; }
        setColor(v) { this.data.color = v; return this; }
        setFooter(v) { this.data.footer = v; return this; }
        setLabel(v) { this.data.label = v; return this; }
        setStyle(v) { this.data.style = v; return this; }
        setEmoji(v) { this.data.emoji = v; return this; }
        setURL(v) { this.data.url = v; return this; }
        setCustomId(v) { this.data.custom_id = v; return this; }
        setTimestamp() { return this; }
        addFields(...f) { this.data.fields = (this.data.fields || []).concat(f.flat()); return this; }
        addComponents(...c) { this.components = (this.components || []).concat(c.flat()); return this; }
    }
    shims['discord.js'] = {
        MessageFlags: { Ephemeral: 64 },
        ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
        PermissionFlagsBits: { Administrator: 1n << 3n },
        SlashCommandBuilder: function () { return chain({}); },
        EmbedBuilder: Recorder, ButtonBuilder: Recorder, ActionRowBuilder: Recorder
    };
}
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (shims[request]) return 'shim:' + request;
    return orig.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);

// Fake database: user_language table + whatever a test puts in db.extra
const db = { langs: new Map(), queries: [], extra: null };
const pool = {
    async execute(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        db.queries.push({ q, params });
        if (/^CREATE TABLE IF NOT EXISTS user_language/.test(q)) return [[]];
        if (/^SELECT lang, discord_locale FROM user_language WHERE user_id = \?/.test(q)) {
            const r = db.langs.get(params[0]);
            return [r ? [{ ...r }] : []];
        }
        if (/^INSERT INTO user_language \(user_id, lang, updated_at\)/.test(q)) {
            const r = db.langs.get(params[0]) || { lang: null, discord_locale: null };
            r.lang = params[1];
            db.langs.set(params[0], r);
            return [{ affectedRows: 1 }];
        }
        if (/^INSERT INTO user_language \(user_id, discord_locale, updated_at\)/.test(q)) {
            const r = db.langs.get(params[0]) || { lang: null, discord_locale: null };
            r.discord_locale = params[1];
            db.langs.set(params[0], r);
            return [{ affectedRows: 1 }];
        }
        if (db.extra) return db.extra(q, params);
        throw new Error('Fake pool: unexpected SQL: ' + q);
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });
inject(path.join(ROOT, 'utils', 'membership.js'), { ownerHasMembership: async () => true, sponsorHasPerks: async () => true, findPerksAdmin: async () => null });

const i18n = require('../utils/i18n');
const { t } = i18n;
const userLanguage = require('../utils/userLanguage');

// Every English key ("ns.path"), to make sure no raw key ever reaches people
const LOCALES = path.join(ROOT, 'locales');
function flatKeys(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix + '.' + k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatKeys(v, key, out); else out.push(key);
    }
    return out;
}
const ALL_KEYS = fs.readdirSync(path.join(LOCALES, 'en')).filter(f => f.endsWith('.json'))
    .flatMap(f => flatKeys(JSON.parse(fs.readFileSync(path.join(LOCALES, 'en', f), 'utf8')), f.replace(/\.json$/, ''), []))
    .filter(k => !k.startsWith('trivia.')); // Trivia texts belong to the Trivia feature
const noRawKeys = (value, label) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const k of ALL_KEYS) assert.ok(!text.includes(k), label + ': raw key "' + k + '" in the output');
};

// ---------- /pingway ----------
function fakeInteraction({ sub, locale = 'en-US', userId = 'u1' }) {
    const out = { deferred: null, edits: [] };
    return {
        out,
        user: { id: userId }, locale, guildId: 'g1',
        options: { getSubcommand: () => sub },
        deferReply: async o => { out.deferred = o; },
        editReply: async o => { out.edits.push(o); return o; },
        reply: async o => { out.edits.push(o); return o; }
    };
}

test('/pingway has en, fr, de, jp and auto, with localized descriptions', () => {
    const cmd = require('../commands/pingway');
    assert.deepEqual(Object.keys(cmd.CHOICES), ['en', 'fr', 'de', 'jp', 'auto']);
    assert.equal(cmd.CHOICES.jp, 'ja', 'Japanese is "jp" for people, "ja" inside Pingway');
    assert.equal(cmd.CHOICES.auto, null);
    const loc = i18n.discordLocalizations('pingway.cmd.description');
    assert.deepEqual(Object.keys(loc).sort(), ['de', 'fr', 'ja']);
});

for (const [sub, saved, replyLang] of [['en', 'en', 'en'], ['fr', 'fr', 'fr'], ['de', 'de', 'de'], ['jp', 'ja', 'ja']]) {
    test('/pingway ' + sub + ' saves "' + saved + '" and replies in that language (ephemeral)', async () => {
        userLanguage.clearCache();
        db.langs.clear();
        const cmd = require('../commands/pingway');
        const i = fakeInteraction({ sub, locale: 'en-US', userId: 'user-' + sub });
        await cmd.execute(i);
        assert.equal(db.langs.get('user-' + sub).lang, saved);
        assert.deepEqual(i.out.deferred, { flags: [64] });
        const content = i.out.edits[0].content;
        assert.equal(content, t(replyLang, 'pingway.saved', { language: t(replyLang, 'pingway.names.' + replyLang) }) + '\n' + t(replyLang, 'pingway.website'));
        assert.match(content, /pingway\.app/);
        noRawKeys(content, '/pingway ' + sub);
        assert.equal(await userLanguage.forUser('user-' + sub), saved, 'DMs use the choice');
        assert.equal(await userLanguage.forInteraction({ user: { id: 'user-' + sub }, locale: 'en-US' }), saved);
    });
}

test('/pingway auto clears the choice and replies in the Discord app language', async () => {
    userLanguage.clearCache();
    db.langs.clear();
    db.langs.set('user-auto', { lang: 'de', discord_locale: null });
    const cmd = require('../commands/pingway');
    const i = fakeInteraction({ sub: 'auto', locale: 'ja', userId: 'user-auto' });
    await cmd.execute(i);
    assert.equal(db.langs.get('user-auto').lang, null);
    assert.equal(i.out.edits[0].content, t('ja', 'pingway.savedAuto', { language: '日本語' }) + '\n' + t('ja', 'pingway.website'));
    userLanguage.clearCache();
    assert.equal(await userLanguage.forInteraction({ user: { id: 'user-auto' }, locale: 'fr' }), 'fr', 'auto = Discord app language');
});

test('/pingway with a broken database says so instead of crashing', async () => {
    userLanguage.clearCache();
    const cmd = require('../commands/pingway');
    const saved = pool.execute;
    pool.execute = async () => { throw new Error('db down'); };
    try {
        const i = fakeInteraction({ sub: 'fr', locale: 'fr', userId: 'user-x' });
        await cmd.execute(i);
        assert.equal(i.out.edits[0].content, t('fr', 'pingway.saveFailed'));
    } finally {
        pool.execute = saved;
    }
});

// ---------- console: reviews ----------
function reviewsPool(rows, { missing = false } = {}) {
    const calls = [];
    return {
        calls,
        async execute(sql) {
            calls.push(sql);
            if (missing) { const e = new Error("Table 'reviews' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
            if (/COUNT\(\*\)/.test(sql)) {
                const avg = rows.length ? rows.reduce((a, r) => a + r.stars, 0) / rows.length : null;
                return [[{ n: rows.length, avg }]];
            }
            const limit = Number((sql.match(/LIMIT (\d+)/) || [])[1]);
            const offset = Number((sql.match(/OFFSET (\d+)/) || [])[1] || 0);
            const sorted = rows.slice().sort((a, b) => b.created_at - a.created_at || b.id - a.id);
            // the console must never ask for user_id
            assert.ok(!/user_id/.test(sql), 'user_id is never read');
            return [sorted.slice(offset, offset + limit).map(r => { const { user_id, ...rest } = r; return rest; })];
        }
    };
}
const sampleReviews = n => Array.from({ length: n }, (_, k) => ({
    id: k + 1, user_id: '99999999999999999' + k, stars: (k % 5) + 1, text: 'Great bot number ' + (k + 1) + '\nnew line',
    name: k % 3 === 0 ? 'Riv' : '', name_random: k % 3 === 1 ? 1 : 0, lang: ['en', 'fr', 'de', 'ja'][k % 4], approved: k % 7 === 0 ? 0 : 1,
    created_at: Date.UTC(2026, 10, 1) + k * 3600 * 1000
}));

test('reviews: count, average stars and the latest 10; never prints user_id', async () => {
    const { reviewsConsole } = require('../utils/reviewsConsole');
    const rows = sampleReviews(12);
    const p = reviewsPool(rows);
    const lines = [];
    await reviewsConsole([], { pool: p, log: s => lines.push(s) });
    const out = lines.join('\n');
    const avg = rows.reduce((a, r) => a + r.stars, 0) / rows.length;
    assert.match(out, new RegExp('12 review\\(s\\) \\| average ' + avg.toFixed(2).replace('.', '\\.') + ' / 5'));
    assert.equal((out.match(/^ {2}#\d+ \|/gm) || []).length, 10, 'latest 10');
    assert.match(out, /#12 \| 2026-11-01 11:00 UTC \| ★★☆☆☆ \|/);
    assert.match(out, /Type "reviews all" to see all 12/);
    assert.match(out, /\[not approved\]/);
    assert.match(out, /\(random name\)/);
    assert.match(out, /Great bot number 12 new line/, 'text on one line');
    for (const r of rows) assert.ok(!out.includes(r.user_id), 'no user id in the output');
});

test('reviews all: every review, read 20 at a time', async () => {
    const { reviewsConsole } = require('../utils/reviewsConsole');
    const rows = sampleReviews(45);
    const p = reviewsPool(rows);
    const lines = [];
    await reviewsConsole(['all'], { pool: p, log: s => lines.push(s) });
    const out = lines.join('\n');
    assert.equal((out.match(/^ {2}#\d+ \|/gm) || []).length, 45);
    assert.match(out, /-- 1-20 of 45 --/);
    assert.match(out, /-- 21-40 of 45 --/);
    assert.match(out, /-- 41-45 of 45 --/);
    assert.equal(p.calls.filter(s => /LIMIT 20 OFFSET/.test(s)).length, 3);
    for (const r of rows) assert.ok(!out.includes(r.user_id));
});

test('reviews: no table yet / no reviews / stars drawing', async () => {
    const { reviewsConsole, stars } = require('../utils/reviewsConsole');
    let lines = [];
    await reviewsConsole([], { pool: reviewsPool([], { missing: true }), log: s => lines.push(s) });
    assert.match(lines.join('\n'), /reviews table does not exist yet/);
    lines = [];
    await reviewsConsole([], { pool: reviewsPool([]), log: s => lines.push(s) });
    assert.match(lines.join('\n'), /0 review\(s\)/);
    assert.equal(stars(4), '★★★★☆');
    assert.equal(stars(0), '☆☆☆☆☆');
    assert.equal(stars(9), '★★★★★');
});

test('mybot.js: one reviews console branch, listed in the startup help line and CONSOLE_COMMANDS.txt', () => {
    const src = fs.readFileSync(path.join(ROOT, 'mybot.js'), 'utf8');
    assert.equal((src.match(/input === 'reviews' \|\| input\.startsWith\('reviews '\)/g) || []).length, 1);
    assert.match(src, /"reviews" \/ "reviews all"/);
    const doc = fs.readFileSync(path.join(ROOT, 'CONSOLE_COMMANDS.txt'), 'utf8');
    assert.ok(doc.includes('reviews all'));
});

// ---------- texts in every language ----------
test('every t(..., "key") written in the code exists in locales/en', () => {
    const files = [];
    const walkDir = d => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            if (f.name === 'node_modules' || f.name === 'test' || f.name.startsWith('.')) continue;
            const p = path.join(d, f.name);
            if (f.isDirectory()) walkDir(p); else if (f.name.endsWith('.js') && !/trivia/i.test(f.name)) files.push(p);
        }
    };
    walkDir(ROOT);
    const missing = [];
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        const re = /\b(?:t|tOr)\(\s*[\w.()' ]+?,\s*'([a-zA-Z]+\.[\w.-]+)'\s*[,)]|discordLocalizations\(\s*'([a-zA-Z]+\.[\w.-]+)'\s*\)/g;
        let m;
        while ((m = re.exec(src))) {
            const key = m[1] || m[2];
            if (key.startsWith('trivia.')) continue;
            const ns = key.slice(0, key.indexOf('.'));
            if (!fs.existsSync(path.join(LOCALES, 'en', ns + '.json'))) { missing.push(path.relative(ROOT, f) + ': ' + key); continue; }
            const v = t('en', key);
            if (v === key) missing.push(path.relative(ROOT, f) + ': ' + key);
        }
    }
    assert.deepEqual(missing, []);
});

test('help in ja / fr / de: every field translated, /pingway listed, no raw keys', () => {
    const { buildHelpPayload } = require('../utils/helpContent');
    const en = buildHelpPayload('en');
    assert.equal(en.embeds[0].data.title, '📖 Pingway Commands Guide');
    assert.ok(en.embeds[0].data.fields.some(f => f.value.includes('**/pingway**')));
    for (const lang of ['ja', 'fr', 'de']) {
        const p = buildHelpPayload(lang);
        noRawKeys(p.embeds[0].data, 'help ' + lang);
        assert.notEqual(p.embeds[0].data.title, en.embeds[0].data.title, lang + ' title is translated');
        assert.equal(p.embeds[0].data.fields.length, en.embeds[0].data.fields.length);
        assert.ok(p.embeds[0].data.fields.some(f => f.value.includes('/pingway')));
        assert.ok(p.embeds[0].data.description.includes('https://pingway.app'));
    }
    assert.match(buildHelpPayload('ja').embeds[0].data.title, /コマンド/);
});

test('vote thank-you DM: English is unchanged, other languages are translated', () => {
    const { buildMessage } = require('../utils/voteRewards');
    const en = buildMessage(2, 1234, 'v1:abc', 'en');
    assert.equal(en.embeds[0].data.title, '💜 Thanks for voting for Pingway!');
    assert.equal(en.embeds[0].data.description,
        'You got **+2 points** for voting on **top.gg** (weekend double vote!).\n' +
        'Your balance: **1,234 points**\n\n' +
        '• 1 point = 1 extra Retainer Watch retainer for a month\n' +
        '• 10 points = Supporter Perks for a month\n\n' +
        'You can vote again on top.gg in 12 hours. Manage your points on the [Pingway website](https://pingway.app).');
    assert.equal(buildMessage(1, 1, 'nothing', 'en').embeds[0].data.description.split('\n')[0], 'You got **+1 point**.');
    for (const lang of ['ja', 'fr', 'de']) {
        const p = buildMessage(1, 1234, 'dbl:1:2', lang);
        noRawKeys(p, 'votes ' + lang);
        assert.notEqual(p.embeds[0].data.title, en.embeds[0].data.title);
        assert.ok(p.embeds[0].data.description.includes('discordbotlist.com'));
    }
    assert.match(buildMessage(1, 1234, 'v1:x', 'de').embeds[0].data.description, /1\.234/, 'numbers in the language format');
});

test('/vc panel in ja / fr / de: translated, no raw keys; English unchanged', () => {
    const panel = require('../utils/voice/panel');
    const base = {
        status: { channelId: 'vc1', nowPlaying: { title: 'Lofi', live: true, paused: true }, speaking: true, musicQueue: 2, ttsQueue: 1 },
        voiceReady: true, ttsEnabled: true, ttsEngine: { mode: 'backup', reason: 'call' }, voiceName: 'en-US-Standard-C', voiceIsDefault: true,
        selectedLang: 'ja-JP', available: null, radioResults: [{ uuid: 'x', name: '', country: 'JP' }], moveOffer: 'vc2', djRoleId: 'r1', notice: null
    };
    const en = panel.buildPanel(base);
    assert.match(en.embeds[0].description, /\*\*Queue:\*\* 2 tracks · 1 message to read · 🗣️ speaking/);
    assert.match(en.embeds[0].description, /\*\*Now playing:\*\* 📻 Lofi \(paused\)/);
    assert.equal(en.embeds[0].title, '🔊 Pingway Voice');
    for (const lang of ['ja', 'fr', 'de']) {
        const p = panel.buildPanel({ ...base, lang });
        noRawKeys(p, 'panel ' + lang);
        assert.notEqual(p.embeds[0].description, en.embeds[0].description);
        assert.notEqual(p.components[0].components[0].label, 'Join');
        noRawKeys(panel.buildPlayModal(lang), 'modal ' + lang);
    }
    assert.match(panel.buildPanel({ ...base, lang: 'ja' }).components[2].components[0].options.find(o => o.value === 'ja-JP').label, /日本語/);
});

test('voice chat speech words follow the server language; English unchanged', () => {
    const { cleanText, withSpeaker } = require('../utils/voice/textClean');
    assert.equal(cleanText('look https://example.com now'), 'look a link now');
    assert.equal(cleanText('look https://example.com now', {}, 200, 'fr'), 'look un lien now');
    const last = new Map();
    assert.equal(withSpeaker('hi', { guildId: 'g', userId: 'a', displayName: 'Ana', now: 0, lastSpeaker: last }), 'Ana says: hi');
    assert.equal(withSpeaker('hi', { guildId: 'g2', userId: 'a', displayName: 'Ana', now: 0, lastSpeaker: last, lang: 'ja' }), 'Anaさん：hi');
    assert.equal(withSpeaker('', { guildId: 'g3', userId: 'a', displayName: 'Ana', now: 0, lastSpeaker: last, lang: 'de', fileOnly: true }), 'Ana hat eine Datei geschickt');
});

test('locale helpers: language codes, number formats and fallbacks', () => {
    assert.equal(i18n.fromDiscordLocale('ja'), 'ja');
    assert.equal(i18n.fromDiscordLocale('en-GB'), 'en');
    assert.equal(i18n.fromDiscordLocale('es-ES'), null);
    assert.equal(i18n.localeOf('de'), 'de-DE');
    assert.equal(i18n.localeOf('xx'), 'en-US');
    assert.equal(i18n.tOr('fr', 'jobs.Paladin', 'Paladin'), 'Paladin');
    assert.equal(i18n.tOr('ja', 'jobs.Dark Knight', 'Dark Knight'), '暗黒騎士');
    assert.equal(i18n.tOr('de', 'jobs.Unknown Job', 'Unknown Job'), 'Unknown Job');
    assert.equal(t('fr', 'core.commandNotFound', { commandName: 'abc' }), '❌ Commande `/abc` introuvable.');
    assert.equal(t('xx', 'core.commandNotFound', { commandName: 'abc' }), '❌ Command `/abc` not found.', 'unknown language -> English');
});

test('a public server message follows the server language', () => {
    assert.equal(userLanguage.forGuild({ preferredLocale: 'fr' }), 'fr');
    assert.equal(userLanguage.forGuild({ preferredLocale: 'ko' }), 'en');
    assert.equal(userLanguage.forGuild(null), 'en');
});
