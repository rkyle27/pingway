// Tests for Pingway news follow (utils/newsFollow.js + events/newsFollow*.js).
// Plain node, no Discord connection and no database (fakes):  node --test test/
'use strict';

const test = require('node:test');
const assert = require('assert');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file; m.loaded = true; m.exports = exports;
    require.cache[file] = m;
}

// ---------- fake database ----------
const rows = new Map(); // guild_id -> row
const pool = {
    async execute(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (/^CREATE TABLE IF NOT EXISTS news_follow/.test(q)) return [[]];
        if (/^SELECT .* FROM news_follow WHERE guild_id = \?/.test(q)) { const r = rows.get(params[0]); return [r ? [{ ...r }] : []]; }
        if (/^SELECT guild_id, channel_id FROM news_follow WHERE status = 'followed'/.test(q)) return [[...rows.values()].filter(r => r.status === 'followed').map(r => ({ ...r }))];
        if (/^SELECT guild_id FROM news_follow WHERE status = 'followed'/.test(q)) return [[...rows.values()].filter(r => r.status === 'followed').map(r => ({ guild_id: r.guild_id }))];
        if (/^INSERT INTO news_follow/.test(q)) {
            const [guild_id, channel_id, webhook_id, followed_at, status] = params;
            rows.set(guild_id, { guild_id, channel_id, webhook_id, followed_at, status });
            return [{ affectedRows: 1 }];
        }
        throw new Error('unexpected SQL: ' + q);
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });

// discord.js stand-in for the event files if not installed
function canLoad(n) { try { require.resolve(n); return true; } catch (e) { return false; } }
if (!canLoad('discord.js')) {
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (req, ...rest) { return req === 'discord.js' ? 'shim:discord.js' : orig.call(this, req, ...rest); };
    inject('shim:discord.js', { Events: { GuildCreate: 'guildCreate', GuildUpdate: 'guildUpdate', ClientReady: 'clientReady', ChannelUpdate: 'channelUpdate', GuildRoleUpdate: 'roleUpdate', GuildMemberUpdate: 'guildMemberUpdate' } });
}

const NF = require('../utils/newsFollow');
const SRC = NF.NEWS_CHANNEL_ID;
console.log = () => {}; // keep test output quiet

// ---------- fake Discord ----------
let hookSeq = 100;
function makeWorld() {
    const deleted = [];
    const follows = [];
    const channelsById = new Map();
    const source = {
        id: SRC,
        async addFollower(target, reason) {
            follows.push({ target: target.id, reason });
            target.hooks.push({ id: String(hookSeq++), type: 2, sourceChannel: { id: SRC } });
            return source; // discord.js v14 returns the channel itself
        }
    };
    const client = {
        guilds: { cache: new Map() },
        channels: { async fetch(id) { if (id === SRC) return source; throw new Error('Unknown Channel'); } },
        async deleteWebhook(id) {
            deleted.push(id);
            for (const ch of channelsById.values()) ch.hooks = ch.hooks.filter(h => h.id !== id);
        }
    };
    function makeChannel(id, { perms = true } = {}) {
        const ch = {
            id, name: 'updates-' + id, hooks: [], perms,
            permissionsFor() { return { has: (list) => ch.perms && list.includes('ViewChannel') && list.includes('ManageWebhooks') }; },
            async fetchWebhooks() { if (!ch.perms) throw new Error('Missing Permissions'); return new Map(ch.hooks.map(h => [h.id, h])); }
        };
        channelsById.set(id, ch);
        return ch;
    }
    function makeGuild(id, channel) {
        const g = {
            id, client, publicUpdatesChannelId: channel ? channel.id : null,
            members: { me: { id: 'me' } },
            channels: { cache: { get: (cid) => channelsById.get(cid) }, async fetch(cid) { const c = channelsById.get(cid); if (!c) throw new Error('Unknown Channel'); return c; } }
        };
        client.guilds.cache.set(id, g);
        return g;
    }
    return { client, source, deleted, follows, makeChannel, makeGuild };
}

test.beforeEach(() => { rows.clear(); NF._resetForTests(); });

test('follows when perms are ok and saves the row', async () => {
    const w = makeWorld();
    const ch = w.makeChannel('c1');
    const g = w.makeGuild('g1', ch);
    await NF.followGuild(g, { reason: 'joined' });
    assert.strictEqual(w.follows.length, 1);
    assert.strictEqual(w.follows[0].target, 'c1');
    const r = rows.get('g1');
    assert.strictEqual(r.status, 'followed');
    assert.strictEqual(r.channel_id, 'c1');
    assert.strictEqual(r.webhook_id, ch.hooks[0].id);
});

test('accepts a plain string reason too', async () => {
    const w = makeWorld();
    const g = w.makeGuild('g1', w.makeChannel('c1'));
    await NF.followGuild(g, 'joined');
    assert.strictEqual(rows.get('g1').status, 'followed');
});

test('skips without perms: no followed row, no throw, retries later', async () => {
    const w = makeWorld();
    const ch = w.makeChannel('c1', { perms: false });
    const g = w.makeGuild('g1', ch);
    await NF.followGuild(g, 'joined');
    assert.strictEqual(w.follows.length, 0);
    assert.notStrictEqual(rows.get('g1') && rows.get('g1').status, 'followed');
    ch.perms = true; // admin fixes perms
    await NF.followGuild(g, 'update');
    assert.strictEqual(w.follows.length, 1);
    assert.strictEqual(rows.get('g1').status, 'followed');
});

test('never re-follows when a followed row exists for the same channel (admin unfollowed)', async () => {
    const w = makeWorld();
    const ch = w.makeChannel('c1');
    const g = w.makeGuild('g1', ch);
    await NF.followGuild(g, 'joined');
    ch.hooks = []; // admin removed the follow
    await NF.followGuild(g, 'update');
    await NF.followAllOnce(w.client, { gapMs: 0 });
    assert.strictEqual(w.follows.length, 1);
    assert.strictEqual(ch.hooks.length, 0);
});

test('channel change deletes the old webhook and follows the new channel', async () => {
    const w = makeWorld();
    const c1 = w.makeChannel('c1');
    const c2 = w.makeChannel('c2');
    const g = w.makeGuild('g1', c1);
    await NF.followGuild(g, 'joined');
    const oldHook = rows.get('g1').webhook_id;
    g.publicUpdatesChannelId = 'c2';
    await NF.followGuild(g, 'changed');
    assert.deepStrictEqual(w.deleted, [oldHook]);
    assert.strictEqual(w.follows.length, 2);
    assert.strictEqual(w.follows[1].target, 'c2');
    assert.strictEqual(rows.get('g1').channel_id, 'c2');
    assert.strictEqual(rows.get('g1').webhook_id, c2.hooks[0].id);
    assert.strictEqual(c1.hooks.length, 0);
});

test('channel change: a missing old webhook is ignored', async () => {
    const w = makeWorld();
    const c2 = w.makeChannel('c2');
    const g = w.makeGuild('g1', c2);
    rows.set('g1', { guild_id: 'g1', channel_id: 'c1', webhook_id: '999', followed_at: 1, status: 'followed' });
    w.client.deleteWebhook = async () => { throw new Error('Unknown Webhook'); };
    await NF.followGuild(g, 'changed');
    assert.strictEqual(w.follows.length, 1);
    assert.strictEqual(rows.get('g1').channel_id, 'c2');
});

test('existing follower webhook is detected: no duplicate', async () => {
    const w = makeWorld();
    const ch = w.makeChannel('c1');
    ch.hooks.push({ id: '555', type: 2, sourceChannel: { id: SRC } });
    ch.hooks.push({ id: '556', type: 2, sourceChannel: { id: 'other-news' } });
    const g = w.makeGuild('g1', ch);
    await NF.followGuild(g, 'joined');
    assert.strictEqual(w.follows.length, 0);
    assert.strictEqual(rows.get('g1').status, 'followed');
    assert.strictEqual(rows.get('g1').webhook_id, '555');
});

test('no community channel: nothing recorded, nothing followed', async () => {
    const w = makeWorld();
    const g = w.makeGuild('g1', null);
    await NF.followGuild(g, 'joined');
    assert.strictEqual(w.follows.length, 0);
    assert.strictEqual(rows.size, 0);
});

test('followAllOnce spaces calls and survives one guild throwing', async () => {
    const w = makeWorld();
    const times = [];
    const orig = w.source.addFollower;
    w.source.addFollower = async (t, r) => { times.push(Date.now()); return orig(t, r); };
    w.makeGuild('g1', w.makeChannel('c1'));
    const bad = w.makeGuild('g2', w.makeChannel('c2'));
    bad.channels = { get cache() { throw new Error('boom'); } };
    w.makeGuild('g3', w.makeChannel('c3'));
    w.makeGuild('g4', null); // no community channel: skipped
    rows.set('g5', { guild_id: 'g5', channel_id: 'c5', webhook_id: '1', followed_at: 1, status: 'followed' });
    w.makeGuild('g5', w.makeChannel('c5')); // already followed: skipped
    await NF.followAllOnce(w.client, { gapMs: 80 });
    assert.strictEqual(w.follows.length, 2);
    assert.deepStrictEqual(w.follows.map(f => f.target), ['c1', 'c3']);
    assert.ok(times[1] - times[0] >= 150, 'two gaps between g1 and g3 (g2 in the middle)');
    assert.strictEqual(rows.get('g2'), undefined);
});

test('followAllOnce never throws even if the database fails', async () => {
    const w = makeWorld();
    const saved = pool.execute;
    pool.execute = async () => { throw new Error('db down'); };
    try { await NF.followAllOnce(w.client, { gapMs: 0 }); await NF.followGuild(w.makeGuild('g1', w.makeChannel('c1')), 'x'); }
    finally { pool.execute = saved; }
});

test('events: guildCreate / guildUpdate / clientReady are wired', async () => {
    const join = require('../events/newsFollowJoin');
    const upd = require('../events/newsFollowUpdate');
    const start = require('../events/newsFollowStart');
    assert.strictEqual(String(join.name), 'guildCreate');
    assert.strictEqual(String(upd.name), 'guildUpdate');
    assert.strictEqual(String(start.name), 'clientReady');
    assert.strictEqual(start.once, true);

    const w = makeWorld();
    const c1 = w.makeChannel('c1');
    const g = w.makeGuild('g1', c1);
    await upd.execute({ publicUpdatesChannelId: 'c1' }, g); // unchanged: nothing
    assert.strictEqual(w.follows.length, 0);
    await upd.execute({ publicUpdatesChannelId: null }, g); // turned on Community
    assert.strictEqual(w.follows.length, 1);
    const g2 = w.makeGuild('g2', w.makeChannel('c9'));
    await join.execute(g2);
    assert.strictEqual(w.follows.length, 2);
});

// ---------- permission triggers ----------
function countSelects() {
    let n = 0;
    const saved = pool.execute;
    pool.execute = async (sql, p) => { if (/^\s*SELECT/i.test(sql)) n++; return saved(sql, p); };
    return { get n() { return n; }, restore() { pool.execute = saved; } };
}
const roleSet = (ids) => ({ cache: new Map(ids.map(id => [id, { id }])) });

test('perm triggers: skipped server follows as soon as perms are fixed; debounced 10s', async () => {
    const ch = require('../events/newsFollowChannelPerms');
    assert.strictEqual(String(ch.name), 'channelUpdate');
    const w = makeWorld();
    const c1 = w.makeChannel('c1', { perms: false });
    const g = w.makeGuild('g1', c1);
    c1.guild = g;
    await NF.followGuild(g, 'joined');
    assert.strictEqual(rows.get('g1').status, 'skipped');
    c1.perms = true;
    await ch.execute(c1, c1);
    assert.strictEqual(w.follows.length, 1);
    assert.strictEqual(rows.get('g1').status, 'followed');
    // other channels in the server are ignored
    const other = w.makeChannel('x1'); other.guild = g;
    assert.strictEqual(await NF.retryIfNotFollowed(g, 't'), false);
    await ch.execute(other, other);
    assert.strictEqual(w.follows.length, 1);
});

test('perm triggers: debounce ignores repeat triggers for the same guild within 10s', async () => {
    const w = makeWorld();
    const c1 = w.makeChannel('c1', { perms: false });
    const g = w.makeGuild('g1', c1);
    const t0 = 1_000_000;
    assert.strictEqual(await NF.retryIfNotFollowed(g, 'a', { now: t0 }), true);
    c1.perms = true;
    assert.strictEqual(await NF.retryIfNotFollowed(g, 'b', { now: t0 + 5000 }), false);
    assert.strictEqual(w.follows.length, 0);
    assert.strictEqual(await NF.retryIfNotFollowed(g, 'c', { now: t0 + 10001 }), true);
    assert.strictEqual(w.follows.length, 1);
});

test('perm triggers: followed guilds use the in-memory cache (no DB hit, no re-follow)', async () => {
    const w = makeWorld();
    const c1 = w.makeChannel('c1');
    const g = w.makeGuild('g1', c1);
    rows.set('g1', { guild_id: 'g1', channel_id: 'c1', webhook_id: '1', followed_at: 1, status: 'followed' });
    const cnt = countSelects();
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual(await NF.retryIfNotFollowed(g, 'x', { now: i * 20000 }), false);
        assert.strictEqual(cnt.n, 1, 'table read once, then cache');
    } finally { cnt.restore(); }
    assert.strictEqual(w.follows.length, 0);
});

test('perm triggers: a new follow updates the cache', async () => {
    const w = makeWorld();
    const g = w.makeGuild('g1', w.makeChannel('c1'));
    assert.strictEqual(await NF.retryIfNotFollowed(g, 'x', { now: 1 }), true);
    const cnt = countSelects();
    try { assert.strictEqual(await NF.retryIfNotFollowed(g, 'x', { now: 50000 }), false); assert.strictEqual(cnt.n, 0); }
    finally { cnt.restore(); }
    assert.strictEqual(w.follows.length, 1);
});

test('roleUpdate: only the bot\'s own roles trigger a retry', async () => {
    const ev = require('../events/newsFollowRolePerms');
    assert.strictEqual(String(ev.name), 'roleUpdate');
    const w = makeWorld();
    const g = w.makeGuild('g1', w.makeChannel('c1'));
    g.members.me.roles = roleSet(['botrole']);
    await ev.execute({ id: 'other' }, { id: 'other', guild: g });
    assert.strictEqual(w.follows.length, 0);
    await ev.execute({ id: 'botrole' }, { id: 'botrole', guild: g });
    assert.strictEqual(w.follows.length, 1);
});

test('guildMemberUpdate: only the bot, only when roles changed', async () => {
    const ev = require('../events/newsFollowMemberPerms');
    assert.strictEqual(String(ev.name), 'guildMemberUpdate');
    const w = makeWorld();
    w.client.user = { id: 'bot' };
    const g = w.makeGuild('g1', w.makeChannel('c1'));
    const mk = (id, roles) => ({ id, guild: g, roles: roleSet(roles) });
    await ev.execute(mk('someone', ['a']), mk('someone', ['a', 'b']), w.client); // not the bot
    await ev.execute(mk('bot', ['a']), mk('bot', ['a']), w.client);               // roles unchanged
    assert.strictEqual(w.follows.length, 0);
    await ev.execute(mk('bot', ['a']), mk('bot', ['a', 'perms']), w.client);
    assert.strictEqual(w.follows.length, 1);
});

test('perm triggers never throw (db down, no community channel)', async () => {
    const w = makeWorld();
    assert.strictEqual(await NF.retryIfNotFollowed(w.makeGuild('g0', null), 'x'), false);
    const saved = pool.execute;
    pool.execute = async () => { throw new Error('db down'); };
    try { assert.strictEqual(await NF.retryIfNotFollowed(w.makeGuild('g1', w.makeChannel('c1')), 'x'), false); }
    finally { pool.execute = saved; }
});
