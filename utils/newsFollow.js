// Pingway news follow: like Dyno's "#dyno-updates", Pingway follows its Help Desk announcement channel
// (#pingway-news) into each server's Community Updates channel (guild.publicUpdatesChannelId).
// - Follows once per server + channel. If an admin unfollows later, Pingway never adds it back.
// - If the Community Updates channel changes, the old follower webhook Pingway made is removed and the new channel is followed.
// - Needs View Channel + Manage Webhooks in the target channel; if missing it only logs and tries again on the next trigger.
// - Never throws to callers.
'use strict';

const { pool } = require('./db');

const NEWS_CHANNEL_ID = process.env.PINGWAY_NEWS_CHANNEL_ID || '1531221250565996617';
const WEBHOOK_TYPE_CHANNEL_FOLLOWER = 2; // discord.js WebhookType.ChannelFollower
const NEEDED_PERMS = ['ViewChannel', 'ManageWebhooks'];
const GAP_MS = 1500;

const short = (err) => (err && (err.message || err.code)) || String(err);
const log = (msg) => console.log('📰 [NEWS FOLLOW] ' + msg);

let tableReady = false;
async function ensureTable() {
    if (tableReady) return;
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS news_follow (
            guild_id VARCHAR(20) PRIMARY KEY,
            channel_id VARCHAR(20) NOT NULL,
            webhook_id VARCHAR(20) NULL,
            followed_at BIGINT NOT NULL,
            status VARCHAR(16) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    tableReady = true;
}

async function getRow(guildId) {
    const [rows] = await pool.execute('SELECT guild_id, channel_id, webhook_id, followed_at, status FROM news_follow WHERE guild_id = ?', [guildId]);
    return rows[0] || null;
}

// In-memory set of guild ids with a 'followed' row, so the permission triggers don't hit the DB every time.
let followedIds = null;
let followedLoading = null;
async function loadFollowed() {
    if (followedIds) return followedIds;
    if (!followedLoading) {
        followedLoading = (async () => {
            await ensureTable();
            const [rows] = await pool.execute("SELECT guild_id FROM news_follow WHERE status = 'followed'");
            followedIds = new Set(rows.map(r => r.guild_id));
            return followedIds;
        })().finally(() => { followedLoading = null; });
    }
    return followedLoading;
}

async function saveRow(guildId, channelId, webhookId, status) {
    await pool.execute(
        'INSERT INTO news_follow (guild_id, channel_id, webhook_id, followed_at, status) VALUES (?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), webhook_id = VALUES(webhook_id), followed_at = VALUES(followed_at), status = VALUES(status)',
        [guildId, channelId, webhookId || null, Date.now(), status]
    );
    if (followedIds) { if (status === 'followed') followedIds.add(guildId); else followedIds.delete(guildId); }
}

function findFollowerHook(hooks, sourceId) {
    if (!hooks) return null;
    const list = typeof hooks.values === 'function' ? [...hooks.values()] : hooks;
    return list.find(w => w && w.type === WEBHOOK_TYPE_CHANNEL_FOLLOWER && w.sourceChannel && w.sourceChannel.id === sourceId) || null;
}

async function deleteOldHook(client, webhookId) {
    if (!webhookId) return;
    try {
        if (typeof client.deleteWebhook === 'function') await client.deleteWebhook(webhookId, { reason: 'Pingway news: Community Updates channel changed' });
        else await (await client.fetchWebhook(webhookId)).delete('Pingway news: Community Updates channel changed');
    } catch (e) { /* already gone or no access: ignore */ }
}

async function followGuild(guild, opts) {
    const reason = typeof opts === 'string' ? opts : (opts && opts.reason) || 'update';
    try {
        if (!guild || !guild.id) return;
        const targetId = guild.publicUpdatesChannelId;
        if (!targetId) { log(`${guild.id}: no Community Updates channel (${reason}), nothing to do`); return; }
        if (targetId === NEWS_CHANNEL_ID) return; // the Help Desk news channel itself

        await ensureTable();
        const row = await getRow(guild.id);
        if (row && row.status === 'followed' && row.channel_id === targetId) return; // done once: never re-add

        const client = guild.client;
        const target = guild.channels.cache.get(targetId) || await guild.channels.fetch(targetId).catch(() => null);
        if (!target) { log(`${guild.id}: Community Updates channel not found (${reason})`); return; }

        const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
        const perms = me && target.permissionsFor(me);
        if (!perms || !perms.has(NEEDED_PERMS)) {
            log(`${guild.id}: needs View Channel + Manage Webhooks in #${target.name} (${reason})`);
            await saveRow(guild.id, targetId, null, 'skipped');
            return;
        }

        // Channel changed: remove the follower webhook Pingway created in the old channel.
        if (row && row.status === 'followed' && row.channel_id !== targetId) await deleteOldHook(client, row.webhook_id);

        const source = await client.channels.fetch(NEWS_CHANNEL_ID).catch(() => null);
        if (!source || typeof source.addFollower !== 'function') { log(`news channel ${NEWS_CHANNEL_ID} not reachable or not an Announcement channel`); return; }

        const existing = findFollowerHook(await target.fetchWebhooks(), NEWS_CHANNEL_ID);
        if (existing) {
            await saveRow(guild.id, targetId, existing.id, 'followed');
            log(`${guild.id}: already following in #${target.name}`);
            return;
        }

        const res = await source.addFollower(target, 'Pingway news & updates');
        let webhookId = res && res.webhookId;
        if (!webhookId) {
            const hook = findFollowerHook(await target.fetchWebhooks().catch(() => null), NEWS_CHANNEL_ID);
            webhookId = hook ? hook.id : null;
        }
        await saveRow(guild.id, targetId, webhookId, 'followed');
        log(`${guild.id}: followed #pingway-news into #${target.name} (${reason})`);
    } catch (err) {
        log(`${guild && guild.id}: failed (${reason}): ${short(err)}`);
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function followAllOnce(client, { gapMs = GAP_MS } = {}) {
    try {
        await ensureTable();
        const [rows] = await pool.execute("SELECT guild_id, channel_id FROM news_follow WHERE status = 'followed'");
        const done = new Map(rows.map(r => [r.guild_id, r.channel_id]));
        // Guilds without a 'followed' row, plus guilds whose Community Updates channel changed while Pingway was offline.
        const todo = [...client.guilds.cache.values()].filter(g => g.publicUpdatesChannelId && done.get(g.id) !== g.publicUpdatesChannelId);
        let n = 0;
        for (const g of todo) {
            if (n++) await sleep(gapMs);
            try { await followGuild(g, { reason: 'startup' }); } catch (e) { log(`${g.id}: failed (startup): ${short(e)}`); }
        }
        log(`startup check: ${todo.length} server(s) checked, ${done.size} already followed`);
    } catch (err) {
        log('startup check failed: ' + short(err));
    }
}

// Permission triggers (channelUpdate / roleUpdate / guildMemberUpdate): retry only servers not followed yet,
// at most once per guild every 10s.
const DEBOUNCE_MS = 10 * 1000;
const lastRetry = new Map(); // guild id -> time
async function retryIfNotFollowed(guild, reason, { now = Date.now() } = {}) {
    try {
        if (!guild || !guild.id || !guild.publicUpdatesChannelId) return false;
        const last = lastRetry.get(guild.id);
        if (last && now - last < DEBOUNCE_MS) return false;
        const ids = await loadFollowed();
        if (ids.has(guild.id)) return false;
        lastRetry.set(guild.id, now);
        await followGuild(guild, { reason });
        return true;
    } catch (err) {
        log(`${guild && guild.id}: retry failed (${reason}): ${short(err)}`);
        return false;
    }
}

function _resetForTests() { followedIds = null; followedLoading = null; lastRetry.clear(); }

module.exports = { NEWS_CHANNEL_ID, ensureTable, followGuild, followAllOnce, retryIfNotFollowed, _resetForTests };
