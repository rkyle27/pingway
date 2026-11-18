// Website Boards jobs in the bot (utils/boards.js + utils/commandQueue.js): sign-up / report DMs, channel posts, Send test,
// expiry reminders. Plain node with a fake Discord client and an in-memory database:  node --test test/boards.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BD = require(path.join(ROOT, 'utils', 'boards.js'));
const Q = require(path.join(ROOT, 'utils', 'commandQueue.js'));
const { t } = require(path.join(ROOT, 'utils', 'i18n.js'));

const OWNER = '400000000000000001';
const SIGNER = '400000000000000002';
const REPORTER = '400000000000000003';
const GUILD = '410000000000000001', CHAN = '411000000000000001', ROLE = '412000000000000001', BOT = '419000000000000001';
const DAY = 864e5;
const NOW = Date.parse('2027-03-01T00:00:00Z');

// ---------- fake database ----------
function fakeDb() {
    const db = { posters: [], signups: [], reports: [], queue: [], log: [] };
    async function execute(sql, a = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        db.log.push({ q, a });
        if (/^SELECT id, kind, owner_id, title, expires_at, event_at, hidden, report_count, notify_channel, notify_guild_id, notify_channel_id, notify_role_id FROM board_posters WHERE id = \?$/.test(q)) return [db.posters.filter(p => p.id === a[0]).map(p => ({ ...p }))];
        if (/^SELECT id, poster_id, user_id, user_name, lodestone_id, char_name, char_world, send_card, fflogs_url, tomestone_url FROM board_signups WHERE id = \?$/.test(q)) return [db.signups.filter(s => s.id === a[0]).map(s => ({ ...s }))];
        if (q === 'SELECT id, poster_id, user_id, reason FROM board_reports WHERE id = ?') return [db.reports.filter(r => r.id === a[0]).map(r => ({ ...r }))];
        if (q === 'SELECT requested_by FROM command_queue WHERE id = ?') return [db.queue.filter(r => r.id === a[0]).map(r => ({ requested_by: r.requested_by }))];
        if (/^SELECT id, kind, owner_id, title, expires_at, expiry_dm_stage FROM board_posters WHERE kind IN/.test(q)) {
            if (db.noTable) { const e = new Error("Table 'board_posters' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
            return [db.posters.filter(p => ['lfm', 'lfs', 'fc', 'lffc'].includes(p.kind) && !p.hidden && p.expires_at > a[0] && p.expires_at <= a[1]).map(p => ({ ...p }))];
        }
        if (q === 'UPDATE board_posters SET expiry_dm_stage = ? WHERE id = ? AND expires_at = ? AND (expiry_dm_stage IS NULL OR expiry_dm_stage > ?)') {
            const p = db.posters.find(x => x.id === a[1] && x.expires_at === a[2] && (x.expiry_dm_stage === null || x.expiry_dm_stage > a[3]));
            if (p) p.expiry_dm_stage = a[0];
            return [{ affectedRows: p ? 1 : 0 }];
        }
        throw new Error('unexpected SQL: ' + q);
    }
    return { db, pool: { execute } };
}

// ---------- fake Discord ----------
function fakeDiscord({ ownerIsAdmin = true, botPerms = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'], roleMentionable = true, dmClosed = new Set() } = {}) {
    const sent = [], posts = [];
    const user = id => ({ id, username: 'user' + id.slice(-2), globalName: id === OWNER ? 'Owner Name' : null,
        send: async payload => { if (dmClosed.has(id)) { const e = new Error('Cannot send messages to this user'); e.code = 50007; throw e; } sent.push({ to: id, payload }); } });
    const channel = { id: CHAN, name: 'recruitment', send: async m => { posts.push(m); }, permissionsFor: () => ({ has: p => botPerms.includes(p) }) };
    const guild = {
        id: GUILD, name: 'Moogle FC', ownerId: '409999999999999999', preferredLocale: 'en-US',
        members: { me: { id: BOT }, fetch: async id => (id === OWNER ? { id, permissions: { has: p => ownerIsAdmin && p === 'Administrator' } } : null) },
        channels: { fetch: async id => (id === CHAN ? channel : null) },
        roles: { cache: new Map([[ROLE, { id: ROLE, name: 'Officers', mentionable: roleMentionable }]]) }
    };
    const client = { users: { fetch: async id => user(id) }, guilds: { cache: new Map([[GUILD, guild]]) } };
    return { client, sent, posts, guild };
}
function deps(pool, discord, extra) {
    const dmLog = [];
    return Object.assign({
        pool, client: discord.client, now: () => NOW,
        langOf: async id => (id === OWNER ? 'fr' : 'en'), guildLangOf: () => 'en',
        makeCard: async () => Buffer.from('PNGCARD'),
        dmStatus: { markFailed: async (id, why) => dmLog.push(['fail', id, why]), markOk: async id => dmLog.push(['ok', id]) },
        dmLog
    }, extra || {});
}
const poster = o => Object.assign({ id: 1, kind: 'lfm', owner_id: OWNER, title: 'Prog **static**', expires_at: NOW + 20 * DAY, event_at: 0, hidden: 0, report_count: 0,
    notify_channel: 0, notify_guild_id: null, notify_channel_id: null, notify_role_id: null, expiry_dm_stage: null }, o);
const signup = o => Object.assign({ id: 7, poster_id: 1, user_id: SIGNER, user_name: 'Juno @everyone', lodestone_id: '111', char_name: 'Juno Star', char_world: 'Titan',
    send_card: 1, fflogs_url: 'https://www.fflogs.com/character/lodestone-id/111', tomestone_url: null }, o);
const parse = r => JSON.parse(r.result);

// ---------- sign-up DM ----------
test('signup DM: to the owner in the OWNER\'s language, mention + name + profile link + character + only the ticked links + the IGN card; nobody is pinged', async () => {
    const { db, pool } = fakeDb();
    db.posters.push(poster()); db.signups.push(signup());
    const dc = fakeDiscord(), d = deps(pool, dc);
    let cardFor = null;
    d.makeCard = async (uid, lid, show) => { cardFor = [uid, lid, show]; return Buffer.from('PNGCARD'); };
    const r = await BD.run(d, 'boards_signup_dm', SIGNER, { signupId: 7 });
    assert.equal(r.state, 'done'); assert.deepEqual(parse(r), { sent: true, card: true });
    assert.equal(dc.sent.length, 1);
    const { to, payload } = dc.sent[0];
    assert.equal(to, OWNER);
    const e = payload.embeds[0];
    assert.equal(e.title, t('fr', 'boards.title.lfm'));
    assert.match(e.description, new RegExp('<@' + SIGNER + '>'));
    assert.ok(e.description.includes('https://discord.com/users/' + SIGNER), 'profile link');
    assert.ok(e.description.includes('Juno Star') && e.description.includes('Titan'));
    assert.ok(e.description.includes('https://www.fflogs.com/character/lodestone-id/111'));
    assert.ok(!/tomestone/i.test(e.description.replace(t('fr', 'boards.footer'), '')), 'Tomestone was not ticked');
    assert.ok(e.description.includes('@​everyone'), 'names cannot ping');
    assert.ok(e.description.includes('Prog \\*\\*static\\*\\*'), 'markdown shown as text');
    assert.ok(e.description.includes('https://pingway.app/poster?id=1'));
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(payload.files[0].name, 'ign_card.png'); assert.equal(e.image.url, 'attachment://ign_card.png');
    assert.deepEqual(cardFor, [SIGNER, '111', { fflogs: true, tomestone: false }], 'the card leaves out links that were not ticked');
    assert.deepEqual(d.dmLog, [['ok', OWNER]]);
});

test('signup DM: wording per kind (sign-up / recruitment offer / FC sign-up / invite); no card when not ticked or when it fails', async () => {
    const titles = new Set();
    for (const kind of ['lfm', 'lfs', 'fc', 'lffc']) {
        const { db, pool } = fakeDb();
        db.posters.push(poster({ kind })); db.signups.push(signup({ send_card: 0 }));
        const dc = fakeDiscord(), d = deps(pool, dc, { langOf: async () => 'en' });
        await BD.run(d, 'boards_signup_dm', SIGNER, { signupId: 7 });
        const e = dc.sent[0].payload.embeds[0];
        assert.equal(e.title, t('en', 'boards.title.' + kind));
        assert.ok(e.description.startsWith(t('en', 'boards.body.' + kind, { name: 'Juno @​everyone', mention: '<@' + SIGNER + '>', title: 'Prog \\*\\*static\\*\\*' })));
        assert.equal(dc.sent[0].payload.files, undefined);
        titles.add(e.title);
    }
    assert.equal(titles.size, 4);
    assert.ok(t('en', 'boards.title.lfs').includes('recruitment offer') && t('en', 'boards.title.lffc').includes('invite') && t('en', 'boards.title.lfm').includes('sign-up'));
    const { db, pool } = fakeDb();
    db.posters.push(poster()); db.signups.push(signup());
    const dc = fakeDiscord(), d = deps(pool, dc, { langOf: async () => 'en', makeCard: async () => { throw new Error('lodestone down'); } });
    const r = await BD.run(d, 'boards_signup_dm', SIGNER, { signupId: 7 });
    assert.deepEqual(parse(r), { sent: true, card: false });
    assert.ok(dc.sent[0].payload.embeds[0].description.includes(t('en', 'boards.cardFailed')));
});

test('signup DM: DMs closed -> dm_blocked (dmStatus.markFailed); the job is for the row\'s requested_by only; bad rows never crash', async () => {
    const { db, pool } = fakeDb();
    db.posters.push(poster()); db.signups.push(signup());
    const dc = fakeDiscord({ dmClosed: new Set([OWNER]) }), d = deps(pool, dc);
    const r = await BD.run(d, 'boards_signup_dm', SIGNER, { signupId: 7 });
    assert.deepEqual(parse(r), { sent: false, card: true });
    assert.deepEqual(d.dmLog, [['fail', OWNER, 'dm_closed']]);
    // someone else asking for that sign-up, bad ids, unknown jobs, a broken database: an error row, no throw, no DM
    const dc2 = fakeDiscord(), d2 = deps(pool, dc2);
    assert.equal((await BD.run(d2, 'boards_signup_dm', REPORTER, { signupId: 7 })).state, 'error');
    for (const args of [null, {}, { signupId: '7' }, { signupId: -1 }, { signupId: 1.5 }, [], 'x']) assert.equal((await BD.run(d2, 'boards_signup_dm', SIGNER, args)).state, 'error', JSON.stringify(args));
    assert.equal((await BD.run(d2, 'boards_signup_dm', 'not-an-id', { signupId: 7 })).state, 'error');
    assert.equal((await BD.run(d2, 'boards_nope', SIGNER, {})).state, 'error');
    assert.equal((await BD.run(deps({ execute: async () => { throw new Error('db down'); } }, dc2), 'boards_signup_dm', SIGNER, { signupId: 7 })).state, 'error');
    assert.equal(dc2.sent.length, 0);
    // a gone poster / an event: nothing sent
    db.posters[0].kind = 'event';
    assert.deepEqual(parse(await BD.run(d2, 'boards_signup_dm', SIGNER, { signupId: 7 })), { sent: false, reason: 'gone' });
});

// ---------- channel post ----------
test('channel post: in the owner\'s channel with the role ping only; skipped (owner DM says why) when not admin, no permissions, role not mentionable, Pingway gone', async () => {
    const setup = opts => {
        const { db, pool } = fakeDb();
        db.posters.push(poster({ notify_channel: 1, notify_guild_id: GUILD, notify_channel_id: CHAN, notify_role_id: ROLE })); db.signups.push(signup());
        const dc = fakeDiscord(opts);
        return { db, dc, d: deps(pool, dc) };
    };
    let { dc, d, db } = setup();
    let r = await BD.run(d, 'boards_channel_post', SIGNER, { signupId: 7 });
    assert.deepEqual(parse(r), { posted: true });
    assert.equal(dc.posts.length, 1);
    assert.equal(dc.posts[0].content, '<@&' + ROLE + '>');
    assert.deepEqual(dc.posts[0].allowedMentions, { parse: [], roles: [ROLE] });
    assert.equal(dc.posts[0].embeds[0].title, t('en', 'boards.title.lfm'), 'the server\'s language');
    assert.equal(dc.sent.length, 0, 'no DM: the DM job sends that one');
    for (const [opts, reason] of [[{ ownerIsAdmin: false }, 'notAdmin'], [{ botPerms: ['ViewChannel', 'SendMessages'] }, 'noPerms'], [{ roleMentionable: false }, 'cantMention']]) {
        ({ dc, d } = setup(opts));
        r = await BD.run(d, 'boards_channel_post', SIGNER, { signupId: 7 });
        assert.deepEqual(parse(r), { posted: false, reason }, reason);
        assert.equal(dc.posts.length, 0);
        assert.equal(dc.sent.length, 1); assert.equal(dc.sent[0].to, OWNER);
        assert.ok(dc.sent[0].payload.embeds[0].description.includes(t('fr', 'boards.skip.' + reason)), reason);
    }
    // the guild owner may always; Mention @everyone lets Pingway ping a role that is not mentionable
    ({ dc, d } = setup({ ownerIsAdmin: false, roleMentionable: false, botPerms: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'MentionEveryone'] }));
    dc.guild.ownerId = OWNER;
    assert.deepEqual(parse(await BD.run(d, 'boards_channel_post', SIGNER, { signupId: 7 })), { posted: true });
    ({ dc, d } = setup());
    dc.client.guilds.cache.clear();
    assert.deepEqual(parse(await BD.run(d, 'boards_channel_post', SIGNER, { signupId: 7 })), { posted: false, reason: 'noGuild' });
    // channel post switched off since: nothing
    ({ dc, d, db } = setup());
    db.posters[0].notify_channel = 0;
    assert.deepEqual(parse(await BD.run(d, 'boards_channel_post', SIGNER, { signupId: 7 })), { posted: false, reason: 'off' });
    assert.equal(dc.posts.length + dc.sent.length, 0);
});

// ---------- Send test ----------
test('Send test: a real test DM to the asker (+ the channel test with the same checks)', async () => {
    const { pool } = fakeDb();
    let dc = fakeDiscord(), d = deps(pool, dc);
    let r = await BD.run(d, 'boards_test', OWNER, { kind: 'lfm' });
    assert.deepEqual(parse(r), { dm: true, channel: null });
    assert.equal(dc.sent[0].to, OWNER);
    assert.equal(dc.sent[0].payload.embeds[0].title, t('fr', 'boards.test.dmTitle'));
    r = await BD.run(d, 'boards_test', OWNER, { kind: 'fc', guildId: GUILD, channelId: CHAN, roleId: ROLE });
    assert.deepEqual(parse(r), { dm: true, channel: true });
    assert.ok(dc.posts[0].content.startsWith('<@&' + ROLE + '> '));
    assert.ok(dc.posts[0].content.includes('Owner Name'));
    assert.deepEqual(dc.posts[0].allowedMentions, { parse: [], roles: [ROLE] });
    dc = fakeDiscord({ ownerIsAdmin: false }); d = deps(pool, dc);
    r = await BD.run(d, 'boards_test', OWNER, { kind: 'fc', guildId: GUILD, channelId: CHAN });
    assert.deepEqual(parse(r), { dm: true, channel: 'notAdmin' });
    assert.ok(dc.sent[0].payload.embeds[0].description.includes(t('fr', 'boards.skip.notAdmin')));
    assert.equal(dc.posts.length, 0);
    assert.equal((await BD.run(d, 'boards_test', OWNER, { kind: 'event', guildId: GUILD, channelId: CHAN })).state, 'error', 'events have no channel post');
    assert.equal((await BD.run(d, 'boards_test', OWNER, { kind: 'bad' })).state, 'error');
});

// ---------- report DM ----------
test('report DM: to the owner with the reason and the count, says when it is hidden; never who reported it', async () => {
    const { db, pool } = fakeDb();
    db.posters.push(poster({ report_count: 3, hidden: 1 }));
    db.reports.push({ id: 5, poster_id: 1, user_id: REPORTER, reason: 'link' });
    const dc = fakeDiscord(), d = deps(pool, dc);
    assert.equal((await BD.run(d, 'boards_report_dm', SIGNER, { reportId: 5 })).state, 'error', 'only for the reporter\'s own row');
    const r = await BD.run(d, 'boards_report_dm', REPORTER, { reportId: 5 });
    assert.deepEqual(parse(r), { sent: true });
    const e = dc.sent[0].payload.embeds[0];
    assert.equal(dc.sent[0].to, OWNER);
    assert.ok(e.description.includes(t('fr', 'boards.report.reason.link')) && e.description.includes('3'));
    assert.ok(e.description.includes(t('fr', 'boards.report.hidden')));
    assert.ok(!JSON.stringify(dc.sent).includes(REPORTER), 'no reporter id');
    db.reports[0].reason = 'evil';
    assert.equal((await BD.run(d, 'boards_report_dm', REPORTER, { reportId: 5 })).state, 'error');
});

// ---------- expiry reminders ----------
test('expiry reminders: 5, 3 and 0 days, once each, Static / FC only (not hidden, not long-expired); a bump starts over', async () => {
    const { db, pool } = fakeDb();
    db.posters.push(
        poster({ id: 1, title: 'Five', expires_at: NOW + 4.5 * DAY }),
        poster({ id: 2, title: 'Three', kind: 'fc', expires_at: NOW + 2 * DAY }),
        poster({ id: 3, title: 'Zero', kind: 'lffc', expires_at: NOW - 3600e3 }),
        poster({ id: 4, title: 'Long gone', expires_at: NOW - 3 * DAY }),
        poster({ id: 5, title: 'Far', expires_at: NOW + 20 * DAY }),
        poster({ id: 6, title: 'Hidden', expires_at: NOW + 2 * DAY, hidden: 1 }),
        poster({ id: 7, title: 'Event', kind: 'event', expires_at: NOW + 2 * DAY }),
        poster({ id: 8, title: 'Already told', expires_at: NOW + 2 * DAY, expiry_dm_stage: 3 })
    );
    const dc = fakeDiscord(), d = deps(pool, dc, { langOf: async () => 'en' });
    assert.equal(await BD.checkExpiry(d), 3);
    assert.deepEqual(dc.sent.map(s => s.payload.embeds[0].title), [t('en', 'boards.expiry.title5'), t('en', 'boards.expiry.title3'), t('en', 'boards.expiry.title0')]);
    assert.deepEqual(db.posters.map(p => p.expiry_dm_stage), [5, 3, 0, null, null, null, null, 3]);
    assert.ok(dc.sent[0].payload.embeds[0].description.includes('https://pingway.app/dashboard?tab=boards'));
    assert.equal(await BD.checkExpiry(d), 0, 'once each');
    // two days later the 5-day poster gets its 3-day reminder; a bumped poster (stage NULL, new date) starts over
    db.posters[1].expiry_dm_stage = null; db.posters[1].expires_at = NOW + 30 * DAY;
    assert.equal(await BD.checkExpiry(Object.assign({}, d, { now: () => NOW + 2 * DAY })), 2, 'the 5-day one is at 3 days now, "Already told" has expired now');
    assert.equal(db.posters[0].expiry_dm_stage, 3); assert.equal(db.posters[7].expiry_dm_stage, 0); assert.equal(db.posters[1].expiry_dm_stage, null, 'bumped: far away again');
    assert.equal(BD.dueStage(NOW + 5 * DAY, NOW), 5); assert.equal(BD.dueStage(NOW + 5 * DAY + 1, NOW), null); assert.equal(BD.dueStage(NOW + 3 * DAY, NOW), 3);
    assert.equal(BD.dueStage(NOW, NOW), 0); assert.equal(BD.dueStage(NOW - DAY, NOW), null);
    // no tables yet: nothing, no crash
    db.noTable = true;
    assert.equal(await BD.checkExpiry(d), 0);
});

// ---------- command queue ----------
test('command queue: Boards jobs run with the row\'s requested_by (never a user id from args); without the Boards hook they end as an error', async () => {
    const { db, pool } = fakeDb();
    db.queue.push({ id: 1, action: 'boards_signup_dm', args: JSON.stringify({ signupId: 7, userId: REPORTER }), requested_by: SIGNER });
    const calls = [];
    const out = await Q.runOne(db.queue[0], { boards: async (action, userId, args) => { calls.push([action, userId, args]); return { state: 'done', result: '{}' }; } }, pool);
    assert.equal(out.state, 'done');
    assert.deepEqual(calls, [['boards_signup_dm', SIGNER, { signupId: 7, userId: REPORTER }]]);
    assert.equal((await Q.runOne(db.queue[0], {}, pool)).state, 'error');
    for (const a of BD.ACTIONS) assert.ok(Q.BOARDS_ACTIONS.includes(a));
    // and the private hook never sees them
    let priv = 0;
    await Q.runOne(db.queue[0], { boards: async () => ({ state: 'done', result: '' }), runPrivate: async () => { priv++; return null; } }, pool);
    assert.equal(priv, 0);
});

test('the bot and the website create the same Boards tables (utils/boardsDdl.js = website lib/boardsDdl.js)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'utils', 'boardsDdl.js'), 'utf8');
    assert.match(src, /IDENTICAL in both repos/);
    const site = path.join(ROOT, '..', 'pingway-dashboard', 'lib', 'boardsDdl.js');
    if (fs.existsSync(site)) assert.equal(src, fs.readFileSync(site, 'utf8'));
    const D = require(path.join(ROOT, 'utils', 'boardsDdl.js'));
    assert.equal(D.ALL_DDL.length, 4);
    assert.match(D.BOARD_SIGNUPS_DDL, /UNIQUE KEY uq_signup \(poster_id, user_id\)/);
    assert.match(D.BOARD_REPORTS_DDL, /UNIQUE KEY uq_report \(poster_id, user_id\)/);
    assert.match(D.BOARD_STARS_DDL, /PRIMARY KEY \(poster_id, user_id\)/);
    assert.match(D.BOARD_POSTERS_DDL, /image MEDIUMBLOB/);
});
