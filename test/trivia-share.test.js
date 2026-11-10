// Website Trivia "Share" box -> command_queue 'trivia_share' -> utils/triviaShare.js (posts with T.shareLine).
// In-memory database and fake Discord (test/fixtures/trivia-env.js). No network.   node --test test/trivia-share.test.js
'use strict';

const env = require('./fixtures/trivia-env').setup();
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = env.ROOT;
const W = require(path.join(ROOT, 'utils', 'triviaWords'));
const T = require(path.join(ROOT, 'utils', 'trivia'));
const S = require(path.join(ROOT, 'utils', 'triviaShare'));
const Q = require(path.join(ROOT, 'utils', 'commandQueue'));

const USER = '444444444444444441';
const OTHER = '444444444444444442';
const G1 = '555555555555555551', G2 = '555555555555555552', G3 = '555555555555555553', G4 = '555555555555555554', G5 = '555555555555555555';
const C1 = '666666666666666661', C3 = '666666666666666663', C5 = '666666666666666665';

function reset() {
    for (const k of ['trivia_plays', 'trivia_users', 'trivia_guild', 'trivia_shares', 'trivia_players', 'command_queue']) env.db.tbl(k).length = 0;
}
function solvedToday(userId, diff = 'hard', extra = {}) {
    env.db.tbl('trivia_plays').push(Object.assign({ user_id: userId, day: W.dayOf(), difficulty: diff, status: 'solved', wrong: 2, hints_used: '[1]', revealed: '[0]',
        bits: 6, guild_id: null, started_at: 1, finished_at: 2, shared: 0, hint_round: 0, lang_progress: null }, extra));
    env.db.tbl('trivia_users').push({ user_id: userId, display_name: 'Web name', avatar: null, bits_total: 30, season_key: W.seasonOf(W.dayOf()), season_bits: 12,
        streak: 3, last_solve_day: W.dayOf(), hidden: 0, updated_at: 0 });
}
// Fake Discord: G1 member + channel, G2 not a member, G3 member + channel that throws, G4 Pingway not there, G5 member, no share channel saved
function fakeClient(posts) {
    const channel = (id, fail) => ({ id, send: async p => { if (fail) throw new Error('Missing Permissions'); posts.push({ channel: id, ...p }); } });
    const guild = (id, locale, member, channels) => ({
        id, preferredLocale: locale,
        members: { fetch: async uid => (member && uid === USER ? { displayName: 'Server Nick', user: { id: uid, avatar: null } } : Promise.reject(new Error('Unknown Member'))) },
        channels: { fetch: async cid => channels[cid] || null }
    });
    const guilds = new Map([
        [G1, guild(G1, 'en-US', true, { [C1]: channel(C1) })],
        [G2, guild(G2, 'en-US', false, { [C1]: channel(C1) })],
        [G3, guild(G3, 'fr', true, { [C3]: channel(C3, true) })],
        [G5, guild(G5, 'de', true, { [C5]: channel(C5) })]
    ]);
    return { guilds: { cache: guilds } };
}
const shareChannels = () => {
    for (const [g, c] of [[G1, C1], [G2, C1], [G3, C3], [G4, C1]]) env.db.tbl('trivia_guild').push({ guild_id: g, share_channel_id: c, updated_at: 0 });
};
const parse = out => JSON.parse(out.result);

test('trivia_share: posts the same spoiler-free line as Discord, only where the player is a member with a share channel', async () => {
    await T.ensureTables();
    reset(); solvedToday(USER); shareChannels();
    const posts = [];
    const out = await S.run(fakeClient(posts), USER, { day: W.dayOf(), guildIds: [G1, G2, G3, G4, G5, G1] });
    assert.equal(out.state, 'done');
    const r = parse(out);
    assert.equal(r.day, W.dayOf());
    assert.deepEqual(r.results.map(x => [x.guildId, x.ok, x.reason || x.channelId]), [
        [G1, true, C1], [G2, false, 'notMember'], [G3, false, 'cantPost'], [G4, false, 'noBot'], [G5, false, 'noChannel']]);
    assert.equal(posts.length, 1);
    const play = (await T.dayStatus(USER, W.dayOf())).solved;
    assert.equal(posts[0].content, T.shareLine('Server Nick', 'hard', play, 3, 'en'), 'exactly the Discord post (server language, display name)');
    assert.deepEqual(posts[0].allowedMentions, { parse: [] });
    // one row per shared server; the failed post was taken back
    assert.deepEqual(env.db.tbl('trivia_shares').map(x => x.guild_id), [G1]);
    assert.equal(play.shared, true, "Discord's Share button hides too");
    assert.ok(env.db.tbl('trivia_players').some(p => p.guild_id === G1 && p.user_id === USER), 'shows on that server board');
    // the same server again: not posted twice
    const again = parse(await S.run(fakeClient(posts), USER, { day: W.dayOf(), guildIds: [G1] }));
    assert.deepEqual(again.results, [{ guildId: G1, ok: false, reason: 'already' }]);
    assert.equal(posts.length, 1);
});

test('trivia_share: nothing is posted without a solve today, for another day, or with bad values', async () => {
    reset(); shareChannels();
    const posts = [];
    env.db.tbl('trivia_plays').push({ user_id: USER, day: W.dayOf(), difficulty: 'easy', status: 'gaveup', wrong: 0, hints_used: '[]', revealed: '[]', bits: 0, shared: 0, hint_round: 0, lang_progress: null });
    assert.deepEqual(parse(await S.run(fakeClient(posts), USER, { day: W.dayOf(), guildIds: [G1] })).results, [{ guildId: G1, ok: false, reason: 'notSolved' }]);
    solvedToday(USER, 'normal');
    assert.deepEqual(parse(await S.run(fakeClient(posts), USER, { day: W.addDays(W.dayOf(), -1), guildIds: [G1] })).results, [{ guildId: G1, ok: false, reason: 'day' }]);
    for (const bad of [{}, { day: W.dayOf(), guildIds: [] }, { day: W.dayOf(), guildIds: ['x'] }, { day: W.dayOf(), guildIds: Array.from({ length: 26 }, (_, i) => '5555555555555556' + String(i).padStart(2, '0')) }]) {
        assert.equal((await S.run(fakeClient(posts), USER, bad)).state, 'error');
    }
    assert.equal((await S.run(fakeClient(posts), 'nobody', { day: W.dayOf(), guildIds: [G1] })).state, 'error');
    assert.equal(posts.length, 0);
});

test('command queue: trivia_share always shares the row\'s requested_by (never a user id from args)', async () => {
    reset(); shareChannels(); solvedToday(USER);
    const posts = [];
    const client = fakeClient(posts);
    env.db.tbl('command_queue').push({ id: 7, action: 'trivia_share', requested_by: OTHER, state: 'running' });
    const seen = [];
    const deps = { triviaShare: (uid, args) => { seen.push(uid); return S.run(client, uid, args); }, runLine: () => assert.fail('no console line') };
    const out = await Q.runOne({ id: 7, action: 'trivia_share', args: JSON.stringify({ userId: USER, day: W.dayOf(), guildIds: [G1] }) }, deps, env.db.pool);
    assert.deepEqual(seen, [OTHER]);
    assert.deepEqual(parse(out).results, [{ guildId: G1, ok: false, reason: 'notSolved' }], 'OTHER did not solve: nothing posted for USER');
    assert.equal(posts.length, 0);
    assert.equal(Q.toConsoleLine('trivia_share', {}), null, 'not a console command');
    assert.equal((await Q.runOne({ id: 8, action: 'trivia_share', args: '{}' }, { runLine: () => {} }, env.db.pool)).state, 'error', 'no handler = error');
});

test('Discord Share button records the server too (so the website shows it as shared)', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'commands', 'trivia.js'), 'utf8');
    assert.match(src, /T\.recordShare\(userId, day, guildId, chId\)/);
    const bot = require('fs').readFileSync(path.join(ROOT, 'mybot.js'), 'utf8');
    assert.match(bot, /triviaShare: \(userId, args\) => require\('\.\/utils\/triviaShare'\)\.run\(client, userId, args\)/);
});
