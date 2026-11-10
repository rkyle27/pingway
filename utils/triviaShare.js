// Website Trivia "Share" box (pingway.app → Trivia): the website puts a 'trivia_share' row in command_queue and the bot
// posts the result here, with the SAME spoiler-free line as the Share button of /trivia (T.shareLine, the server's language).
// It is safe for normal users: only the person who asked (command_queue.requested_by, written by the website from the login)
// is shared, only when they solved TODAY (JST), and only in servers where Pingway is, they are really a member
// (checked live with Discord) and an admin picked a Trivia share channel. One post per person, day and server (trivia_shares).
// The website checks all of this before it adds the row too; it is checked here again.
// Result (command_queue.result, JSON): { day, results: [{ guildId, ok, channelId?, reason? }] }
// reason: 'notSolved' | 'noBot' | 'notMember' | 'noChannel' | 'gone' | 'already' | 'cantPost' | 'day'

const T = require('./trivia');
const W = require('./triviaWords');
const userLanguage = require('./userLanguage');

const ID_RE = /^\d{15,22}$/;
const MAX_SERVERS = 25;

/** client = the Discord client, userId = command_queue.requested_by, args = { day, guildIds } -> { state, result } */
async function run(client, userId, args) {
    const a = args && typeof args === 'object' ? args : {};
    const ids = Array.isArray(a.guildIds) ? [...new Set(a.guildIds.map(String))] : [];
    if (!ID_RE.test(String(userId || '')) || !ids.length || ids.length > MAX_SERVERS || !ids.every(id => ID_RE.test(id))) {
        return { state: 'error', result: 'Invalid Trivia share request.' };
    }
    const day = W.dayOf();
    const all = reason => ({ state: 'done', result: JSON.stringify({ day, results: ids.map(guildId => ({ guildId, ok: false, reason })) }) });
    if (a.day !== day) return all('day'); // asked before 0:00 JST, run after: that solve is not "today" any more
    const st = await T.dayStatus(userId, day);
    if (!st.solved) return all('notSolved');
    const u = await T.getUser(userId);
    const results = [];
    for (const guildId of ids) {
        const guild = client && client.guilds && client.guilds.cache.get(guildId);
        if (!guild) { results.push({ guildId, ok: false, reason: 'noBot' }); continue; }
        const member = await guild.members.fetch(String(userId)).catch(() => null);
        if (!member) { results.push({ guildId, ok: false, reason: 'notMember' }); continue; }
        const chId = await T.shareChannel(guildId);
        if (!chId) { results.push({ guildId, ok: false, reason: 'noChannel' }); continue; }
        const channel = await guild.channels.fetch(chId).catch(() => null);
        if (!channel || typeof channel.send !== 'function') { results.push({ guildId, ok: false, reason: 'gone' }); continue; }
        if (!(await T.recordShare(userId, day, guildId, chId))) { results.push({ guildId, ok: false, reason: 'already' }); continue; }
        const name = member.displayName || (member.user && (member.user.globalName || member.user.username)) || 'Player';
        try {
            await channel.send({ content: T.shareLine(name, st.solved.difficulty, st.solved, W.liveStreak(u, day), userLanguage.forGuild(guild)), allowedMentions: { parse: [] } });
        } catch (err) {
            await T.recordShare(userId, day, guildId, chId, true).catch(() => {});
            results.push({ guildId, ok: false, reason: 'cantPost' });
            continue;
        }
        // A real member who shared there: they show on that server's Trivia leaderboard (like playing /trivia there)
        await T.touchPlayer({ userId, guildId, displayName: name, avatar: member.user && member.user.avatar }).catch(() => {});
        results.push({ guildId, ok: true, channelId: chId });
    }
    if (results.some(r => r.ok)) await T.markShared(userId, day, st.solved.difficulty).catch(() => {}); // Discord's Share button hides too
    return { state: 'done', result: JSON.stringify({ day, results }) };
}

module.exports = { run, MAX_SERVERS };
