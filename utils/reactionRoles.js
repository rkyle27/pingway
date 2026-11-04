// Reaction roles: members react with an emoji on a message and get a role (removing the reaction removes the role).
// Set up on the website (server settings -> Reaction Roles). The website writes rr_messages; this module
// reloads every minute, posts/edits Pingway's messages, adds Pingway's reactions and hands out roles.
//
// Limits: free servers get 10 messages with up to 10 emojis each. If the server OWNER has Supporter Perks, there is
// no limit (Discord itself allows 20 different reactions per message). Otherwise each extra message (message 11 and
// up, or more than 10 emojis) runs on the perks of the admin who saved it on the website (perk_owner). When those
// perks end, it keeps running for 48 hours; then Pingway moves it to another admin of the server with perks, or
// pauses it: Pingway takes its reactions off and ignores reactions there until perks are back (never deleted).

const { Routes } = require('discord.js');
const crypto = require('crypto');
const { pool } = require('./db');
const { ownerHasMembership, sponsorHasPerks, findPerksAdmin } = require('./membership');

const RELOAD_MS = 60 * 1000;
const FREE_MESSAGES = 10;
const FREE_EMOJIS = 10;
const MAX_EMOJIS = 20; // Discord limit per message

let tableReady = false;
let started = false;
let syncing = false;
let byMessage = new Map();   // messageId -> { guildId, rowId, active, roles: Map(emojiKey -> roleId) }
const synced = new Map();    // rowId -> signature of what was last synced
const errorLogged = new Map(); // key -> time (keeps the console quiet when a server keeps failing)

async function ensureTable() {
    if (tableReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS rr_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        position INT NOT NULL DEFAULT 0,
        mode VARCHAR(10) NOT NULL DEFAULT 'post',
        channel_id VARCHAR(32) NOT NULL,
        message_id VARCHAR(32) DEFAULT NULL,
        content TEXT,
        pairs TEXT NOT NULL,
        posted_channel_id VARCHAR(32) DEFAULT NULL,
        posted_hash CHAR(64) DEFAULT NULL,
        status VARCHAR(120) DEFAULT NULL,
        deleted TINYINT(1) NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL DEFAULT 0,
        KEY idx_guild (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const [col] = await pool.execute("SHOW COLUMNS FROM rr_messages LIKE 'perk_owner'");
    if (col.length === 0) await pool.execute('ALTER TABLE rr_messages ADD COLUMN perk_owner VARCHAR(32) DEFAULT NULL');
    tableReady = true;
}

// Unicode emojis can arrive with or without the invisible "emoji style" character (U+FE0F)
const emojiKey = e => (e && e.id) ? String(e.id) : String((e && e.name) || '').replace(/️/g, '');
const emojiForReact = e => e.id ? (e.animated ? 'a:' : '') + e.name + ':' + e.id : e.name;

function parsePairs(text) {
    try {
        const list = JSON.parse(text || '[]');
        return Array.isArray(list) ? list.filter(p => p && p.emoji && p.roleId).slice(0, MAX_EMOJIS) : [];
    } catch (e) {
        return [];
    }
}

function logOnce(key, text) {
    const last = errorLogged.get(key) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    errorLogged.set(key, Date.now());
    console.error(text);
}

async function setStatus(row, status) {
    if (row.status === status) return;
    row.status = status;
    await pool.execute('UPDATE rr_messages SET status = ? WHERE id = ?', [status, row.id]).catch(() => {});
}

async function load(client) {
    if (syncing) return;
    syncing = true;
    try {
        await ensureTable();
        const [rows] = await pool.execute('SELECT * FROM rr_messages ORDER BY guild_id, position, id');
        const perGuild = new Map();
        for (const r of rows) {
            if (!perGuild.has(r.guild_id)) perGuild.set(r.guild_id, []);
            perGuild.get(r.guild_id).push(r);
        }

        const next = new Map();
        for (const [guildId, list] of perGuild) {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) continue; // Pingway is not in that server (leftover data is handled by "purge")
            const unlocked = await ownerHasMembership(guild.ownerId);
            let index = 0;
            for (const row of list) {
                if (Number(row.deleted) === 1) {
                    await cleanupDeleted(client, guild, row);
                    continue;
                }
                const pairs = parsePairs(row.pairs);
                const extra = index >= FREE_MESSAGES || pairs.length > FREE_EMOJIS;
                index++;
                let active = unlocked || !extra || await sponsorHasPerks(row.perk_owner);
                if (!active) {
                    // Its perks ended (48 h grace over) or it never had any: move it to another admin with perks
                    const next = await findPerksAdmin(guild, row.perk_owner);
                    if (next) {
                        await pool.execute('UPDATE rr_messages SET perk_owner = ? WHERE id = ?', [next, row.id]).catch(() => {});
                        if (row.perk_owner) console.log('💜 [REACTION ROLES] Message ' + row.id + ' in ' + guild.name + ' moved to another admin\'s Supporter Perks.');
                        row.perk_owner = next;
                        active = true;
                    }
                }
                const signature = [row.updated_at, active, row.message_id || ''].join('|');
                if (synced.get(row.id) !== signature) {
                    await syncRow(client, guild, row, pairs, active);
                    synced.set(row.id, [row.updated_at, active, row.message_id || ''].join('|'));
                }
                if (row.message_id) {
                    const roles = new Map();
                    for (const p of pairs) roles.set(emojiKey(p.emoji), String(p.roleId));
                    next.set(String(row.message_id), { guildId, rowId: row.id, active, roles });
                }
            }
        }
        byMessage = next;
    } catch (err) {
        console.error('❌ [REACTION ROLES] Reload failed:', err.message);
    } finally {
        syncing = false;
    }
}

async function fetchMessage(guild, channelId, messageId) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return { error: 'Channel not found' };
    try {
        return { channel, message: await channel.messages.fetch(messageId) };
    } catch (err) {
        if (err.code === 10008) return { channel, error: 'Message not found' };
        if (err.code === 50001 || err.code === 50013) return { channel, error: 'Pingway cannot see that channel' };
        return { channel, error: 'Could not load the message' };
    }
}

// Make one message match its settings: post/edit Pingway's message, then add or remove Pingway's reactions
async function syncRow(client, guild, row, pairs, active) {
    try {
        let message = null;
        if (row.mode === 'post') {
            const hash = crypto.createHash('sha256').update(String(row.content || '')).digest('hex');
            const moved = row.message_id && row.posted_channel_id && row.posted_channel_id !== row.channel_id;
            if (moved) {
                const old = await fetchMessage(guild, row.posted_channel_id, row.message_id);
                if (old.message) await old.message.delete().catch(() => {});
            }
            let found = (!moved && row.message_id) ? await fetchMessage(guild, row.channel_id, row.message_id) : null;
            if (found && found.message) {
                message = found.message;
                if (row.posted_hash !== hash) {
                    await message.edit({ content: row.content, allowedMentions: { parse: [] } });
                    await pool.execute('UPDATE rr_messages SET posted_hash = ? WHERE id = ?', [hash, row.id]);
                    row.posted_hash = hash;
                }
            } else {
                const channel = guild.channels.cache.get(row.channel_id);
                if (!channel || !channel.isTextBased()) return setStatus(row, 'Channel not found');
                try {
                    message = await channel.send({ content: row.content, allowedMentions: { parse: [] } });
                } catch (err) {
                    return setStatus(row, 'Pingway cannot post in that channel');
                }
                await pool.execute('UPDATE rr_messages SET message_id = ?, posted_channel_id = ?, posted_hash = ? WHERE id = ?',
                    [message.id, row.channel_id, hash, row.id]);
                row.message_id = message.id;
                row.posted_channel_id = row.channel_id;
                row.posted_hash = hash;
            }
        } else {
            const found = await fetchMessage(guild, row.channel_id, row.message_id);
            if (!found.message) return setStatus(row, found.error);
            message = found.message;
        }

        // Reactions: Pingway's own reactions show members which emojis to click
        const wanted = new Map();
        if (active) for (const p of pairs) wanted.set(emojiKey(p.emoji), p.emoji);
        for (const reaction of message.reactions.cache.values()) {
            const key = emojiKey(reaction.emoji);
            if (reaction.me && !wanted.has(key)) await reaction.users.remove(client.user.id).catch(() => {});
        }
        const failed = [];
        for (const [key, emoji] of wanted) {
            const existing = message.reactions.cache.find(r => emojiKey(r.emoji) === key);
            if (existing && existing.me) continue;
            try {
                await message.react(emojiForReact(emoji));
            } catch (err) {
                failed.push(emoji.name || key);
            }
        }
        if (!active) return setStatus(row, 'paused');
        return setStatus(row, failed.length ? 'Could not add: ' + failed.join(' ').slice(0, 90) : 'ok');
    } catch (err) {
        logOnce('sync:' + row.id, '❌ [REACTION ROLES] Sync failed in ' + guild.name + ': ' + err.message);
        return setStatus(row, 'Error: ' + String(err.message).slice(0, 100));
    }
}

// Removed on the website: take Pingway's message (or its reactions on someone else's message) away, then forget it
async function cleanupDeleted(client, guild, row) {
    try {
        if (row.message_id) {
            const found = await fetchMessage(guild, row.posted_channel_id || row.channel_id, row.message_id);
            if (found.message) {
                if (row.mode === 'post' && found.message.author.id === client.user.id) await found.message.delete().catch(() => {});
                else for (const reaction of found.message.reactions.cache.values()) if (reaction.me) await reaction.users.remove(client.user.id).catch(() => {});
            }
        }
    } finally {
        await pool.execute('DELETE FROM rr_messages WHERE id = ?', [row.id]).catch(() => {});
        synced.delete(row.id);
    }
}

// Raw gateway events: work even for old messages that are not in the cache
async function onRaw(client, packet) {
    if (packet.t !== 'MESSAGE_REACTION_ADD' && packet.t !== 'MESSAGE_REACTION_REMOVE') return;
    const d = packet.d;
    if (!d || !d.guild_id || !d.user_id || d.user_id === client.user.id) return;
    const entry = byMessage.get(String(d.message_id));
    if (!entry || !entry.active || entry.guildId !== d.guild_id) return;
    if (packet.t === 'MESSAGE_REACTION_ADD' && d.member && d.member.user && d.member.user.bot) return;
    const roleId = entry.roles.get(emojiKey(d.emoji));
    if (!roleId) return;
    const adding = packet.t === 'MESSAGE_REACTION_ADD';
    try {
        const route = Routes.guildMemberRole(d.guild_id, d.user_id, roleId);
        if (adding) await client.rest.put(route, { reason: 'Pingway reaction role' });
        else await client.rest.delete(route, { reason: 'Pingway reaction role (reaction removed)' });
    } catch (err) {
        if (err.code === 10007) return; // member left
        logOnce('role:' + d.guild_id + ':' + roleId, '❌ [REACTION ROLES] Could not ' + (adding ? 'give' : 'remove') + ' role ' + roleId +
            ' in server ' + d.guild_id + ': ' + err.message + ' (Pingway needs Manage Roles, and its role must be above that role)');
    }
}

function start(client) {
    if (started) return;
    started = true;
    client.on('raw', packet => { onRaw(client, packet).catch(() => {}); });
    load(client);
    setInterval(() => load(client), RELOAD_MS);
}

module.exports = { start, load, ensureTable };
