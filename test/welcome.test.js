// Tests for welcome cards (utils/welcome.js, commands/welcomehere.js, events/guildMemberAdd.js).
// Plain node, no Discord connection and no database: run with  node test/welcome.test.js
// The database (utils/db.js), Supporter Perks (utils/membership.js) and the card renderer (utils/welcomeCards.js)
// are replaced with fakes. If discord.js / axios are not installed (npm install not run), small stand-ins are used.

const path = require('path');
const Module = require('module');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

// ---------- module fakes ----------
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}

const shims = {};
function canLoad(name) { try { require.resolve(name); return true; } catch (e) { return false; } }
if (!canLoad('discord.js')) {
    const chain = (rec = {}) => new Proxy(rec, {
        get(t, k) {
            if (k === 'toJSON') return () => ({ ...t });
            if (k in t) return t[k];
            return (...args) => {
                if (k === 'setName') t.name = args[0];
                if (k === 'setDescription') t.description = args[0];
                for (const a of args) if (typeof a === 'function') a(chain({}));
                return chain(t);
            };
        }
    });
    shims['discord.js'] = {
        Events: { GuildMemberAdd: 'guildMemberAdd' },
        ChannelType: { GuildText: 0, GuildVoice: 2, GuildAnnouncement: 5 },
        MessageFlags: { Ephemeral: 64 },
        PermissionFlagsBits: { Administrator: 1n << 3n, ManageGuild: 1n << 5n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n, AttachFiles: 1n << 15n },
        AttachmentBuilder: class { constructor(attachment, data) { this.attachment = attachment; this.name = data && data.name; } },
        SlashCommandBuilder: function () { return chain({}); },
        escapeMarkdown: s => String(s).replace(/([*_`~|\\])/g, '\\$1')
    };
}
if (!canLoad('axios')) shims.axios = { get: async () => { throw new Error('no network in tests'); } };
if (Object.keys(shims).length) {
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (shims[request]) return 'shim:' + request;
        return orig.call(this, request, ...rest);
    };
    for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);
    console.log('ℹ️  Using stand-ins for: ' + Object.keys(shims).join(', ') + ' (not installed)');
}
const { PermissionFlagsBits: P, ChannelType } = require('discord.js');

// Fake database
const db = {
    settings: new Map(),   // guildId -> row
    requests: [],          // rows
    queries: [],
    beforeClaim: null      // (id) => {} runs right before a claim (simulates another process)
};
const pool = {
    async execute(sql, params = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        db.queries.push(q);
        if (/^CREATE TABLE/i.test(q)) return [[]];
        if (/^SELECT \* FROM welcome_settings WHERE guild_id = \?/.test(q)) {
            const r = db.settings.get(params[0]);
            return [r ? [{ ...r }] : []];
        }
        if (/^INSERT INTO welcome_settings \(guild_id, enabled, channel_id, updated_by, updated_at\) VALUES \(\?, 1,/.test(q)) {
            const [g, ch, by, at] = params;
            const r = db.settings.get(g) || { guild_id: g, enabled: 0, channel_id: null, message: null, mode: 'default', design: null, perk_owner: null };
            Object.assign(r, { enabled: 1, channel_id: ch, updated_by: by, updated_at: at });
            db.settings.set(g, r);
            return [{ affectedRows: 1 }];
        }
        if (/^INSERT INTO welcome_settings \(guild_id, enabled, updated_by, updated_at\) VALUES \(\?, 0,/.test(q)) {
            const [g, by, at] = params;
            const r = db.settings.get(g) || { guild_id: g, enabled: 0, channel_id: null, message: null, mode: 'default', design: null, perk_owner: null };
            Object.assign(r, { enabled: 0, updated_by: by, updated_at: at });
            db.settings.set(g, r);
            return [{ affectedRows: 1 }];
        }
        if (/^UPDATE welcome_settings SET perk_owner = \? WHERE guild_id = \?/.test(q)) {
            const r = db.settings.get(params[1]);
            if (r) r.perk_owner = params[0];
            return [{ affectedRows: r ? 1 : 0 }];
        }
        if (/^UPDATE welcome_requests SET state = 'failed' WHERE state IN \('pending', 'working'\) AND created_at < \?/.test(q)) {
            let n = 0;
            for (const r of db.requests) if ((r.state === 'pending' || r.state === 'working') && r.created_at < params[0]) { r.state = 'failed'; n++; }
            return [{ affectedRows: n }];
        }
        if (/^SELECT \* FROM welcome_requests WHERE state = 'pending'/.test(q)) {
            return [db.requests.filter(r => r.state === 'pending').sort((a, b) => a.id - b.id).slice(0, 10).map(r => ({ ...r }))];
        }
        if (/^UPDATE welcome_requests SET state = 'working' WHERE id = \? AND state = 'pending'/.test(q)) {
            if (db.beforeClaim) db.beforeClaim(params[0]);
            const r = db.requests.find(x => x.id === params[0]);
            if (r && r.state === 'pending') { r.state = 'working'; return [{ affectedRows: 1 }]; }
            return [{ affectedRows: 0 }];
        }
        if (/^UPDATE welcome_requests SET state = \? WHERE id = \?/.test(q)) {
            const r = db.requests.find(x => x.id === params[1]);
            if (r) r.state = params[0];
            return [{ affectedRows: r ? 1 : 0 }];
        }
        if (/^DELETE FROM welcome_requests WHERE created_at < \?/.test(q)) {
            const before = db.requests.length;
            db.requests = db.requests.filter(r => r.created_at >= params[0]);
            return [{ affectedRows: before - db.requests.length }];
        }
        throw new Error('Fake pool: unexpected SQL: ' + q);
    }
};
inject(path.join(ROOT, 'utils', 'db.js'), { pool });

// Fake Supporter Perks
const perks = { owners: new Set(), sponsors: new Set(), admin: null, adminCalls: [] };
inject(path.join(ROOT, 'utils', 'membership.js'), {
    ownerHasMembership: async id => perks.owners.has(String(id)),
    sponsorHasPerks: async id => !!id && perks.sponsors.has(String(id)),
    findPerksAdmin: async (guild, exclude) => { perks.adminCalls.push([guild.id, exclude]); return perks.admin; }
});

// Fake renderer (records what it was asked to draw)
const DEFAULT_POOL = Array.from({ length: 20 }, (_, i) => 'pw' + String(i + 1).padStart(2, '0'));
const CUSTOM_DESIGNS = ['c20', 'c22', 'c28', 'c30', 'c31', 'c36', 'c37', 'c39', 'c41', 'c42', 'c50', 'f2', 'w3', 'e4', 'a1', 'i1', 'l5', 's3', 'k1', 'k2', 'k4', 'k5'];
const renders = [];
inject(path.join(ROOT, 'utils', 'welcomeCards.js'), {
    DEFAULT_POOL, CUSTOM_DESIGNS, ALL_DESIGNS: [...DEFAULT_POOL, ...CUSTOM_DESIGNS],
    randomDefault: () => DEFAULT_POOL[Math.floor(Math.random() * DEFAULT_POOL.length)],
    renderWelcomeCard: async opts => { renders.push(opts); return Buffer.from('PNG:' + opts.design); }
});

const W = require('../utils/welcome');
const cmd = require('../commands/welcomehere');
const ev = require('../events/guildMemberAdd');

// ---------- fake Discord objects ----------
const ALL = [P.ViewChannel, P.SendMessages, P.AttachFiles];
function makeGuild(id, opts = {}) {
    const guild = {
        id, name: opts.name || 'Test Server', ownerId: opts.ownerId || 'owner1', memberCount: opts.memberCount || 1234,
        client: { user: { id: 'bot' } },
        channels: { cache: new Map() },
        members: { me: { id: 'bot' }, cache: new Map(), fetch: async uid => { const m = guild.members.cache.get(uid); if (!m) throw new Error('Unknown Member'); return m; } }
    };
    return guild;
}
function makeChannel(guild, id, perms = ALL, type = ChannelType.GuildText) {
    const set = new Set(perms);
    const ch = {
        id, name: 'welcome-' + id, type, guild, sent: [],
        permissionsFor: () => ({ has: f => set.has(f) }),
        send: async o => { ch.sent.push(o); return { id: 'm' + ch.sent.length }; }
    };
    guild.channels.cache.set(id, ch);
    return ch;
}
function makeMember(guild, id, opts = {}) {
    const m = {
        id, guild, displayName: opts.name || 'Member ' + id, dms: [],
        user: { id, bot: !!opts.bot, username: 'user' + id },
        displayAvatarURL: () => 'https://example.com/avatar/' + id + '.png', // not Discord's CDN -> no download
        send: async o => { if (opts.dmError) throw opts.dmError; m.dms.push(o); return {}; }
    };
    guild.members.cache.set(id, m);
    return m;
}
function setRow(guildId, row) {
    db.settings.set(guildId, { guild_id: guildId, enabled: 1, channel_id: null, message: null, mode: 'default', design: null, perk_owner: null, updated_by: null, updated_at: 0, ...row });
    W.invalidate(guildId);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function captureLogs() {
    const lines = [];
    const orig = { log: console.log, error: console.error };
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    return { lines, restore: () => Object.assign(console, orig) };
}
function resetPerks() { perks.owners.clear(); perks.sponsors.clear(); perks.admin = null; perks.adminCalls.length = 0; }

// ---------- tests ----------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('perks: server owner has perks -> custom design', async () => {
    resetPerks();
    const g = makeGuild('g-p1', { ownerId: 'own' });
    perks.owners.add('own');
    setRow(g.id, { mode: 'custom', design: 'c20', perk_owner: null });
    const r = await W.resolveDesign(g, await W.getSettings(g.id));
    assert.deepStrictEqual(r, { design: 'c20', custom: true });
});

test('perks: perk_owner (admin who chose it) has perks -> custom design', async () => {
    resetPerks();
    const g = makeGuild('g-p2');
    perks.sponsors.add('adminA');
    setRow(g.id, { mode: 'custom', design: 'k4', perk_owner: 'adminA' });
    const r = await W.resolveDesign(g, await W.getSettings(g.id));
    assert.deepStrictEqual(r, { design: 'k4', custom: true });
    assert.strictEqual(perks.adminCalls.length, 0, 'no need to look for another admin');
});

test('perks: perk_owner lost perks -> moved to another admin, still custom', async () => {
    resetPerks();
    const g = makeGuild('g-p3');
    perks.admin = 'adminB';
    setRow(g.id, { mode: 'custom', design: 'w3', perk_owner: 'adminA' });
    const log = captureLogs();
    let r;
    try { r = await W.resolveDesign(g, await W.getSettings(g.id)); } finally { log.restore(); }
    assert.deepStrictEqual(r, { design: 'w3', custom: true });
    assert.deepStrictEqual(perks.adminCalls[0], ['g-p3', 'adminA']);
    assert.strictEqual(db.settings.get(g.id).perk_owner, 'adminB', 'perk_owner saved');
    assert.ok(log.lines.some(l => l.includes('moved to another admin')), 'logged the move');
});

test('perks: nobody has perks -> random default, saved design kept', async () => {
    resetPerks();
    const g = makeGuild('g-p4');
    setRow(g.id, { mode: 'custom', design: 'c41', perk_owner: 'adminA' });
    const log = captureLogs();
    let r;
    try { r = await W.resolveDesign(g, await W.getSettings(g.id)); } finally { log.restore(); }
    assert.strictEqual(r.custom, false);
    assert.ok(DEFAULT_POOL.includes(r.design), 'default design used: ' + r.design);
    const row = db.settings.get(g.id);
    assert.strictEqual(row.design, 'c41');
    assert.strictEqual(row.mode, 'custom');
    assert.strictEqual(row.perk_owner, 'adminA');
    assert.ok(log.lines.some(l => l.startsWith('💜 [WELCOME]') && l.includes('random default')), 'short log line');
});

test('perks: default mode -> random pw design', async () => {
    resetPerks();
    const g = makeGuild('g-p5');
    setRow(g.id, { mode: 'default', design: 'c20' });
    const r = await W.resolveDesign(g, await W.getSettings(g.id));
    assert.ok(DEFAULT_POOL.includes(r.design));
});

test('join with custom design (owner perks) renders that design and posts with a mention only', async () => {
    resetPerks();
    renders.length = 0;
    const g = makeGuild('g-j1', { ownerId: 'own', name: 'Moogle Club', memberCount: 1500 });
    perks.owners.add('own');
    const ch = makeChannel(g, 'c1');
    setRow(g.id, { channel_id: 'c1', mode: 'custom', design: 'c22', message: 'Hi {user}, welcome to {server}! You are #{count}.' });
    const m = makeMember(g, 'u1', { name: 'Alice' });
    await ev.execute(m);
    assert.strictEqual(ch.sent.length, 1);
    const post = ch.sent[0];
    assert.strictEqual(post.content, '<@u1>');
    assert.deepStrictEqual(post.allowedMentions, { users: ['u1'] });
    assert.strictEqual(post.files.length, 1);
    assert.strictEqual(renders[0].design, 'c22');
    assert.strictEqual(renders[0].message, 'Hi Alice, welcome to Moogle Club! You are #1,500.');
    assert.strictEqual(renders[0].name, 'Alice');
    assert.strictEqual(renders[0].count, 1500);
    assert.strictEqual(renders[0].avatar, null, 'non-CDN avatar is not downloaded');
});

test('placeholders: filled once, default message when NULL', async () => {
    assert.strictEqual(W.fillMessage('{user} | {server} | {count} | {user}', { user: 'Bob', server: 'S', count: 12345 }), 'Bob | S | 12,345 | Bob');
    assert.strictEqual(W.fillMessage(null, { user: 'Bob', server: 'S', count: 1 }), W.DEFAULT_MESSAGE);
    assert.strictEqual(W.DEFAULT_MESSAGE, 'Thank you for joining the server! Have fun and feel at home.');
    assert.strictEqual(W.fillMessage('Hi {user} on {server}', { user: '{server}', server: 'Real' }), 'Hi {server} on Real', 'no double fill');
    assert.strictEqual(W.fillMessage('{unknown} stays', { user: 'a', server: 'b', count: 1 }), '{unknown} stays');
});

test('avatar: only cdn.discordapp.com is fetched', async () => {
    assert.strictEqual(await W.fetchAvatar('https://evil.example/a.png'), null);
    assert.strictEqual(await W.fetchAvatar('http://cdn.discordapp.com/a.png'), null);
    assert.strictEqual(await W.fetchAvatar('not a url'), null);
});

test('bots are skipped', async () => {
    const g = makeGuild('g-b1');
    const ch = makeChannel(g, 'c1');
    setRow(g.id, { channel_id: 'c1' });
    await W.handleJoin(makeMember(g, 'bot2', { bot: true }));
    assert.strictEqual(ch.sent.length, 0);
});

test('disabled server: nothing posted', async () => {
    const g = makeGuild('g-off');
    const ch = makeChannel(g, 'c1');
    setRow(g.id, { channel_id: 'c1', enabled: 0 });
    await W.handleJoin(makeMember(g, 'u1'));
    assert.strictEqual(ch.sent.length, 0);
});

test('missing permissions: skipped quietly, logged once per hour', async () => {
    const g = makeGuild('g-perm', { name: 'NoAttach' });
    const ch = makeChannel(g, 'c1', [P.ViewChannel, P.SendMessages]);
    setRow(g.id, { channel_id: 'c1' });
    const log = captureLogs();
    try {
        await W.handleJoin(makeMember(g, 'u1'));
        await W.handleJoin(makeMember(g, 'u2'));
    } finally { log.restore(); }
    assert.strictEqual(ch.sent.length, 0);
    const lines = log.lines.filter(l => l.includes('NoAttach'));
    assert.strictEqual(lines.length, 1, 'one log line: ' + JSON.stringify(log.lines));
    assert.ok(lines[0].startsWith('👋 [WELCOME]') && lines[0].includes('Attach Files'));
});

test('rate limit: 5 joins in the window -> 3 cards + 1 combined text with 2 mentions', async () => {
    const saved = W.LIMITS.windowMs;
    W.LIMITS.windowMs = 300;
    try {
        const g = makeGuild('g-raid');
        const ch = makeChannel(g, 'c1');
        setRow(g.id, { channel_id: 'c1' });
        const log = captureLogs();
        try {
            for (let i = 1; i <= 5; i++) await ev.execute(makeMember(g, 'r' + i));
            assert.strictEqual(ch.sent.length, 3, 'three cards right away');
            assert.ok(ch.sent.every(s => s.files && s.files.length === 1));
            await sleep(450);
        } finally { log.restore(); }
        assert.strictEqual(ch.sent.length, 4, 'plus one combined message');
        const last = ch.sent[3];
        assert.strictEqual(last.content, 'Welcome <@r4> and <@r5>! 🎉');
        assert.ok(!last.files, 'no image');
        assert.deepStrictEqual(last.allowedMentions, { users: ['r4', 'r5'] });
        // after the window: cards again
        await ev.execute(makeMember(g, 'r6'));
        assert.strictEqual(ch.sent.length, 5);
        assert.strictEqual(ch.sent[4].content, '<@r6>');
    } finally { W.LIMITS.windowMs = saved; }
});

test('rate limit: combined message mentions at most 10 and says "N more"', async () => {
    const saved = W.LIMITS.windowMs;
    W.LIMITS.windowMs = 300;
    try {
        const g = makeGuild('g-raid2');
        const ch = makeChannel(g, 'c1');
        setRow(g.id, { channel_id: 'c1' });
        const log = captureLogs();
        try {
            for (let i = 1; i <= 16; i++) await W.handleJoin(makeMember(g, 'x' + i));
            await sleep(450);
        } finally { log.restore(); }
        assert.strictEqual(ch.sent.length, 4);
        const last = ch.sent[3];
        assert.ok(last.content.startsWith('Welcome <@x4>, <@x5>,'));
        assert.ok(last.content.endsWith(', <@x13> and 3 more! 🎉'), last.content);
        assert.strictEqual(last.allowedMentions.users.length, 10);
    } finally { W.LIMITS.windowMs = saved; }
});

test('requests: claimed once; sent / dm_closed / failed; old rows deleted', async () => {
    renders.length = 0;
    const now = Date.now();
    const g = makeGuild('g-req', { name: 'Test *Server*', memberCount: 77 });
    const ok = makeMember(g, 'adm1', { name: 'Admin One' });
    makeMember(g, 'adm2', { dmError: Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }) });
    makeMember(g, 'adm3', { dmError: new Error('boom') });
    const client = { guilds: { cache: new Map([[g.id, g]]) } };
    db.requests = [
        { id: 1, guild_id: g.id, user_id: 'adm1', kind: 'test', design: 'c22', message: 'Yo {user} at {server} ({count})', state: 'pending', created_at: now },
        { id: 2, guild_id: g.id, user_id: 'adm2', kind: 'test', design: 'pw03', message: null, state: 'pending', created_at: now },
        { id: 3, guild_id: g.id, user_id: 'adm3', kind: 'test', design: 'a1', message: null, state: 'pending', created_at: now },
        { id: 4, guild_id: g.id, user_id: 'adm1', kind: 'test', design: 'zz9', message: null, state: 'pending', created_at: now },
        { id: 5, guild_id: g.id, user_id: 'adm1', kind: 'test', design: 'c20', message: 'x'.repeat(301), state: 'pending', created_at: now },
        { id: 6, guild_id: g.id, user_id: 'adm1', kind: 'test', design: 'c20', message: null, state: 'pending', created_at: now },
        { id: 7, guild_id: 'gone', user_id: 'adm1', kind: 'test', design: 'c20', message: null, state: 'pending', created_at: now },
        { id: 8, guild_id: g.id, user_id: 'adm1', kind: 'test', design: 'c20', message: null, state: 'sent', created_at: now - 2 * 24 * 3600 * 1000 },
        { id: 9, guild_id: g.id, user_id: 'nobody', kind: 'test', design: 'c20', message: null, state: 'pending', created_at: now }
    ];
    // Another bot process grabs row 6 between our SELECT and our claim
    db.beforeClaim = id => { if (id === 6) db.requests.find(r => r.id === 6).state = 'working'; };
    const log = captureLogs();
    try { await W.poll(client); } finally { log.restore(); db.beforeClaim = null; }
    const state = id => (db.requests.find(r => r.id === id) || {}).state;
    assert.strictEqual(state(1), 'sent');
    assert.strictEqual(state(2), 'dm_closed');
    assert.strictEqual(state(3), 'failed');
    assert.strictEqual(state(4), 'failed', 'invalid design');
    assert.strictEqual(state(5), 'failed', 'message too long');
    assert.strictEqual(state(6), 'working', 'claimed by someone else: not touched');
    assert.strictEqual(state(7), 'failed', 'unknown server');
    assert.strictEqual(state(8), undefined, 'older than 1 day: deleted');
    assert.strictEqual(state(9), 'failed', 'not a member');
    assert.strictEqual(ok.dms.length, 1, 'only one DM to adm1 (rows 4,5,6 not sent)');
    assert.strictEqual(ok.dms[0].content, 'Here\'s a test of your welcome card for **Test \\*Server\\*** (design: Cozy Café).');
    assert.strictEqual(ok.dms[0].files.length, 1);
    const r1 = renders.find(r => r.design === 'c22');
    assert.strictEqual(r1.message, 'Yo Admin One at Test *Server* (77)');
    assert.strictEqual(r1.name, 'Admin One');
    assert.strictEqual(r1.count, 77);
    // A second poll does nothing new
    const before = ok.dms.length;
    await W.poll(client);
    assert.strictEqual(ok.dms.length, before);
});

test('requests: pending rows older than 10 minutes are dropped (bot was offline)', async () => {
    const g = makeGuild('g-req2');
    const m = makeMember(g, 'a1');
    const client = { guilds: { cache: new Map([[g.id, g]]) } };
    db.requests = [{ id: 20, guild_id: g.id, user_id: 'a1', kind: 'test', design: 'c20', message: null, state: 'pending', created_at: Date.now() - 11 * 60 * 1000 }];
    await W.poll(client);
    assert.strictEqual(db.requests[0].state, 'failed');
    assert.strictEqual(m.dms.length, 0);
});

// /welcomehere
function makeInteraction(guild, channel, member, { admin = true, action = null } = {}) {
    const it = {
        commandName: 'welcomehere', guild, guildId: guild.id, channel, channelId: channel.id, user: { id: member.id }, member,
        memberPermissions: { has: f => admin && f === P.Administrator },
        options: { getString: name => (name === 'action' ? action : null) },
        inGuild: () => true,
        calls: [],
        reply: async o => { it.calls.push(['reply', o]); },
        deferReply: async o => { it.calls.push(['defer', o]); },
        editReply: async o => { it.calls.push(['edit', o]); }
    };
    return it;
}
const EPH = 64;
const isEphemeral = o => Array.isArray(o.flags) ? o.flags.includes(EPH) : (o.flags === EPH);

test('/welcomehere: command data', async () => {
    const json = typeof cmd.data.toJSON === 'function' ? cmd.data.toJSON() : cmd.data;
    assert.strictEqual(json.name, 'welcomehere');
    assert.strictEqual(typeof cmd.execute, 'function');
});

test('/welcomehere set: saves channel, keeps design/message, clears cache, preview attached', async () => {
    resetPerks();
    renders.length = 0;
    const g = makeGuild('g-cmd1', { ownerId: 'own' });
    perks.owners.add('own');
    const ch = makeChannel(g, 'chan9');
    setRow(g.id, { enabled: 0, channel_id: 'old', mode: 'custom', design: 'c41', message: 'Hello {user}!' });
    await W.getSettings(g.id); // cached (enabled 0)
    const m = makeMember(g, 'adminX', { name: 'Alice' });
    const it = makeInteraction(g, ch, m);
    await cmd.execute(it);
    const row = db.settings.get(g.id);
    assert.strictEqual(row.enabled, 1);
    assert.strictEqual(row.channel_id, 'chan9');
    assert.strictEqual(row.updated_by, 'adminX');
    assert.ok(row.updated_at > 0);
    assert.strictEqual(row.mode, 'custom');
    assert.strictEqual(row.design, 'c41');
    assert.strictEqual(row.message, 'Hello {user}!');
    assert.strictEqual(Number((await W.getSettings(g.id)).enabled), 1, 'cache cleared');
    assert.strictEqual(it.calls[0][0], 'defer');
    assert.ok(isEphemeral(it.calls[0][1]));
    const edit = it.calls.find(c => c[0] === 'edit')[1];
    assert.ok(edit.content.includes('Welcome cards will be posted in <#chan9>. Change the design and message on the Pingway website (server settings → Welcome).'));
    assert.strictEqual(edit.files.length, 1);
    assert.strictEqual(renders[0].design, 'c41');
    assert.strictEqual(renders[0].message, 'Hello Alice!');
    assert.strictEqual(ch.sent.length, 0, 'nothing posted in the channel');
});

test('/welcomehere set on a new server: default random design preview', async () => {
    resetPerks();
    renders.length = 0;
    const g = makeGuild('g-cmd2');
    const ch = makeChannel(g, 'c2', ALL, ChannelType.GuildAnnouncement);
    const it = makeInteraction(g, ch, makeMember(g, 'adm'), { action: 'set' });
    await cmd.execute(it);
    const row = db.settings.get(g.id);
    assert.strictEqual(row.enabled, 1);
    assert.strictEqual(row.mode, 'default');
    assert.ok(DEFAULT_POOL.includes(renders[0].design));
    assert.strictEqual(renders[0].message, W.DEFAULT_MESSAGE);
});

test('/welcomehere off', async () => {
    const g = makeGuild('g-cmd3');
    const ch = makeChannel(g, 'c3');
    setRow(g.id, { enabled: 1, channel_id: 'c3', mode: 'custom', design: 'k1' });
    const it = makeInteraction(g, ch, makeMember(g, 'adm'), { action: 'off' });
    await cmd.execute(it);
    const row = db.settings.get(g.id);
    assert.strictEqual(row.enabled, 0);
    assert.strictEqual(row.design, 'k1', 'design kept');
    assert.strictEqual(it.calls.length, 1);
    assert.strictEqual(it.calls[0][0], 'reply');
    assert.ok(isEphemeral(it.calls[0][1]));
    assert.ok(/turned off/i.test(it.calls[0][1].content));
});

test('/welcomehere: non-admin is refused, nothing saved', async () => {
    const g = makeGuild('g-cmd4');
    const ch = makeChannel(g, 'c4');
    const it = makeInteraction(g, ch, makeMember(g, 'pleb'), { admin: false });
    await cmd.execute(it);
    assert.strictEqual(db.settings.has(g.id), false);
    assert.strictEqual(it.calls.length, 1);
    assert.ok(isEphemeral(it.calls[0][1]));
    assert.ok(/admin/i.test(it.calls[0][1].content));
});

test('/welcomehere: channel without permissions explains what is missing', async () => {
    const g = makeGuild('g-cmd5');
    const ch = makeChannel(g, 'c5', [P.ViewChannel]);
    const it = makeInteraction(g, ch, makeMember(g, 'adm'));
    await cmd.execute(it);
    assert.strictEqual(db.settings.has(g.id), false);
    assert.strictEqual(it.calls.length, 1);
    assert.strictEqual(it.calls[0][0], 'reply');
    const text = it.calls[0][1].content;
    assert.ok(text.includes('Send Messages') && text.includes('Attach Files') && !text.includes('View Channel'), text);
});

test('/welcomehere: voice channel is refused', async () => {
    const g = makeGuild('g-cmd6');
    const ch = makeChannel(g, 'c6', ALL, ChannelType.GuildVoice);
    const it = makeInteraction(g, ch, makeMember(g, 'adm'));
    await cmd.execute(it);
    assert.strictEqual(db.settings.has(g.id), false);
    assert.ok(/text or announcement channel/.test(it.calls[0][1].content));
});

// ---------- v2.2: several designs ticked (Default + custom), random pick from the ticked ones ----------
test('designs: older rows keep exactly what they had (custom design -> just that one, else Default)', async () => {
    assert.deepStrictEqual(W.selectedDesigns({ mode: 'custom', design: 'k1' }), ['k1']);
    assert.deepStrictEqual(W.selectedDesigns({ mode: 'default', design: null }), ['default']);
    assert.deepStrictEqual(W.selectedDesigns({ mode: 'custom', design: 'k1', designs: null }), ['k1']);
    assert.deepStrictEqual(W.selectedDesigns({}), ['default']);
    // new rows: the JSON list wins; unknown ids and pw ids are dropped; never empty
    assert.deepStrictEqual(W.selectedDesigns({ mode: 'custom', design: 'k1', designs: '["default","c20","zz","pw03","c20"]' }), ['default', 'c20']);
    assert.deepStrictEqual(W.selectedDesigns({ designs: '[]' }), ['default']);
    assert.deepStrictEqual(W.selectedDesigns({ designs: 'not json', mode: 'custom', design: 'w3' }), ['w3']);
});

test('designs: the pick is random but only from the ticked ones (Default = a random bunny card)', async () => {
    resetPerks();
    const g = makeGuild('g-multi', { ownerId: 'own' });
    perks.owners.add('own');
    setRow(g.id, { mode: 'custom', design: 'k1', designs: JSON.stringify(['default', 'k1', 'c20']) });
    const settings = await W.getSettings(g.id);
    const seen = new Set();
    for (const r of [0, 0.34, 0.5, 0.7, 0.99]) {
        const out = await W.resolveDesign(g, settings, () => r);
        seen.add(out.custom ? out.design : 'default');
        if (!out.custom) assert.ok(DEFAULT_POOL.includes(out.design), out.design);
    }
    assert.deepStrictEqual([...seen].sort(), ['c20', 'default', 'k1']);
    // many real random picks never leave the ticked set
    for (let i = 0; i < 200; i++) {
        const out = await W.resolveDesign(g, settings);
        assert.ok(out.custom ? ['k1', 'c20'].includes(out.design) : DEFAULT_POOL.includes(out.design), out.design);
    }
});

test('designs: Supporter Perks ended -> customs are skipped, Default (if ticked) is used; only customs -> random default', async () => {
    resetPerks();
    const g = makeGuild('g-multi2');
    setRow(g.id, { mode: 'custom', design: 'k1', designs: JSON.stringify(['default', 'k1']), perk_owner: 'gone' });
    const log = captureLogs();
    try {
        for (const r of [0, 0.99]) {
            const out = await W.resolveDesign(g, await W.getSettings(g.id), () => r);
            assert.strictEqual(out.custom, false);
            assert.ok(DEFAULT_POOL.includes(out.design));
        }
        setRow(g.id, { mode: 'custom', design: 'k1', designs: JSON.stringify(['k1', 'c20']), perk_owner: 'gone' });
        const out = await W.resolveDesign(g, await W.getSettings(g.id), () => 0.99);
        assert.deepStrictEqual(out.custom, false);
        assert.ok(DEFAULT_POOL.includes(out.design));
    } finally { log.restore(); }
    // only Default ticked: perks are never looked up
    perks.adminCalls.length = 0;
    setRow(g.id, { designs: JSON.stringify(['default']) });
    await W.resolveDesign(g, await W.getSettings(g.id));
    assert.strictEqual(perks.adminCalls.length, 0);
});

test('Server language card: the welcome text follows the server language picked on the website', async () => {
    resetPerks();
    const guildLanguage = require('../utils/guildLanguage');
    const g = makeGuild('g-lang');
    g.preferredLocale = 'en-US';
    const ch = makeChannel(g, 'cl1');
    setRow(g.id, { channel_id: 'cl1', message: null });
    renders.length = 0;
    const realGet = guildLanguage.get;
    guildLanguage.get = id => (id === 'g-lang' ? 'de' : null);
    try {
        await W.handleJoin(makeMember(g, 'newL'));
    } finally { guildLanguage.get = realGet; }
    assert.strictEqual(ch.sent.length, 1);
    const { t } = require('../utils/i18n');
    assert.strictEqual(renders[renders.length - 1].message, t('de', 'welcome.defaultMessage'));
    // without the override: the server's Discord language
    renders.length = 0;
    await W.handleJoin(makeMember(g, 'newL2'));
    assert.strictEqual(renders[renders.length - 1].message, t('en', 'welcome.defaultMessage'));
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log('✅ ' + t.name);
        } catch (err) {
            failed++;
            console.log('❌ ' + t.name + '\n   ' + (err && err.stack || err).toString().split('\n').slice(0, 4).join('\n   '));
        }
    }
    console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
