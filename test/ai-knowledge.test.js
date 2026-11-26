// AI channel: keyword clean-up, local knowledge search (FAQ + fights), slim prompt, strat flow, memory.
// Plain node, no Discord, no database, no network:  node --test test/ai-knowledge.test.js
// The OpenRouter call (openai package), the database (utils/db.js), maintenance and honeypot are fakes.
// Knowledge comes from the small fixture files in test/fixtures/ai (never the real research files).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'ai');
const BOT = '1530586586524418048';
const AI_CHANNEL = 'chan-ai';

// ---------- module fakes ----------
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}

const ai = { calls: [], next: 'Sure!' };
class FakeOpenAI {
    constructor() {
        this.chat = { completions: { create: async (req) => {
            ai.calls.push(req);
            const text = typeof ai.next === 'function' ? ai.next(req.messages) : ai.next;
            return { choices: [{ message: { content: text } }] };
        } } };
    }
}
const shims = { openai: FakeOpenAI, 'discord.js': { EmbedBuilder: class {} } };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (shims[request]) return 'shim:' + request;
    return origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);

// Fake database: reminders, facts, time zones, languages
const db = { reminders: [], facts: new Map(), tz: new Map(), lang: new Map(), aiChannels: new Set([AI_CHANNEL]) };
const userFacts = (u) => { if (!db.facts.has(u)) db.facts.set(u, new Map()); return db.facts.get(u); };
const pool = {
    async execute(sql, params = []) {
        if (/FROM ai_active_channels/.test(sql)) return [db.aiChannels.has(params[1]) ? [{ channel_id: params[1] }] : []];
        if (/^\s*INSERT INTO reminders/.test(sql)) {
            const [guild_id, channel_id, user_id, reminder_text, target_timestamp] = params;
            db.reminders.push({ guild_id, channel_id, user_id, reminder_text, target_timestamp });
            return [{ insertId: db.reminders.length }];
        }
        if (/FROM reminders WHERE user_id/.test(sql)) {
            return [db.reminders.filter(r => r.user_id === params[0]).map((r, i) => ({ id: i + 1, reminder_text: r.reminder_text, target_timestamp: r.target_timestamp, is_recurring: 0 }))];
        }
        if (/SELECT fact_key, fact_value FROM user_facts WHERE user_id = \? AND fact_key LIKE 'task_%'/.test(sql)) {
            return [[...userFacts(params[0])].filter(([k]) => k.startsWith('task_')).map(([fact_key, fact_value]) => ({ fact_key, fact_value }))];
        }
        if (/SELECT fact_key, fact_value FROM user_facts WHERE user_id = \?/.test(sql)) {
            return [[...userFacts(params[0])].map(([fact_key, fact_value]) => ({ fact_key, fact_value }))];
        }
        if (/^\s*INSERT INTO user_facts/.test(sql)) {
            const [u, k, v] = params;
            if (/CONCAT/.test(sql) && userFacts(u).has(k)) userFacts(u).set(k, userFacts(u).get(k) + ' ' + v);
            else userFacts(u).set(k, v);
            return [{}];
        }
        if (/^\s*DELETE FROM user_facts/.test(sql)) { userFacts(params[0]).delete(params[1]); return [{}]; }
        if (/SELECT tz FROM user_timezone/.test(sql)) return [db.tz.has(params[0]) ? [{ tz: db.tz.get(params[0]) }] : []];
        if (/INSERT INTO user_timezone/.test(sql)) { db.tz.set(params[0], params[1]); return [{}]; }
        if (/SELECT lang, discord_locale FROM user_language/.test(sql)) return [db.lang.has(params[0]) ? [{ lang: db.lang.get(params[0]), discord_locale: null }] : []];
        return [[]];
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });
inject(path.join(ROOT, 'maintenance.js'), { isMaintenance: () => false });
inject(path.join(ROOT, 'utils', 'honeypot.js'), { isTrap: () => false, handle: async () => {} });
inject(path.join(ROOT, 'utils', 'helpContent.js'), { buildHelpPayload: () => ({ embeds: [] }), WEBSITE_URL: 'https://example.invalid' });

const { t } = require(path.join(ROOT, 'utils', 'i18n'));
const { normalize } = require(path.join(ROOT, 'utils', 'normalizeText'));
const aiKnowledge = require(path.join(ROOT, 'utils', 'aiKnowledge'));
const messageCreate = require(path.join(ROOT, 'events', 'messageCreate'));
const { buildFaq } = require(path.join(ROOT, 'tools', 'build-ai-faq'));

// ---------- fake Discord message ----------
class Coll extends Map { find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; } }
let seq = 0;
const newUser = () => 'kuser' + (++seq);
function makeMsg(content, userId) {
    const replies = [];
    const msg = {
        content,
        author: { id: userId, bot: false, displayName: 'Tester' },
        guild: { id: 'g1', members: { me: { roles: { botRole: null } } } },
        guildId: 'g1',
        channelId: AI_CHANNEL,
        client: { user: { id: BOT } },
        mentions: { roles: new Coll() },
        channel: { sendTyping: async () => {}, send: async (x) => replies.push(typeof x === 'string' ? x : x.content) },
        reply: async (x) => { replies.push(typeof x === 'string' ? x : x.content); }
    };
    return { msg, replies };
}
async function say(content, userId) {
    const { msg, replies } = makeMsg(content, userId);
    await messageCreate.execute(msg);
    return replies;
}
const systemText = () => ai.calls.at(-1).messages[0].content;

test.beforeEach(() => {
    ai.calls.length = 0;
    ai.next = 'Sure!';
    db.reminders.length = 0;
    aiKnowledge.init(FIX);
});

// ---------- 1. normalize ----------
test('normalize: period, caps, spaces, mentions, Japanese punctuation, full-width, emoji', () => {
    const want = 'release recollection';
    for (const s of [
        'Release recollection.', 'RELEASE   recollection!!', '@Pingway release recollection', `<@${BOT}> release recollection`,
        '<@&123> release recollection', '「release recollection」。', 'release、recollection！？', 'ｒｅｌｅａｓｅ　ｒｅｃｏｌｌｅｃｔｉｏｎ',
        '"release recollection"', "'Release Recollection'", '✨ release recollection 🎉', 'release recollection <:pw:12345>'
    ]) assert.equal(normalize(s), want, s);
    assert.equal(normalize('絶オメガ、ループ？'), '絶オメガ ループ');
    assert.equal(normalize(''), '');
    assert.equal(normalize(null), '');
});

// ---------- 2. keyword commands (no AI call) ----------
test('release recollection works with punctuation, caps, spaces, mentions, JP punctuation and full-width', async () => {
    for (const s of ['Release recollection.', 'RELEASE   recollection!!', '@Pingway release recollection', `<@${BOT}> release recollection`,
        '「release recollection」。', 'ｒｅｌｅａｓｅ　ｒｅｃｏｌｌｅｃｔｉｏｎ！']) {
        const replies = await say(s, newUser());
        assert.deepEqual(replies, [t('en', 'ai.recollection')], s);
    }
    assert.equal(ai.calls.length, 0);
});

test('other keyword commands keep their replies and need no AI', async () => {
    const cases = [
        ['Invite link?', 'ai.invite'], ['Can you ADD THE BOT to my server!!', 'ai.invite'],
        ['support link.', 'ai.support'], ['Help server?!', 'ai.support'],
        ['How can I SUPPORT DEV?', 'ai.donate'], ['donate dev!', 'ai.donate'], ['support developers', 'ai.donate'],
        ['Are you a bot?', 'ai.areYouBot'], ['are you AI??', 'ai.areYouBot'],
        ['Write a script for me.', 'ai.noCode'], ['FULL CODE please', 'ai.noCode']
    ];
    for (const [s, key] of cases) {
        const replies = await say(s, newUser());
        assert.deepEqual(replies, [t('en', key)], s);
    }
    for (const s of ['Help!', 'HELP.', 'what can you do?', '「help」', 'ｈｅｌｐ']) {
        const replies = await say(s, newUser());
        assert.deepEqual(replies, [t('en', 'ai.helpIntro')], s);
    }
    assert.equal(ai.calls.length, 0);
    // a normal sentence that only contains a help word still goes to the AI (exact match, as before)
    await say('can you help me with my glamour', newUser());
    assert.equal(ai.calls.length, 1);
});

// ---------- 3. local search ----------
test('search: right FAQ entry in each language', () => {
    const cases = [['How do I add a retainer?', 'en', 'f15'], ['Comment ajouter un servant ?', 'fr', 'f15'],
        ['Wie füge ich einen Gehilfen hinzu?', 'de', 'f15'], ['リテイナーを追加するには？', 'ja', 'f15'],
        ['can I get a refund', 'en', 'f25'], ['Puis-je avoir un remboursement ?', 'fr', 'f25']];
    for (const [q, l, id] of cases) {
        const r = aiKnowledge.search(q, { userLang: l });
        assert.ok(r.faq.length >= 1, q);
        assert.equal(r.faq[0].entry.id, id, q);
    }
    assert.deepEqual(aiKnowledge.search('hi', { userLang: 'en' }).faq, []);
    assert.equal(aiKnowledge.search('hi', { userLang: 'en' }).fight, null);
});

test('search: right fight and mechanic in each language (user language + English)', () => {
    const cases = [
        ['how does program loop work in TOP?', 'en', 'top', 'program-loop'],
        ['comment marche la boucle de programme ?', 'fr', 'top', 'program-loop'],
        ['Wie funktioniert die Programmschleife?', 'de', 'top', 'program-loop'],
        ['絶オメガのサークルプログラムは？', 'ja', 'top', 'program-loop'],
        ['パントってどうやるの', 'ja', 'top', 'pantokrator'],
        ['panto in omega ultimate', 'fr', 'top', 'pantokrator'],           // English names still work for a French user
        ['sanctity in dsr', 'en', 'dsr', 'sanctity'],
        ['tips for dragonsong', 'en', 'dsr', null]
    ];
    for (const [q, l, fight, mech] of cases) {
        const r = aiKnowledge.search(q, { userLang: l });
        assert.ok(r.fight, q);
        assert.equal(r.fight.id, fight, q);
        assert.equal(r.fight.mechId, mech, q);
    }
});

test('search: same mechanic name in two fights -> ambiguous, unless the fight being talked about is one of them', () => {
    const r = aiKnowledge.search('how do I do the shared buster', { userLang: 'en' });
    assert.equal(r.fight.id, null);
    assert.deepEqual(r.fight.ambiguous.sort(), ['dsr', 'ex-test']);
    const r2 = aiKnowledge.search('how do I do the shared buster', { userLang: 'en', contextFightId: 'dsr' });
    assert.equal(r2.fight.id, 'dsr');
    assert.equal(r2.fight.mechId, 'tankbuster');
    const r3 = aiKnowledge.search('shared buster in test ex', { userLang: 'en' });
    assert.equal(r3.fight.id, 'ex-test');
});

// ---------- 4. slim prompt ----------
test('slim prompt: only the parts the message needs (and the sizes)', async (ctx) => {
    const u = newUser();
    db.tz.set(u, 'Asia/Tokyo');
    userFacts(u).set('main_job', 'White Mage');
    userFacts(u).set('favorite_food', 'adobo');
    userFacts(u).set('task_1', 'buy potions');
    const sizes = {};

    await say('hi', u);
    let sys = systemText();
    sizes.hi = sys.length;
    assert.doesNotMatch(sys, /KNOWLEDGE|REFERENCE LINKS|DATABASE RECORDS|SAVED FACTS/);
    assert.match(sys, /\[REMINDER_JSON\]/, 'tool rules always there');
    assert.match(sys, /\[SET_FACT\]/);

    await say('remind me tomorrow at 9pm to do roulettes', u);
    sys = systemText();
    sizes.reminder = sys.length;
    assert.match(sys, /DATABASE RECORDS/);
    assert.match(sys, /task_1: buy potions/);
    assert.doesNotMatch(sys, /KNOWLEDGE \-\-\-[\s\S]*Program Loop/);

    await say('delete the second one', u);
    assert.match(systemText(), /DATABASE RECORDS/, 'follow-up right after a reminder message still gets the list');

    await say('How do I add a retainer?', u);
    sys = systemText();
    sizes.faq = sys.length;
    assert.match(sys, /Open the Retainers tab/);
    assert.match(sys, /https:\/\/pingway\.app\/dashboard\?tab=retainers/);
    assert.doesNotMatch(sys, /DATABASE RECORDS/);
    assert.doesNotMatch(sys, /favorite_food/);

    await say('what is my main job again?', u);
    assert.match(systemText(), /main_job: White Mage/, 'relevant fact sent');
    assert.doesNotMatch(systemText(), /favorite_food/, 'unrelated fact not sent');

    await say('what do you remember about me?', u);
    assert.match(systemText(), /favorite_food: adobo/, 'all facts when asked what Pingway remembers');

    await say('how does program loop work in top?', u);
    sys = systemText();
    sizes.fight = sys.length;
    assert.match(sys, /FIGHT GUIDE/);
    assert.match(sys, /LOOP-HOW-EN/);

    await say('any guide links for glamour?', u);
    assert.match(systemText(), /REFERENCE LINKS/);

    ctx.diagnostic('system prompt chars: ' + JSON.stringify(sizes));
});

test('reply language: French message gets French knowledge and a French fallback', async () => {
    const u = newUser();
    await say('Comment ajouter un servant ?', u);
    const sys = systemText();
    assert.match(sys, /Ouvre l'onglet Servants/);
    assert.match(sys, /reply in the language of the user's latest message; if unclear, reply in French/);
});

test('history: only the last 6 messages are kept and sent', async () => {
    const u = newUser();
    for (let i = 0; i < 6; i++) await say('message number ' + i, u);
    const msgs = ai.calls.at(-1).messages;
    assert.equal(msgs.length, 1 + 6 + 1);
    assert.equal(msgs[1].content, 'message number 2');
});

// ---------- 5. strat flow ----------
test('strat flow: no saved strat -> asks; the answer is saved as a fact; then only that strat', async () => {
    const u = newUser();
    await say('how does program loop work in top?', u);
    let sys = systemText();
    assert.match(sys, /has not told you their strat/);
    assert.match(sys, /NA PF standard/);
    assert.match(sys, /JP standard/);
    assert.doesNotMatch(sys, /LOOP-NA-EN|LOOP-JP-EN/, 'no strat dumped');

    ai.next = 'Got it, JP standard!';
    const replies = await say('we use JP standard', u);
    assert.equal(userFacts(u).get('strat:top'), 'jp-pf');
    sys = systemText();
    assert.match(sys, /LOOP-JP-EN/);
    assert.doesNotMatch(sys, /LOOP-NA-EN/);
    assert.ok(replies[0].includes(t('en', 'ai.notice.saved').trim()));

    // saved: answers that strat only, never asks again (same_as followed)
    await say('and pantokrator?', u);
    sys = systemText();
    assert.match(sys, /PANTO-NA-EN/, 'jp-pf is same_as na-pf for this mechanic');
    assert.doesNotMatch(sys, /has not told you their strat/);
    assert.match(sys, /strat:top: jp-pf/, 'the saved strat fact is always sent for the matched fight');
});

test('strat flow: a plain strat name answers the question; "we use X now" changes it', async () => {
    const u = newUser();
    await say('絶オメガのサークルプログラムは？', u);
    assert.match(systemText(), /リリドッ/);
    await say('リリドッ', u);
    assert.equal(userFacts(u).get('strat:top'), 'jp-pf');
    assert.match(systemText(), /LOOP-JP-JA/);

    await say('we use NA PF standard now for top', u);
    assert.equal(userFacts(u).get('strat:top'), 'na-pf');
    assert.match(systemText(), /LOOP-NA-EN/, 'mechanic from the conversation, new strat');
    assert.doesNotMatch(systemText(), /LOOP-JP-EN/);
});

test('strat flow: the AI tag is only a backup and only saves a real strat', async () => {
    const u = newUser();
    ai.next = 'Ok!\n[SET_FACT] strat:top = NA PF standard';
    await say('tell me about top', u);
    assert.equal(userFacts(u).get('strat:top'), 'na-pf', 'strat name mapped to its id');
    ai.next = 'Ok!\n[SET_FACT] strat:top = banana';
    await say('tell me about top', u);
    assert.equal(userFacts(u).get('strat:top'), 'na-pf', 'unknown strat never saved');
    ai.next = 'Ok!\n[SET_FACT] favorite_color = blue';
    await say('my favorite color is blue', u);
    assert.equal(userFacts(u).get('favorite_color'), 'blue', 'normal facts unchanged');
});

test('a fight with one strat answers it straight away (no question)', async () => {
    const u = newUser();
    await say('how do I do sanctity in dsr', u);
    const sys = systemText();
    assert.match(sys, /SANCT-EL-EN/);
    assert.doesNotMatch(sys, /has not told you their strat/);
});

// ---------- 6. missing data ----------
test('missing data folder: feature quietly off, AI and reminders work as before', async () => {
    aiKnowledge.init(path.join(os.tmpdir(), 'pingway-no-such-folder-' + Date.now()));
    assert.equal(aiKnowledge.enabled(), false);
    const u = newUser();
    db.tz.set(u, 'Asia/Tokyo');
    await say('how does program loop work in top?', u);
    assert.doesNotMatch(systemText(), /KNOWLEDGE|FIGHT GUIDE/);
    ai.next = 'Ok!\n[SET_FACT] strat:top = whatever';
    await say('remember that we use whatever for top', u);
    assert.equal(userFacts(u).get('strat:top'), 'whatever', 'without knowledge files facts save like before');
    const when = new Date(Date.now() + 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    ai.next = 'Got it!\n[REMINDER_JSON]{ "target_time": "' + when + '", "task": "roulettes", "is_recurring": false }[REMINDER_JSON]';
    const before = db.reminders.length;
    const r = await say('remind me tomorrow at this time to do roulettes', u);
    assert.match(systemText(), /DATABASE RECORDS/);
    assert.equal(db.reminders.length, before + 1, 'reminder saved');
    assert.ok(r[0].includes('Reminder set'));
    const replies = await say('Release recollection.', u);
    assert.deepEqual(replies, [t('en', 'ai.recollection')]);
});

// ---------- 7. memory ----------
test('memory: only the index at startup, one fight file loaded per question', async () => {
    assert.deepEqual(aiKnowledge.stats().cached, []);
    assert.equal(aiKnowledge.stats().fileLoads, 0);
    await say('how does program loop work in top?', newUser());
    assert.equal(aiKnowledge.stats().fileLoads, 1);
    assert.deepEqual(aiKnowledge.stats().cached, ['top']);
    await say('and panto in top?', newUser());
    assert.equal(aiKnowledge.stats().fileLoads, 1, 'second question: from the cache');
    await say('How do I add a retainer?', newUser());
    assert.equal(aiKnowledge.stats().fileLoads, 1, 'FAQ question loads no fight');
});

test('memory: LRU cache keeps at most 5 fights', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingway-ai-lru-'));
    fs.mkdirSync(path.join(dir, 'fights'));
    const ids = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];
    for (const id of ids) fs.writeFileSync(path.join(dir, 'fights', id + '.json'), JSON.stringify({ id, names: { en: 'Fight ' + id }, phases: [] }));
    try {
        aiKnowledge.init(dir);
        for (const id of ids) assert.ok(aiKnowledge.getFight(id));
        const st = aiKnowledge.stats();
        assert.equal(st.cacheMax, 5);
        assert.deepEqual(st.cached, ['f3', 'f4', 'f5', 'f6', 'f7']);
        aiKnowledge.getFight('f3'); // used again -> newest
        aiKnowledge.getFight('f1'); // loaded again -> f4 (oldest) dropped
        assert.deepEqual(aiKnowledge.stats().cached, ['f5', 'f6', 'f7', 'f3', 'f1']);
        assert.equal(aiKnowledge.stats().fileLoads, 8);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------- 8. FAQ generator ----------
test('FAQ generator: website list + 4 languages -> clean text, full pingway.app links, console refused', () => {
    const appJs = `
    const HELP_SERVER = 'https://discord.gg/abc';
    const PRIVACY_URL = 'https://github.com/x/privacy.md';
    const FAQ = [
        { id: 'f01', lk: 'nav.home', link: '/', k: 'what pingway bot' },
        { id: 'f02', lk: 'faq.lnkInvite', link: 'invite', k: 'add invite' },
        { id: 'f03', k: 'commands help' },
        { id: 'f05', lk: 'nav.me', link: '/dashboard.html?tab=settings', k: 'settings' },
        { id: 'f53', lk: 'faq.lnkPrivacy', link: PRIVACY_URL, k: 'privacy' }
    ];`;
    const tr = (l) => ({
        'nav.home': 'Home-' + l, 'nav.me': 'Me-' + l, 'faq.lnkInvite': 'Invite-' + l, 'faq.lnkPrivacy': 'Privacy-' + l,
        'faq.f01.q': 'Q1 ' + l, 'faq.f01.a': '<b>A1</b> ' + l + ' &amp; more', 'faq.f01.k': 'k1 ' + l,
        'faq.f02.q': 'Q2 ' + l, 'faq.f02.a': 'A2 ' + l, 'faq.f03.q': 'Q3 ' + l, 'faq.f03.a': 'Type `/help` ' + l,
        'faq.f05.q': 'Q5 ' + l, 'faq.f05.a': 'A5 ' + l, 'faq.f53.q': 'Q53 ' + l, 'faq.f53.a': 'A53 ' + l
    });
    const i18n = { en: tr('en'), fr: tr('fr'), de: tr('de'), ja: tr('ja') };
    const faq = buildFaq(appJs, i18n, '2026-11-26');
    assert.equal(faq.count, 5);
    const byId = Object.fromEntries(faq.entries.map(e => [e.id, e]));
    assert.equal(byId.f01.a.fr, 'A1 fr & more');
    assert.equal(byId.f03.a.ja, 'Type /help ja');
    assert.equal(byId.f01.link, 'https://pingway.app/');
    assert.equal(byId.f02.link, 'https://pingway.app/');
    assert.equal(byId.f05.link, 'https://pingway.app/dashboard?tab=settings');
    assert.equal(byId.f53.link, 'https://github.com/x/privacy.md');
    assert.equal(byId.f05.linkLabel.de, 'Me-de');
    assert.equal(byId.f01.k.de, 'k1 de');
    assert.equal(byId.f03.k.en, 'commands help');

    const bad = { ...i18n, en: { ...i18n.en, 'faq.f03.a': 'Open the console and type something' } };
    assert.throws(() => buildFaq(appJs, bad), /console/);
});

// ---------- 9. what the real research files contain ----------
test('old fight without strats: the fight note is sent, no strat question', async () => {
    const u = newUser();
    await say('old ex nails', u);
    const sys = systemText();
    assert.match(sys, /Fight note: OLD-NOTE-EN unsynced/);
    assert.match(sys, /NAILS-HOW/);
    assert.doesNotMatch(sys, /has not told you their strat|Strats for this fight/);
});

test('uncertain mechanic and uncertain strat: the AI is told to say so, not state it as fact', async () => {
    const u = newUser();
    await say('old ex nails', u);
    assert.match(systemText(), /mechanic info is not fully certain\. NAILS-DISAGREE.*check with their group/);
    const u2 = newUser();
    userFacts(u2).set('strat:top', 'na-pf');
    await say('top program loop', u2);
    assert.match(systemText(), /LOOP-NA-EN/);
    assert.match(systemText(), /strat info is not fully certain \(single source\)\. NA-SINGLE-SOURCE.*check with their group/);
});

test('region labels (incl. NA/EU) in the strat list; note-only strat: no invented steps', async () => {
    const u = newUser();
    await say('top program loop', u);
    assert.match(systemText(), /OCE Test \(NA\/EU\) \[strat id: oce-test\]/);
    assert.match(systemText(), /NA PF standard \(NA\) \[strat id: na-pf\]/);
    await say('OCE Test', u);
    assert.equal(userFacts(u).get('strat:top'), 'oce-test');
    const sys = systemText();
    assert.match(sys, /Strat note: OCE-NOTE-EN/);
    assert.match(sys, /no steps of this strat for this mechanic.*Do NOT invent steps/);
    assert.doesNotMatch(sys, /LOOP-NA-EN|LOOP-JP-EN/);
});

test('only the matched mechanic is sent, and a fight-only question has a capped mechanic list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingway-ai-big-'));
    fs.mkdirSync(path.join(dir, 'fights'));
    const mechanics = [];
    for (let i = 0; i < 300; i++) mechanics.push({ id: 'm' + i, names: { en: 'Mechanic number ' + i }, aliases: { en: [] }, how: { en: 'HOW-' + i + ' '.repeat(300) + 'x' }, strats: [] });
    fs.writeFileSync(path.join(dir, 'fights', 'big.json'), JSON.stringify({ id: 'big', names: { en: 'Big Fight' }, aliases: { en: ['bigfight'] }, strats_overview: [], phases: [{ id: 'p1', names: { en: 'P1' }, mechanics }] }));
    try {
        aiKnowledge.init(dir);
        assert.ok(fs.statSync(path.join(dir, 'fights', 'big.json')).size > 90000);
        const one = aiKnowledge.fightText(aiKnowledge.search('bigfight mechanic number 250', { userLang: 'en' }).fight, 'en', null).text;
        assert.match(one, /HOW-250/);
        assert.doesNotMatch(one, /HOW-249|HOW-1 /);
        assert.ok(one.length < 1000, 'one mechanic only: ' + one.length);
        const all = aiKnowledge.fightText(aiKnowledge.search('tips for bigfight', { userLang: 'en' }).fight, 'en', null).text;
        assert.match(all, /\.\.\.and more/);
        assert.ok(all.length < 1800, 'capped list: ' + all.length);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('matching: name parts, apostrophes, plurals, partial names, full names before parts, ties ask', () => {
    const s = (q, ctx) => aiKnowledge.search(q, { userLang: 'en', contextFightId: ctx }).fight;
    assert.equal(s('old ex hellfire').mechId, 'nails', 'a part of "Infernal Nails / Hellfire"');
    assert.equal(s('titans old bowl').id, 'ex-old', "apostrophe: titan's = titans");
    assert.equal(s('old ex granite gaol').mechId, 'gaol', 'plural: gaols = gaol');
    assert.equal(s('old ex grand cross').mechId, 'grand-cross-alpha', 'partial name inside a named fight');
    assert.equal(s('how do I do program loop').id, 'top', 'full name "Program Loop" beats a part of a longer name');
    const tie = s('how do I do the shared buster');
    assert.equal(tie.id, null);
    assert.equal(s('how do I do the shared buster', 'ex-test').id, 'ex-test');
});

test('fight question: the fight words do not pull in FAQ entries', () => {
    const r = aiKnowledge.search('top program loop reminder', { userLang: 'en' });
    assert.equal(r.fight.id, 'top');
    assert.deepEqual(r.faq, [], 'one FAQ keyword is not enough on a fight question');
});

test('strat aliases: a guide name picks its strat', () => {
    assert.equal(aiKnowledge.matchStrat('Tuufless, who takes it?', 'top'), 'na-pf');
    assert.equal(aiKnowledge.matchStrat('we do hector', 'top'), 'na-pf');
});

test('kind of mechanic: "tank buster" finds the tagged mechanics in fight order, also from the fight being talked about', () => {
    const a = aiKnowledge.search('TOP who takes the 1st tank buster? ST or MT?', { userLang: 'en' });
    assert.equal(a.fight.id, 'top');
    assert.deepEqual(a.fight.tagMechIds, ['pantokrator']);
    const b = aiKnowledge.search('who takes the first tankbuster', { userLang: 'en', contextFightId: 'top' });
    assert.equal(b.fight.id, 'top');
    assert.deepEqual(b.fight.tagMechIds, ['pantokrator']);
    const c = aiKnowledge.search('TOP towers', { userLang: 'en' });
    assert.deepEqual(c.fight.tagMechIds, ['program-loop']);
    const t = aiKnowledge.fightText(a.fight, 'en', 'na-pf').text;
    assert.match(t, /in fight order/);
    assert.match(t, /1\. .*This strat:/);
    assert.match(t, /never guess/);
    const ask = aiKnowledge.fightText(a.fight, 'en', null);
    assert.equal(ask.askStrat, true);
});

test('a strat named in the question is used for that answer, and the prompt forbids general-knowledge answers', async () => {
    await say('Tuufless, who takes the 1st tank buster in TOP?');
    const sys = ai.calls.at(-1).messages[0].content;
    assert.match(sys, /The user's group uses the strat/);
    assert.match(sys, /Answer ONLY from it/);
    assert.doesNotMatch(sys, /jp-pf\]/);
});

test('guide links: "Link?" gives the guide pages of the fight being talked about, strat language first, no tool files', () => {
    const a = aiKnowledge.search('Link?', { userLang: 'en', contextFightId: 'top' });
    assert.equal(a.fight.id, 'top');
    assert.equal(a.fight.wantLinks, true);
    const en = aiKnowledge.fightText(a.fight, 'en', 'na-pf').text;
    assert.match(en, /Guide links for this fight/);
    assert.ok(en.indexOf('example.com/en-top') < en.indexOf('example.jp/top'));
    assert.doesNotMatch(en, /raw\.githubusercontent/);
    const jp = aiKnowledge.fightText(a.fight, 'en', 'jp-pf').text;
    assert.ok(jp.indexOf('example.jp/top') < jp.indexOf('example.com/en-top'));
    const ja = aiKnowledge.search('絶オメガ リンクある？', { userLang: 'ja' });
    assert.equal(ja.fight.wantLinks, true);
    assert.equal(aiKnowledge.search('TOP pantokrator', { userLang: 'en' }).fight.wantLinks, undefined);
});
