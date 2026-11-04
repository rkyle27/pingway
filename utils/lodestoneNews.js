// FFXIV news channels: posts new Lodestone news (Topics, Notices, Maintenance, Updates, Status) to channels
// chosen on the website (server settings -> FFXIV News). Up to 5 channels per server, one Lodestone edition
// (language/region) per channel, and each edition only once per server.
// Data: the free community Lodestone News API (lodestonenews.com), which reads the official Lodestone.

const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { pool } = require('./db');

const POLL_MS = 10 * 60 * 1000;      // check the Lodestone every 10 minutes
const RELOAD_MS = 60 * 1000;         // pick up website changes within a minute
const SEEN_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const OLD_ITEM_MS = 7 * 24 * 60 * 60 * 1000; // items older than this are never posted (e.g. after the seen list is trimmed)
const API = 'https://lodestonenews.com/news/';
const LOCALES = { na: 'English (NA)', eu: 'English (EU)', jp: '日本語', fr: 'Français', de: 'Deutsch' };
const CATEGORIES = {
    topics: { label: 'Topics', color: '#c9a14a', emoji: '📰' },
    notices: { label: 'Notices', color: '#3498db', emoji: '📢' },
    maintenance: { label: 'Maintenance', color: '#e67e22', emoji: '🛠️' },
    updates: { label: 'Updates', color: '#2ecc71', emoji: '🆕' },
    status: { label: 'Status', color: '#e74c3c', emoji: '⚠️' }
};

let tablesReady = false;
let started = false;
let polling = false;
let channels = []; // [{ id, guildId, channelId, locale, categories: Set }]

async function ensureTables() {
    if (tablesReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS news_channels (
        id INT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        channel_id VARCHAR(32) NOT NULL,
        locale VARCHAR(4) NOT NULL,
        categories VARCHAR(200) NOT NULL,
        position INT NOT NULL DEFAULT 0,
        welcomed TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(120) DEFAULT NULL,
        updated_at BIGINT NOT NULL DEFAULT 0,
        UNIQUE KEY uniq_guild_locale (guild_id, locale)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS lodestone_seen (
        locale VARCHAR(4) NOT NULL,
        category VARCHAR(16) NOT NULL,
        item_id VARCHAR(80) NOT NULL,
        seen_at BIGINT NOT NULL,
        PRIMARY KEY (locale, category, item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    tablesReady = true;
}

function parseCategories(text) {
    try {
        const list = JSON.parse(text || '[]');
        return new Set((Array.isArray(list) ? list : []).filter(c => CATEGORIES[c]));
    } catch (e) {
        return new Set();
    }
}

async function setStatus(row, status) {
    if (row.status === status) return;
    row.status = status;
    await pool.execute('UPDATE news_channels SET status = ? WHERE id = ?', [status, row.id]).catch(() => {});
}

async function reload(client) {
    try {
        await ensureTables();
        const [rows] = await pool.execute('SELECT * FROM news_channels ORDER BY guild_id, position, id');
        const next = [];
        for (const row of rows) {
            const guild = client.guilds.cache.get(row.guild_id);
            if (!guild || !LOCALES[row.locale]) continue;
            const entry = { id: row.id, guildId: row.guild_id, channelId: row.channel_id, locale: row.locale, categories: parseCategories(row.categories), status: row.status };
            next.push(entry);
            if (Number(row.welcomed) !== 1) {
                const channel = guild.channels.cache.get(row.channel_id);
                if (!channel || !channel.isTextBased()) { await setStatus(entry, 'Channel not found'); continue; }
                const cats = Array.from(entry.categories).map(c => CATEGORIES[c].label).join(', ') || 'nothing (no categories picked)';
                try {
                    await channel.send({ content: '📰 **FFXIV news** from the Lodestone (' + LOCALES[row.locale] + ') will be posted here: ' + cats + '.', allowedMentions: { parse: [] } });
                    await pool.execute('UPDATE news_channels SET welcomed = 1 WHERE id = ?', [row.id]);
                    await setStatus(entry, 'ok');
                } catch (err) {
                    await setStatus(entry, 'Pingway cannot post in that channel');
                }
            }
        }
        channels = next;
    } catch (err) {
        console.error('❌ [NEWS] Reload failed:', err.message);
    }
}

async function fetchNews(locale, category) {
    try {
        const res = await axios.get(API + category, { params: { locale }, timeout: 15000 });
        return Array.isArray(res.data) ? res.data : null;
    } catch (err) {
        // Older address style as a fallback
        try {
            const res = await axios.get('https://' + locale + '.lodestonenews.com/news/' + category, { timeout: 15000 });
            return Array.isArray(res.data) ? res.data : null;
        } catch (e) {
            return null;
        }
    }
}

const unix = t => {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

function buildEmbed(item, locale, category) {
    const c = CATEGORIES[category];
    const embed = new EmbedBuilder()
        .setColor(c.color)
        .setTitle((c.emoji + ' ' + String(item.title || 'Lodestone news')).slice(0, 256))
        .setFooter({ text: 'Lodestone · ' + c.label + ' · ' + LOCALES[locale] });
    if (/^https:\/\//.test(item.url || '')) embed.setURL(item.url);
    let text = item.description ? String(item.description).replace(/\s+\n/g, '\n').slice(0, 600) : '';
    const start = unix(item.start), end = unix(item.end);
    if (start && end) text = (text ? text + '\n\n' : '') + '🕒 <t:' + start + ':f> → <t:' + end + ':f> (your time zone)';
    if (text) embed.setDescription(text);
    if (/^https:\/\//.test(item.image || '')) embed.setImage(item.image);
    const time = Date.parse(item.time);
    if (Number.isFinite(time)) embed.setTimestamp(new Date(time));
    return embed;
}

async function poll(client) {
    if (polling || channels.length === 0) return;
    polling = true;
    try {
        // Only the editions and categories some server actually uses
        const wanted = new Map(); // 'locale:category' -> [entries]
        for (const ch of channels) for (const cat of ch.categories) {
            const key = ch.locale + ':' + cat;
            if (!wanted.has(key)) wanted.set(key, []);
            wanted.get(key).push(ch);
        }
        for (const [key, targets] of wanted) {
            const [locale, category] = key.split(':');
            const items = await fetchNews(locale, category);
            if (!items) continue;
            const [seenRows] = await pool.execute('SELECT item_id FROM lodestone_seen WHERE locale = ? AND category = ?', [locale, category]);
            const seen = new Set(seenRows.map(r => r.item_id));
            const firstTime = seen.size === 0; // first check of this edition: remember what exists, post nothing old
            const fresh = items.filter(i => i && i.id && !seen.has(String(i.id))).reverse(); // oldest first
            for (const item of fresh) {
                await pool.execute('INSERT IGNORE INTO lodestone_seen (locale, category, item_id, seen_at) VALUES (?, ?, ?, ?)',
                    [locale, category, String(item.id).slice(0, 80), Date.now()]);
                const time = Date.parse(item.time);
                if (firstTime || (Number.isFinite(time) && time < Date.now() - OLD_ITEM_MS)) continue; // never post old news

                const embed = buildEmbed(item, locale, category);
                for (const t of targets) {
                    const guild = client.guilds.cache.get(t.guildId);
                    const channel = guild && guild.channels.cache.get(t.channelId);
                    if (!channel || !channel.isTextBased()) { await setStatus(t, 'Channel not found'); continue; }
                    try {
                        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
                        await setStatus(t, 'ok');
                    } catch (err) {
                        await setStatus(t, 'Pingway cannot post in that channel');
                    }
                }
                console.log('📰 [NEWS] ' + LOCALES[locale] + ' ' + CATEGORIES[category].label + ': ' + String(item.title).slice(0, 80));
            }
            await new Promise(r => setTimeout(r, 1500)); // be gentle with the free API
        }
        await pool.execute('DELETE FROM lodestone_seen WHERE seen_at < ?', [Date.now() - SEEN_KEEP_MS]).catch(() => {});
    } catch (err) {
        console.error('❌ [NEWS] Check failed:', err.message);
    } finally {
        polling = false;
    }
}

function start(client) {
    if (started) return;
    started = true;
    reload(client).then(() => poll(client));
    setInterval(() => reload(client), RELOAD_MS);
    setInterval(() => poll(client), POLL_MS);
}

module.exports = { start, reload, poll, ensureTables, LOCALES, CATEGORIES };
