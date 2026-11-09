// AI assistant: Pingway's own role mention + reminder time zones (events/messageCreate.js, utils/userTimezone.js).
// Plain node, no Discord, no database, no network:  node --test test/ai-reminders-tz.test.js
// The OpenRouter call (openai package), the database (utils/db.js), maintenance and honeypot are fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BOT = '1530586586524418048';
const BOT_ROLE = '900000000000000001';
const OTHER_ROLE = '900000000000000002';
const AI_CHANNEL = 'chan-ai';
const NOW = Date.parse('2026-11-10T12:51:00Z'); // 21:51 in Japan

// ---------- module fakes ----------
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}

// Fake OpenRouter: each test sets ai.next (text or function(messages) -> text)
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

// Fake database
const db = { reminders: [], tz: new Map(), aiChannels: new Set([AI_CHANNEL]) };
const pool = {
    async execute(sql, params = []) {
        if (/FROM ai_active_channels/.test(sql)) return [db.aiChannels.has(params[1]) ? [{ channel_id: params[1] }] : []];
        if (/^\s*INSERT INTO reminders/.test(sql)) {
            const [guild_id, channel_id, user_id, reminder_text, target_timestamp, is_recurring, recurrence_rule] = params;
            db.reminders.push({ guild_id, channel_id, user_id, reminder_text, target_timestamp, is_recurring, recurrence_rule });
            return [{ insertId: db.reminders.length }];
        }
        if (/SELECT tz FROM user_timezone/.test(sql)) return [db.tz.has(params[0]) ? [{ tz: db.tz.get(params[0]) }] : []];
        if (/INSERT INTO user_timezone/.test(sql)) { db.tz.set(params[0], params[1]); return [{}]; }
        return [[]]; // CREATE TABLE, user_facts, reminders list, user_language ...
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });
inject(path.join(ROOT, 'maintenance.js'), { isMaintenance: () => false });
inject(path.join(ROOT, 'utils', 'honeypot.js'), { isTrap: () => false, handle: async () => {} });
inject(path.join(ROOT, 'utils', 'helpContent.js'), { buildHelpPayload: () => ({ embeds: [] }), WEBSITE_URL: 'https://example.invalid' });

const { t } = require(path.join(ROOT, 'utils', 'i18n'));
const userTimezone = require(path.join(ROOT, 'utils', 'userTimezone'));
const messageCreate = require(path.join(ROOT, 'events', 'messageCreate'));

// ---------- fake Discord message ----------
class Coll extends Map { find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; } }
let seq = 0;
function newUser() { return 'user' + (++seq); }

function makeMsg(content, { userId, channelId = AI_CHANNEL, ownRole = true, roles = [] } = {}) {
    const replies = [];
    const msg = {
        content,
        author: { id: userId, bot: false, displayName: 'Tester' },
        guild: { id: 'g1', members: { me: { roles: { botRole: ownRole ? { id: BOT_ROLE, tags: { botId: BOT } } : null } } } },
        guildId: 'g1',
        channelId,
        client: { user: { id: BOT } },
        mentions: { roles: new Coll(roles.map(r => [r.id, r])) },
        channel: { sendTyping: async () => {}, send: async (x) => replies.push(typeof x === 'string' ? x : x.content) },
        reply: async (x) => { replies.push(typeof x === 'string' ? x : x.content); }
    };
    return { msg, replies };
}
async function say(content, opts) {
    const { msg, replies } = makeMsg(content, opts);
    await messageCreate.execute(msg);
    return replies;
}
const lastUserText = () => { const m = ai.calls.at(-1).messages; return m[m.length - 1].content; };
const systemText = () => ai.calls.at(-1).messages[0].content;
const reminderTag = (time, task = 'do roulettes') => `Got it!\n[REMINDER_JSON]{ "target_time": "${time}", "task": "${task}", "is_recurring": false }[REMINDER_JSON]`;

test.beforeEach((ctx) => {
    ctx.mock.timers.enable({ apis: ['Date'], now: NOW });
    ai.calls.length = 0;
    ai.next = 'Sure!';
    db.reminders.length = 0;
    userTimezone.clearCache();
});

// ---------- 1. role mentions ----------
test('own bot role mention counts as mentioning Pingway (outside AI channel -> /help pointer)', async () => {
    const replies = await say(`<@&${BOT_ROLE}> hello`, { userId: newUser(), channelId: 'chan-plain' });
    assert.deepEqual(replies, [t('en', 'ai.notHere')]);
});

test('own bot role found by role.tags.botId when members.me has no botRole', async () => {
    const role = { id: BOT_ROLE, tags: { botId: BOT } };
    const replies = await say(`<@&${BOT_ROLE}> hello`, { userId: newUser(), channelId: 'chan-plain', ownRole: false, roles: [role] });
    assert.deepEqual(replies, [t('en', 'ai.notHere')]);
});

test('other role mention is ignored', async () => {
    const role = { id: OTHER_ROLE, tags: {} };
    const replies = await say(`<@&${OTHER_ROLE}> hello`, { userId: newUser(), channelId: 'chan-plain', roles: [role] });
    assert.deepEqual(replies, []);
    assert.equal(ai.calls.length, 0);
});

test('own role mention is stripped from the prompt (like the user mention)', async () => {
    await say(`<@&${BOT_ROLE}> what is a raid?`, { userId: newUser() });
    assert.equal(lastUserText(), 'what is a raid?');
    await say(`<@${BOT}> what is a trial?`, { userId: newUser() });
    assert.equal(lastUserText(), 'what is a trial?');
});

test('only the role mention (no text) shows help, like a bare @Pingway', async () => {
    const replies = await say(`<@&${BOT_ROLE}>`, { userId: newUser() });
    assert.deepEqual(replies, [t('en', 'ai.helpIntro')]);
});

// ---------- 2. time zones ----------
test('unknown tz: asks once, "Japan" saves Asia/Tokyo and creates the pending reminder at the right UTC time', async () => {
    const u = newUser();
    let replies = await say('remind me at 10pm today to do roulettes', { userId: u });
    assert.deepEqual(replies, [t('en', 'ai.tz.ask')]);
    assert.equal(ai.calls.length, 0, 'no AI call before the time zone is known');
    assert.equal(db.reminders.length, 0);

    ai.next = reminderTag('2026-11-10T22:00:00+09:00');
    replies = await say('Japan', { userId: u });
    assert.equal(db.tz.get(u), 'Asia/Tokyo');
    assert.equal(ai.calls.length, 1);
    assert.equal(lastUserText(), 'remind me at 10pm today to do roulettes', 'the original request is sent to the AI');
    assert.match(systemText(), /2026-11-10 21:51/);
    assert.match(systemText(), /Asia\/Tokyo \(UTC\+09:00\)/);
    assert.equal(db.reminders.length, 1);
    assert.equal(db.reminders[0].target_timestamp, Date.parse('2026-11-10T13:00:00Z'));
    assert.ok(replies[0].startsWith(t('en', 'ai.tz.saved', { tz: 'Asia/Tokyo' })));
    assert.ok(replies[0].includes('Reminder set'));

    // never asked again
    ai.next = reminderTag('2026-11-11T08:00:00+09:00', 'daily');
    replies = await say('remind me tomorrow at 8am about dailies', { userId: u });
    assert.equal(ai.calls.length, 2);
    assert.equal(db.reminders.length, 2);
    assert.equal(db.reminders[1].target_timestamp, Date.parse('2026-11-10T23:00:00Z'));
});

test('known tz: no question; local time without offset is read in the user zone', async () => {
    const u = newUser();
    db.tz.set(u, 'Asia/Tokyo');
    ai.next = reminderTag('2026-11-10T22:00:00');
    const replies = await say('remind me at 10pm today to do roulettes', { userId: u });
    assert.equal(ai.calls.length, 1);
    assert.ok(!replies[0].includes(t('en', 'ai.tz.ask')));
    assert.equal(db.reminders[0].target_timestamp, Date.parse('2026-11-10T13:00:00Z'));
});

test('past time is refused and not saved', async () => {
    const u = newUser();
    db.tz.set(u, 'Asia/Tokyo');
    ai.next = reminderTag('2026-11-10T20:00:00+09:00');
    const replies = await say('remind me at 8pm today', { userId: u });
    assert.equal(db.reminders.length, 0);
    assert.equal(replies[0], t('en', 'ai.tz.badTime.past'));
});

test('wrong year (the 2023 bug) is refused and not saved', async () => {
    const u = newUser();
    db.tz.set(u, 'Asia/Tokyo');
    ai.next = reminderTag('2023-11-10T22:00:00+09:00');
    const replies = await say('remind me at 10pm today', { userId: u });
    assert.equal(db.reminders.length, 0);
    assert.equal(replies[0], t('en', 'ai.tz.badTime.year'));
});

test('beyond next year / more than 2 years ahead is refused, ~1 min grace for "now"', () => {
    assert.equal(userTimezone.checkTarget(Date.parse('2028-11-09T00:00:00Z'), 'Asia/Tokyo', NOW), 'year');
    assert.equal(userTimezone.checkTarget(Date.parse('2027-12-31T00:00:00Z'), 'Asia/Tokyo', NOW), 'ok');
    assert.equal(userTimezone.checkTarget(NOW - 30 * 1000, 'Asia/Tokyo', NOW), 'ok', '~1 minute grace');
});

test('unreadable answer: asks once more with examples, then uses UTC (not saved) after 2 failed tries', async () => {
    const u = newUser();
    await say('remind me at 10pm today', { userId: u });
    let replies = await say('banana', { userId: u });
    assert.deepEqual(replies, [t('en', 'ai.tz.askAgain')]);
    assert.equal(ai.calls.length, 0);

    ai.next = reminderTag('2026-11-10T22:00:00+00:00');
    replies = await say('purple', { userId: u });
    assert.equal(db.tz.has(u), false);
    assert.equal(ai.calls.length, 1);
    assert.equal(lastUserText(), 'remind me at 10pm today');
    assert.equal(db.reminders[0].target_timestamp, Date.parse('2026-11-10T22:00:00Z'));
    assert.ok(replies[0].startsWith(t('en', 'ai.tz.usingUtc')));
});

test('AI made a reminder although the heuristic missed it: ask first, save nothing, then continue', async () => {
    const u = newUser();
    ai.next = reminderTag('2026-11-10T22:00:00Z');
    let replies = await say('ping me at 10 tonight for maps', { userId: u });
    assert.deepEqual(replies, [t('en', 'ai.tz.ask')]);
    assert.equal(db.reminders.length, 0);

    ai.next = reminderTag('2026-11-10T22:00:00+09:00');
    replies = await say('Tokyo', { userId: u });
    assert.equal(lastUserText(), 'ping me at 10 tonight for maps');
    assert.equal(db.reminders[0].target_timestamp, Date.parse('2026-11-10T13:00:00Z'));
});

test('looking at reminders does not ask for a time zone', async () => {
    const u = newUser();
    await say('can I see my reminders?', { userId: u });
    assert.equal(ai.calls.length, 1);
});

test('resolve() maps common answers to IANA names', () => {
    const cases = {
        'Japan': 'Asia/Tokyo', 'JST': 'Asia/Tokyo', 'tokyo': 'Asia/Tokyo', '日本': 'Asia/Tokyo',
        'London': 'Europe/London', 'UK': 'Europe/London', "I'm in London": 'Europe/London',
        'Philippines': 'Asia/Manila', 'Manila': 'Asia/Manila',
        'NY': 'America/New_York', 'EST': 'America/New_York', 'LA': 'America/Los_Angeles', 'PST': 'America/Los_Angeles',
        'Paris': 'Europe/Paris', 'France': 'Europe/Paris', 'Berlin': 'Europe/Berlin', 'Germany': 'Europe/Berlin',
        'Sydney': 'Australia/Sydney', 'asia/tokyo': 'Asia/Tokyo', 'UTC+9': 'Etc/GMT-9'
    };
    for (const [answer, tz] of Object.entries(cases)) assert.equal(userTimezone.resolve(answer), tz, answer);
    for (const bad of ['banana', 'yes', '', 'à la maison']) assert.equal(userTimezone.resolve(bad), null, bad);
});
