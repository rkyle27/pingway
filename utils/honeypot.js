// Honeypot ("do not chat here" channel). Hacked accounts that spam links usually post in every channel,
// including one that real members are told never to use. Anyone (except staff) who posts there is softbanned:
// banned and right away unbanned, which removes them and deletes their messages from the last hour across
// the whole server. They can rejoin with a new invite once they have their account back.
// Set up with /honeypot or on the website (server settings). Every catch is logged for the server's admins.

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { pool } = require('./db');

const DELETE_MESSAGES_SECONDS = 3600;              // softban removes their messages from the last hour
const LOG_KEEP_MS = 90 * 24 * 60 * 60 * 1000;      // catches are kept for 90 days
const RELOAD_MS = 60 * 1000;                        // pick up website changes within a minute
const REASON = 'Pingway honeypot: posted in the do-not-chat channel (likely a hacked account)';

let traps = new Map();     // guildId -> { channelId, dm, warningChannelId, warningMessageId }
let tableReady = false;
let started = false;
let lastPrune = 0;
const busy = new Set();    // guildId:userId being handled right now
const ownerDms = new Map(); // guildId -> { start, sent, skipped } (limits owner DMs during a raid)
const OWNER_DM_WINDOW_MS = 10 * 60 * 1000;
const OWNER_DM_MAX = 5;     // at most 5 owner DMs per server per 10 minutes, then one summary

async function ensureTables() {
    if (tableReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS honeypot_settings (
        guild_id VARCHAR(32) PRIMARY KEY,
        channel_id VARCHAR(32) DEFAULT NULL,
        dm_enabled TINYINT(1) NOT NULL DEFAULT 1,
        warning_channel_id VARCHAR(32) DEFAULT NULL,
        warning_message_id VARCHAR(32) DEFAULT NULL,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS honeypot_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(64) DEFAULT NULL,
        display_name VARCHAR(64) DEFAULT NULL,
        nickname VARCHAR(64) DEFAULT NULL,
        channel_id VARCHAR(32) DEFAULT NULL,
        result VARCHAR(60) NOT NULL,
        dm_sent TINYINT(1) NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        KEY idx_guild_time (guild_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // Added later: the warning message can be turned off (on by default)
    const [cols] = await pool.execute("SHOW COLUMNS FROM honeypot_settings LIKE 'warning_enabled'");
    if (!cols.length) await pool.execute('ALTER TABLE honeypot_settings ADD COLUMN warning_enabled TINYINT(1) NOT NULL DEFAULT 1');
    tableReady = true;
}

function warningEmbed() {
    return new EmbedBuilder()
        .setColor('#ed4245')
        .setTitle('🚫 DO NOT POST IN THIS CHANNEL')
        .setDescription(
            'This channel catches **hacked accounts** that spam links in every channel.\n\n' +
            'Anyone who posts here is **removed from the server automatically**, and their messages from the last hour are deleted.\n\n' +
            '*Staff are not affected. If this happened to you by mistake, ask a member for a new invite.*'
        )
        .setFooter({ text: 'Pingway honeypot' });
}

// Post (and pin) the warning in the trap channel when it is new or changed
async function postWarning(client, guildId, trap) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const channel = guild.channels.cache.get(trap.channelId);
    if (!channel || !channel.isTextBased()) return;
    try {
        if (trap.warningChannelId && trap.warningMessageId && trap.warningChannelId !== trap.channelId) {
            const old = guild.channels.cache.get(trap.warningChannelId);
            if (old && old.isTextBased()) await old.messages.delete(trap.warningMessageId).catch(() => {});
        }
        const msg = await channel.send({ embeds: [warningEmbed()] });
        await msg.pin().catch(() => {});
        await pool.execute('UPDATE honeypot_settings SET warning_channel_id = ?, warning_message_id = ? WHERE guild_id = ?', [trap.channelId, msg.id, guildId]);
        trap.warningChannelId = trap.channelId;
        trap.warningMessageId = msg.id;
        console.log('🍯 [HONEYPOT] Warning posted in #' + channel.name + ' (' + guild.name + ').');
    } catch (err) {
        console.error('❌ [HONEYPOT] Could not post the warning in ' + guild.name + ':', err.message);
    }
}

// Warning turned off: delete Pingway's warning message (the honeypot itself keeps working)
async function removeWarning(client, guildId, trap) {
    const guild = client.guilds.cache.get(guildId);
    const channel = guild && guild.channels.cache.get(trap.warningChannelId);
    if (channel && channel.isTextBased()) await channel.messages.delete(trap.warningMessageId).catch(() => {});
    await pool.execute('UPDATE honeypot_settings SET warning_channel_id = NULL, warning_message_id = NULL WHERE guild_id = ?', [guildId]).catch(() => {});
    trap.warningChannelId = null;
    trap.warningMessageId = null;
    if (guild) console.log('🍯 [HONEYPOT] Warning removed in ' + guild.name + ' (turned off).');
}

async function load(client) {
    try {
        await ensureTables();
        const [rows] = await pool.execute(
            'SELECT guild_id, channel_id, dm_enabled, warning_enabled, warning_channel_id, warning_message_id FROM honeypot_settings WHERE channel_id IS NOT NULL'
        );
        const next = new Map();
        for (const r of rows) {
            next.set(String(r.guild_id), {
                channelId: String(r.channel_id), dm: Number(r.dm_enabled) === 1, warning: Number(r.warning_enabled) !== 0,
                warningChannelId: r.warning_channel_id ? String(r.warning_channel_id) : null,
                warningMessageId: r.warning_message_id ? String(r.warning_message_id) : null
            });
        }
        traps = next;
        for (const [guildId, trap] of traps) {
            if (trap.warning && trap.warningChannelId !== trap.channelId) await postWarning(client, guildId, trap);
            else if (!trap.warning && trap.warningMessageId) await removeWarning(client, guildId, trap);
        }
        if (Date.now() - lastPrune > 60 * 60 * 1000) {
            lastPrune = Date.now();
            await pool.execute('DELETE FROM honeypot_log WHERE created_at < ?', [Date.now() - LOG_KEEP_MS]);
        }
    } catch (err) {
        console.error('❌ [HONEYPOT] Could not load settings:', err.message);
    }
}

function start(client) {
    if (started) return;
    started = true;
    load(client);
    setInterval(() => load(client), RELOAD_MS);
}

function isTrap(message) {
    const trap = message.guildId && traps.get(message.guildId);
    return Boolean(trap && trap.channelId === message.channelId);
}

function isStaff(member, guild) {
    if (!member) return false;
    if (member.id === guild.ownerId) return true;
    return member.permissions.any([
        PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers
    ]);
}

function hackedDm(guild, channelName) {
    return new EmbedBuilder()
        .setColor('#f0ad28')
        .setTitle('⚠️ Your Discord account may be hacked')
        .setDescription(
            'A message was just sent from your account in **#' + channelName + '** on **' + guild.name + '**, a channel nobody should post in. ' +
            'Accounts that do this are almost always hacked, so you were removed from that server and your messages there from the last hour were deleted.\n\n' +
            '**What to do now**\n' +
            '1. Change your Discord password.\n' +
            '2. Turn on two-factor authentication (User Settings → My Account).\n' +
            '3. Check User Settings → Devices and log out anything you don\'t recognise.\n' +
            '4. Ask a member of **' + guild.name + '** for a new invite to rejoin.\n\n' +
            'If you posted there yourself by mistake, just ask for an invite. You are not banned.'
        )
        .setFooter({ text: 'Sent by Pingway' });
}

async function report(guild, entry) {
    try {
        const [[row]] = await pool.execute('SELECT startup_channel_id FROM server_settings WHERE guild_id = ?', [guild.id]);
        const channel = row && row.startup_channel_id ? guild.channels.cache.get(String(row.startup_channel_id)) : null;
        if (!channel || !channel.isTextBased()) return;
        const names = [entry.nickname, entry.displayName].filter(Boolean).join(' / ');
        const embed = new EmbedBuilder()
            .setColor('#9b6bff')
            .setTitle('🍯 Honeypot caught a member')
            .addFields(
                { name: 'Member', value: '<@' + entry.userId + '>' + (names ? ' · ' + names : '') + '\n@' + entry.username, inline: true },
                { name: 'User ID', value: entry.userId, inline: true },
                { name: 'Result', value: entry.result + (entry.dmSent ? '\nDM sent ✅' : '\nDM not sent'), inline: true }
            )
            .setTimestamp();
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        console.error('❌ [HONEYPOT] Could not post the report:', err.message);
    }
}

// DM the server owner about each catch (limited during a raid of many accounts)
async function dmOwner(guild, entry, channelName) {
    try {
        const now = Date.now();
        let w = ownerDms.get(guild.id);
        if (!w || now - w.start > OWNER_DM_WINDOW_MS) {
            if (w && w.skipped > 0) await sendOwnerSummary(guild, w.skipped);
            w = { start: now, sent: 0, skipped: 0 };
            ownerDms.set(guild.id, w);
        }
        if (w.sent >= OWNER_DM_MAX) {
            if (w.skipped === 0) setTimeout(() => flushOwnerSummary(guild), OWNER_DM_WINDOW_MS - (now - w.start) + 1000);
            w.skipped++;
            return;
        }
        w.sent++;
        const owner = await guild.fetchOwner();
        const names = [entry.nickname && 'Nickname: ' + entry.nickname, entry.displayName && 'Display name: ' + entry.displayName].filter(Boolean).join('\n');
        const embed = new EmbedBuilder()
            .setColor('#9b6bff')
            .setTitle('🍯 Honeypot caught a member in ' + guild.name)
            .setDescription('Someone posted in **#' + channelName + '**, your do-not-chat channel. This usually means their account was hacked.')
            .addFields(
                { name: 'Member', value: '<@' + entry.userId + '>\nUsername: @' + entry.username + (names ? '\n' + names : '') },
                { name: 'User ID', value: entry.userId, inline: true },
                { name: 'When', value: '<t:' + Math.floor(now / 1000) + ':F>', inline: true },
                { name: 'Result', value: entry.result + (entry.dmSent ? '\nThey were sent a "your account may be hacked" DM.' : ''), inline: false }
            )
            .setFooter({ text: 'Pingway honeypot · Full list: Pingway website → server settings → Honeypot' })
            .setTimestamp();
        await owner.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        // Owner's DMs are closed or the owner couldn't be fetched: the channel report and website list still have it
    }
}

async function flushOwnerSummary(guild) {
    const w = ownerDms.get(guild.id);
    if (!w || w.skipped === 0) return;
    const skipped = w.skipped;
    w.skipped = 0;
    await sendOwnerSummary(guild, skipped);
}

async function sendOwnerSummary(guild, count) {
    try {
        const owner = await guild.fetchOwner();
        await owner.send({ content: '🍯 The honeypot in **' + guild.name + '** caught **' + count + ' more** member(s) in the last few minutes. ' +
            'See all of them on the Pingway website → server settings → Honeypot.', allowedMentions: { parse: [] } });
    } catch (e) { /* DMs closed */ }
}

// Called from messageCreate for every message in a trap channel
async function handle(message) {
    if (message.author.bot || message.webhookId || message.system) return;
    const guild = message.guild;
    const trap = traps.get(guild.id);
    const user = message.author;
    const key = guild.id + ':' + user.id;
    if (busy.has(key)) { message.delete().catch(() => {}); return; } // more spam while we're already on it
    let member = message.member;
    if (!member) member = await guild.members.fetch(user.id).catch(() => null);
    if (isStaff(member, guild)) return; // staff may post in the channel
    busy.add(key);
    setTimeout(() => busy.delete(key), 60 * 1000);

    const entry = {
        userId: user.id, username: user.username, displayName: user.globalName || null,
        nickname: member && member.nickname ? member.nickname : null, dmSent: false, result: 'softbanned'
    };
    await message.delete().catch(() => {});

    // DM first: after the softban they no longer share a server, so Discord would block the DM
    if (trap && trap.dm) {
        try {
            await user.send({ embeds: [hackedDm(guild, message.channel.name || 'channel')] });
            entry.dmSent = true;
        } catch (e) { /* DMs closed */ }
    }

    const me = guild.members.me;
    if (!me || !me.permissions.has(PermissionFlagsBits.BanMembers)) {
        entry.result = 'not removed: Pingway needs Ban Members';
    } else if (member && !member.bannable) {
        entry.result = 'not removed: their role is above Pingway';
    } else {
        try {
            await guild.members.ban(user.id, { deleteMessageSeconds: DELETE_MESSAGES_SECONDS, reason: REASON });
            try {
                await guild.members.unban(user.id, 'Pingway honeypot softban: unbanned so they can rejoin later');
            } catch (e) {
                entry.result = 'banned (unban failed: unban them manually)';
            }
        } catch (err) {
            entry.result = 'not removed: ' + String(err.message || 'error').slice(0, 40);
        }
    }

    console.log('🍯 [HONEYPOT] ' + guild.name + ': @' + user.username + ' (' + user.id + ') -> ' + entry.result + (entry.dmSent ? ', DM sent' : ''));
    try {
        await ensureTables();
        await pool.execute(
            'INSERT INTO honeypot_log (guild_id, user_id, username, display_name, nickname, channel_id, result, dm_sent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [guild.id, user.id, String(entry.username).slice(0, 64), entry.displayName ? String(entry.displayName).slice(0, 64) : null,
                entry.nickname ? String(entry.nickname).slice(0, 64) : null, message.channelId, entry.result.slice(0, 60), entry.dmSent ? 1 : 0, Date.now()]
        );
    } catch (err) {
        console.error('❌ [HONEYPOT] Could not save the log:', err.message);
    }
    await report(guild, entry);
    await dmOwner(guild, entry, message.channel.name || 'channel');
}

// /honeypot set|off|dm: save and apply right away
async function setChannel(client, guildId, channelId) {
    await ensureTables();
    await pool.execute(
        `INSERT INTO honeypot_settings (guild_id, channel_id, updated_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), updated_at = VALUES(updated_at)`,
        [guildId, channelId, Date.now()]
    );
    await load(client);
}

async function setDm(guildId, on) {
    await ensureTables();
    await pool.execute(
        `INSERT INTO honeypot_settings (guild_id, dm_enabled, updated_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE dm_enabled = VALUES(dm_enabled), updated_at = VALUES(updated_at)`,
        [guildId, on ? 1 : 0, Date.now()]
    );
    const trap = traps.get(guildId);
    if (trap) trap.dm = on;
}

// /honeypot warning on|off
async function setWarning(client, guildId, on) {
    await ensureTables();
    await pool.execute(
        `INSERT INTO honeypot_settings (guild_id, warning_enabled, updated_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE warning_enabled = VALUES(warning_enabled), updated_at = VALUES(updated_at)`,
        [guildId, on ? 1 : 0, Date.now()]
    );
    await load(client);
}

function getTrap(guildId) { return traps.get(guildId) || null; }

module.exports = { start, load, isTrap, handle, setChannel, setDm, setWarning, getTrap, ensureTables };
