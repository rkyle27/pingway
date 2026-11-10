// Dev page Giveaway (v2.2 Part 8): command_queue 'giveaway_pick' -> utils/giveaway.js pick() + the winner's Claim button.
// Plain node, no Discord / database:  node --test test/giveaway.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---------- discord.js stand-in (only when it is not installed) ----------
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file; m.loaded = true; m.exports = exports;
    require.cache[file] = m;
}
function canLoad(name) { try { require.resolve(name); return true; } catch (e) { return false; } }
if (!canLoad('discord.js')) {
    const builder = () => {
        const data = {};
        const self = new Proxy({}, {
            get(_o, k) {
                if (k === 'toJSON') return () => ({ ...data, ...(data.components ? { components: data.components.map(c => (c && c.toJSON ? c.toJSON() : c)) } : {}) });
                if (k === 'data') return data;
                if (k === 'then' || typeof k !== 'string') return undefined;
                return (...args) => {
                    if (k.startsWith('set')) { const f = k.slice(3); data[f.charAt(0).toLowerCase() + f.slice(1)] = args[0]; }
                    else if (k.startsWith('add')) { const f = k.slice(3).toLowerCase(); data[f] = (data[f] || []).concat(args.flat()); }
                    return self;
                };
            }
        });
        return self;
    };
    const B = function () { return builder(); };
    const shim = { ActionRowBuilder: B, ButtonBuilder: B, EmbedBuilder: B, ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 }, MessageFlags: { Ephemeral: 64 } };
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) { return request === 'discord.js' ? 'shim:discord.js' : orig.call(this, request, ...rest); };
    inject('shim:discord.js', shim);
}
const plain = c => (c && typeof c.toJSON === 'function' ? c.toJSON() : c);

const GW = require(path.join(ROOT, 'utils', 'giveaway.js'));
const Q = require(path.join(ROOT, 'utils', 'commandQueue.js'));
const { t } = require(path.join(ROOT, 'utils', 'i18n.js'));

const OWNER = '100000000000000001';
const STAFF = '100000000000000002';
const HUMAN = '100000000000000003';
const NOW = Date.parse('2027-03-01T00:00:00Z');
const DAY = 864e5;

// ---------- fake database ----------
function fakeDb() {
    const db = { users: new Map([[OWNER, 'dev'], [STAFF, 'staff']]), gw: [], audit: [], queue: [], log: [] };
    async function execute(sql, a = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        db.log.push({ q, a });
        const g = id => db.gw.find(x => x.id === Number(id));
        if (q === 'SELECT role FROM dev_users WHERE user_id = ?') return [db.users.has(a[0]) ? [{ role: db.users.get(a[0]) }] : []];
        if (q === "UPDATE giveaways SET state = 'drawing' WHERE id = ? AND state = 'picking' AND created_by = ?") {
            const r = g(a[0]); if (r && r.state === 'picking' && r.created_by === a[1]) { r.state = 'drawing'; return [{ affectedRows: 1 }]; } return [{ affectedRows: 0 }];
        }
        if (q === 'SELECT * FROM giveaways WHERE id = ?') return [[g(a[0])].filter(Boolean).map(r => ({ ...r }))];
        if (q === "UPDATE giveaways SET state = 'no_member', note = ?, picked_at = ? WHERE id = ?") { Object.assign(g(a[2]), { state: 'no_member', note: a[0], picked_at: a[1] }); return [{ affectedRows: 1 }]; }
        if (q === 'UPDATE giveaways SET guild_id = ?, guild_name = ?, winner_id = ?, winner_name = ?, picked_at = ? WHERE id = ?') {
            Object.assign(g(a[5]), { guild_id: a[0], guild_name: a[1], winner_id: a[2], winner_name: a[3], picked_at: a[4] }); return [{ affectedRows: 1 }];
        }
        if (q === "UPDATE giveaways SET state = 'dm_failed', note = ? WHERE id = ?") { Object.assign(g(a[1]), { state: 'dm_failed', note: a[0] }); return [{ affectedRows: 1 }]; }
        if (q === "UPDATE giveaways SET state = 'dm_sent', expires_at = ? WHERE id = ?") { Object.assign(g(a[1]), { state: 'dm_sent', expires_at: a[0] }); return [{ affectedRows: 1 }]; }
        if (q === "UPDATE giveaways SET state = 'error', note = ? WHERE id = ? AND state = 'drawing'") { const r = g(a[1]); if (r && r.state === 'drawing') Object.assign(r, { state: 'error', note: a[0] }); return [{ affectedRows: 1 }]; }
        if (q === "UPDATE giveaways SET state = 'claimed', claimed_at = ? WHERE id = ? AND winner_id = ? AND state = 'dm_sent' AND expires_at > ?") {
            const r = g(a[1]); if (r && r.winner_id === a[2] && r.state === 'dm_sent' && r.expires_at > a[3]) { Object.assign(r, { state: 'claimed', claimed_at: a[0] }); return [{ affectedRows: 1 }]; } return [{ affectedRows: 0 }];
        }
        if (q === "UPDATE giveaways SET state = 'expired' WHERE id = ? AND state = 'dm_sent'") { const r = g(a[0]); if (r && r.state === 'dm_sent') { r.state = 'expired'; return [{ affectedRows: 1 }]; } return [{ affectedRows: 0 }]; }
        if (q === 'UPDATE giveaways SET grant_queue_id = ? WHERE id = ?') { g(a[1]).grant_queue_id = a[0]; return [{ affectedRows: 1 }]; }
        if (/^INSERT INTO dev_audit/.test(q)) { db.audit.push({ id: db.audit.length + 1, at: a[0], actor_id: a[1], actor_role: a[2], action: a[3], target: a[4], before_val: a[5], after_val: a[6], detail: a[7] }); return [{ insertId: db.audit.length }]; }
        if (/^INSERT INTO command_queue/.test(q)) { const id = db.queue.length + 1; db.queue.push({ id, action: a[0], args: a[1], state: 'pending', audit_id: a[2], requested_by: a[3], created_at: a[4] }); return [{ insertId: id }]; }
        if (q === 'SELECT requested_by FROM command_queue WHERE id = ?') return [db.queue.filter(r => r.id === a[0]).map(r => ({ requested_by: r.requested_by }))];
        throw new Error('unexpected SQL: ' + q);
    }
    const add = (over = {}) => {
        const row = Object.assign({ id: db.gw.length + 1, reward_text: 'A cool prize', reward_kind: 'manual', reward_amount: 0, state: 'picking', guild_id: null, guild_name: null,
            winner_id: null, winner_name: null, note: null, reroll_of: null, queue_id: null, grant_queue_id: null, created_by: OWNER, created_at: NOW, picked_at: 0, expires_at: 0, claimed_at: 0 }, over);
        db.gw.push(row);
        return row;
    };
    return { db, pool: { execute }, add };
}

// ---------- fake Discord ----------
const coll = list => new Map(list.map(m => [m.user.id, m]));
function member(id, extra = {}) {
    const sent = [];
    return { displayName: 'Name ' + id.slice(-2), user: Object.assign({ id, username: 'u' + id.slice(-2), bot: false, system: false, sent,
        async send(msg) { if (this.closed) { const e = new Error('Cannot send messages to this user'); e.code = 50007; throw e; } sent.push(msg); return {}; } }, extra) };
}
function guild(id, members, opts = {}) {
    const calls = [];
    return {
        id, name: 'Server ' + id.slice(-2), available: true, calls,
        members: {
            cache: coll(opts.cache || []),
            async list(o) { calls.push(o); if (opts.listFails) throw new Error('Missing Access'); return coll(members); }
        }
    };
}
const clientWith = guilds => ({ guilds: { cache: new Map(guilds.map(g => [g.id, g])) } });
const first = () => 0;

test('pick: only a dev may draw (staff / unknown refused, checked again in the bot)', async () => {
    const { db, pool, add } = fakeDb();
    add({ created_by: STAFF });
    const g = guild('200000000000000001', [member(HUMAN)]);
    const r = await GW.pick({ pool, client: clientWith([g]), random: first, now: () => NOW }, STAFF, { giveawayId: 1 });
    assert.equal(r.state, 'error');
    assert.equal(JSON.parse(r.result).reason, 'notDev');
    assert.equal(db.gw[0].state, 'picking', 'nothing drawn');
    assert.equal(g.calls.length, 0, 'no Discord request');
    assert.ok(db.audit.some(x => x.action === 'giveaway.refused'));
    const r2 = await GW.pick({ pool, client: clientWith([g]) }, '100000000000000099', { giveawayId: 1 });
    assert.equal(JSON.parse(r2.result).reason, 'notDev');
    assert.equal((await GW.pick({ pool, client: clientWith([g]) }, OWNER, { giveawayId: 'x' })).state, 'error');
});

test('pick: bots, apps and system users are never picked; one limited member request (1,000) per server', async () => {
    const { db, pool, add } = fakeDb();
    add();
    const bot = member('300000000000000001', { bot: true }), app = member('300000000000000002', { bot: true, flags: 'VerifiedBot' }), sys = member('300000000000000003', { system: true });
    const human = member(HUMAN);
    const g = guild('200000000000000001', [bot, app, sys, human]);
    for (let i = 0; i < 20; i++) assert.deepEqual(GW.isReal(bot) || GW.isReal(app) || GW.isReal(sys), false);
    const r = await GW.pick({ pool, client: clientWith([g]), random: n => n - 1, now: () => NOW, langOf: async () => 'en' }, OWNER, { giveawayId: 1 });
    assert.equal(r.state, 'done');
    assert.equal(db.gw[0].winner_id, HUMAN);
    assert.deepEqual(g.calls, [{ limit: 1000 }], 'one request, limited');
    assert.equal(bot.user.sent.length + app.user.sent.length + sys.user.sent.length, 0);
});

test('pick: the owner can win too; a guild with no real member is skipped', async () => {
    const { db, pool, add } = fakeDb();
    add({ reward_kind: 'points', reward_amount: 50, reward_text: '' });
    const empty = guild('200000000000000001', [member('300000000000000001', { bot: true })]);
    const ownerOnly = guild('200000000000000002', [member(OWNER), member('300000000000000004', { bot: true })]);
    const r = await GW.pick({ pool, client: clientWith([empty, ownerOnly]), random: first, now: () => NOW, langOf: async () => 'en' }, OWNER, { giveawayId: 1 });
    assert.equal(r.state, 'done');
    assert.equal(db.gw[0].winner_id, OWNER, 'the owner is not excluded');
    assert.equal(db.gw[0].guild_id, '200000000000000002');
});

test('pick: DM in the winner\'s language with a Claim button, valid 7 days; audit rows for winner + DM', async () => {
    const { db, pool, add } = fakeDb();
    add({ reward_kind: 'kofi_member', reward_amount: 30, reward_text: 'Thanks for playing!' });
    const human = member(HUMAN);
    const r = await GW.pick({ pool, client: clientWith([guild('200000000000000001', [human])]), random: first, now: () => NOW, langOf: async () => 'fr' }, OWNER, { giveawayId: 1 });
    const res = JSON.parse(r.result);
    assert.equal(res.state, 'dm_sent');
    assert.equal(db.gw[0].state, 'dm_sent');
    assert.equal(db.gw[0].expires_at, NOW + 7 * DAY);
    const msg = human.user.sent[0];
    const embed = plain(msg.embeds[0]);
    assert.equal(embed.title, t('fr', 'giveaway.title'));
    assert.match(embed.description, /Abonnement Ko-fi pour 30 jours — Thanks for playing!/);
    assert.match(embed.description, new RegExp('<t:' + Math.floor((NOW + 7 * DAY) / 1000) + ':F>'));
    const btn = plain(plain(msg.components[0]).components[0]);
    assert.equal(btn.customId, 'giveaway_claim_1');
    assert.equal(btn.label, t('fr', 'giveaway.claim'));
    assert.deepEqual(db.audit.map(a => a.action), ['giveaway.winner', 'giveaway.dm']);
    assert.ok(db.audit.every(a => a.actor_role === 'bot'));
    // only once
    const again = await GW.pick({ pool, client: clientWith([guild('200000000000000001', [human])]) }, OWNER, { giveawayId: 1 });
    assert.equal(JSON.parse(again.result).reason, 'notWaiting');
    assert.equal(human.user.sent.length, 1);
});

test('pick: DMs closed -> dm_failed, logged, nothing else breaks (the owner can reroll)', async () => {
    const { db, pool, add } = fakeDb();
    add();
    const human = member(HUMAN, { closed: true });
    const r = await GW.pick({ pool, client: clientWith([guild('200000000000000001', [human])]), random: first, now: () => NOW, langOf: async () => 'en' }, OWNER, { giveawayId: 1 });
    assert.equal(r.state, 'done');
    assert.equal(JSON.parse(r.result).state, 'dm_failed');
    assert.equal(db.gw[0].state, 'dm_failed');
    assert.match(db.gw[0].note, /50007/);
    assert.deepEqual(db.audit.map(a => a.action), ['giveaway.winner', 'giveaway.dm_failed']);
});

test('pick: member request fails -> cached members are used; no server at all -> no_member', async () => {
    const { db, pool, add } = fakeDb();
    add(); add();
    const cached = member(HUMAN);
    const g = guild('200000000000000001', [], { listFails: true, cache: [cached, member('300000000000000001', { bot: true })] });
    await GW.pick({ pool, client: clientWith([g]), random: first, now: () => NOW, langOf: async () => 'en' }, OWNER, { giveawayId: 1 });
    assert.equal(db.gw[0].winner_id, HUMAN);
    const r = await GW.pick({ pool, client: clientWith([]), random: first, now: () => NOW }, OWNER, { giveawayId: 2 });
    assert.equal(JSON.parse(r.result).state, 'no_member');
    assert.equal(db.gw[1].state, 'no_member');
    assert.ok(db.audit.some(a => a.action === 'giveaway.no_member'));
});

// ---------- claim ----------
function click(id, userId) {
    const out = { replies: [], updates: [] };
    return Object.assign(out, {
        customId: 'giveaway_claim_' + id, user: { id: userId }, locale: 'en-US',
        async reply(m) { out.replies.push(m); return m; }, async update(m) { out.updates.push(m); return m; }
    });
}
const deps = (pool, now = NOW) => ({ pool, now: () => now, langOf: async () => 'en' });

test('claim: once only; preset points are added with the same Dev page command (points_add in command_queue)', async () => {
    const { db, pool, add } = fakeDb();
    add({ state: 'dm_sent', winner_id: HUMAN, reward_kind: 'points', reward_amount: 25, expires_at: NOW + 7 * DAY });
    const c = click(1, HUMAN);
    await GW.handleClaim(c, deps(pool, NOW + DAY));
    assert.equal(db.gw[0].state, 'claimed');
    assert.equal(c.updates[0].content, t('en', 'giveaway.claimedAuto'));
    assert.equal(db.queue.length, 1);
    assert.equal(db.queue[0].action, 'points_add');
    assert.deepEqual(JSON.parse(db.queue[0].args), { id: HUMAN, amount: 25 });
    assert.equal(db.queue[0].requested_by, OWNER);
    const claimedAudit = db.audit.find(a => a.action === 'giveaway.claimed');
    assert.equal(db.queue[0].audit_id, claimedAudit.id, 'the command\'s before / after goes into the claim audit row');
    assert.equal(db.gw[0].grant_queue_id, 1);
    assert.equal(Q.toConsoleLine('points_add', JSON.parse(db.queue[0].args)), 'points add ' + HUMAN + ' 25', 'the normal console command');
    // second click
    const c2 = click(1, HUMAN);
    await GW.handleClaim(c2, deps(pool, NOW + DAY));
    assert.equal(c2.replies[0].content, t('en', 'giveaway.already'));
    assert.equal(db.queue.length, 1, 'never granted twice');
    assert.equal(db.audit.filter(a => a.action === 'giveaway.claimed').length, 1);
});

test('claim: Ko-fi member days -> kofi_member; manual reward -> nothing queued', async () => {
    const { db, pool, add } = fakeDb();
    add({ state: 'dm_sent', winner_id: HUMAN, reward_kind: 'kofi_member', reward_amount: 30, expires_at: NOW + 7 * DAY });
    add({ state: 'dm_sent', winner_id: HUMAN, reward_kind: 'manual', reward_amount: 0, expires_at: NOW + 7 * DAY });
    await GW.handleClaim(click(1, HUMAN), deps(pool));
    assert.equal(db.queue[0].action, 'kofi_member');
    assert.deepEqual(JSON.parse(db.queue[0].args), { id: HUMAN, days: 30 });
    const c = click(2, HUMAN);
    await GW.handleClaim(c, deps(pool));
    assert.equal(db.gw[1].state, 'claimed');
    assert.equal(db.queue.length, 1);
    assert.equal(c.updates[0].content, t('en', 'giveaway.claimedManual'));
});

test('claim: someone else, after 7 days, rerolled / unknown', async () => {
    const { db, pool, add } = fakeDb();
    add({ state: 'dm_sent', winner_id: HUMAN, expires_at: NOW + 7 * DAY });
    add({ state: 'rerolled', winner_id: HUMAN, expires_at: NOW + 7 * DAY });
    const other = click(1, OWNER);
    await GW.handleClaim(other, deps(pool));
    assert.equal(other.replies[0].content, t('en', 'giveaway.notYours'));
    assert.equal(db.gw[0].state, 'dm_sent');
    const late = click(1, HUMAN);
    await GW.handleClaim(late, deps(pool, NOW + 7 * DAY + 1));
    assert.equal(late.replies[0].content, t('en', 'giveaway.expired', { days: 7 }));
    assert.equal(db.gw[0].state, 'expired');
    assert.ok(db.audit.some(a => a.action === 'giveaway.expired'));
    const re = click(2, HUMAN);
    await GW.handleClaim(re, deps(pool));
    assert.equal(re.replies[0].content, t('en', 'giveaway.gone'));
    const none = click(99, HUMAN);
    await GW.handleClaim(none, deps(pool));
    assert.equal(none.replies[0].content, t('en', 'giveaway.gone'));
    assert.equal(db.queue.length, 0);
});

test('command queue: giveaway_pick runs with the row\'s requested_by (never a user id from args)', async () => {
    const { db, pool } = fakeDb();
    db.queue.push({ id: 1, action: 'giveaway_pick', args: JSON.stringify({ giveawayId: 5, userId: HUMAN }), state: 'running', requested_by: OWNER });
    let seen = null;
    const out = await Q.runOne(db.queue[0], { giveawayPick: async (uid, args) => { seen = { uid, args }; return { state: 'done', result: '{}' }; } }, pool);
    assert.equal(out.state, 'done');
    assert.deepEqual(seen, { uid: OWNER, args: { giveawayId: 5, userId: HUMAN } });
    assert.equal(Q.toConsoleLine('giveaway_pick', {}), null, 'not a console command');
    assert.equal((await Q.runOne(db.queue[0], {}, pool)).state, 'error');
});

test('giveaway texts exist in all 4 languages; mybot + interactionCreate are wired', () => {
    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en', 'giveaway.json'), 'utf8')));
    for (const l of ['fr', 'de', 'ja']) {
        const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', l, 'giveaway.json'), 'utf8'));
        assert.deepEqual(Object.keys(d).sort(), keys.slice().sort(), l);
    }
    assert.match(fs.readFileSync(path.join(ROOT, 'mybot.js'), 'utf8'), /giveawayPick: \(userId, args\) => require\('\.\/utils\/giveaway'\)\.pick/);
    assert.match(fs.readFileSync(path.join(ROOT, 'events', 'interactionCreate.js'), 'utf8'), /cid\.startsWith\('giveaway_claim_'\)/);
    const fr = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'fr', 'giveaway.json'), 'utf8'));
    const de = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'de', 'giveaway.json'), 'utf8'));
    assert.ok(!/\bvous\b|\bvotre\b/i.test(JSON.stringify(fr)), 'FR uses tu');
    assert.ok(!/\bSie\b|\bIhr\b/.test(JSON.stringify(de)), 'DE uses du');
});
