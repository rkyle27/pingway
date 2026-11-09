const { toDiscordTimestamp } = require('./hammertime');
const { isMaintenance } = require('../maintenance');

// Shared database pool (same as the rest of the bot)
const { pool: db } = require('./db');
const { t } = require('./i18n');
const userLanguage = require('./userLanguage');

// "Post again?" DM to the host when a listing reaches its start time (status 'started').
// The button opens the /pf date/time step with the old details (commands/pf.js, customId pf_repost_*).
const REPOST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REPOST_PREFIX = 'pf_repost_';

/** Button id: pf_repost_<listingId>_<hostId>_<sentAtMs> (well under Discord's 100 characters). */
function repostCustomId(listingId, hostId, sentAt) {
    return `${REPOST_PREFIX}${listingId}_${hostId}_${sentAt}`;
}

/** @returns {{ listingId, hostId, sentAt }|null} */
function parseRepostCustomId(cid) {
    if (typeof cid !== 'string' || !cid.startsWith(REPOST_PREFIX)) return null;
    const [listingId, hostId, sentAt] = cid.slice(REPOST_PREFIX.length).split('_');
    if (!listingId || !hostId || !/^\d+$/.test(sentAt || '')) return null;
    return { listingId, hostId, sentAt: Number(sentAt) };
}

/** DM payload (raw API JSON, no builders). */
function buildRepostDm(listing, lang, now = Date.now()) {
    return {
        content: t(lang, 'pf.repost.dm', { name: listing.name || t(lang, 'pf.alert.event') }),
        components: [{
            type: 1,
            components: [{ type: 2, style: 1, custom_id: repostCustomId(listing.id, listing.userId, now), label: t(lang, 'pf.repost.button'), emoji: { name: '📅' } }]
        }]
    };
}

/** DMs the host; if the DM fails (DMs closed, user gone), nothing else happens. Never throws. */
async function sendRepostDm(client, listing, now = Date.now()) {
    try {
        if (!listing || !listing.userId) return false;
        const user = await client.users.fetch(String(listing.userId));
        const lang = await userLanguage.forUser(listing.userId).catch(() => 'en');
        await user.send(buildRepostDm(listing, lang, now));
        return true;
    } catch (e) {
        return false;
    }
}

function startPfScheduler(client) {
    setInterval(async () => {
        // Skip execution if global maintenance mode is active
        if (isMaintenance()) return;

        try {
            const [rows] = await db.query('SELECT * FROM party_finders');
            if (!rows || rows.length === 0) return;

            const nowUTC = Date.now();

            for (const row of rows) {
                const rawData = row.data ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : {};

                const listing = {
                    ...row,
                    ...rawData,
                    id: String(rawData.id || row.id),
                    guildId: rawData.guildId || row.guild_id,
                    userId: rawData.userId || row.user_id,
                    messageId: rawData.messageId || row.message_id,
                    channelId: rawData.channelId || row.channel_id,
                    date: rawData.date || row.date,
                    name: rawData.name || row.name,
                    claims: rawData.claims || { tanks: [], healers: [], dps: [], meleedps: [], physicalrangeddps: [], magicalrangeddps: [], other: [], reserves: [] },
                    notified30Min: rawData.notified30Min ?? row.notified30Min ?? false,
                    notifiedExact: rawData.notifiedExact ?? row.notifiedExact ?? false,
                };

                // Skip if guild is under maintenance
                if (listing.guildId && isMaintenance(listing.guildId)) {
                    continue;
                }

                if (!listing.date) continue;

                let targetTimestampMs = null;
                const matchGMT = listing.date.match(/GMT([+-]\d+)/);
                const isJST = listing.date.includes('JST');

                if (matchGMT || isJST) {
                    const offsetHours = matchGMT ? parseInt(matchGMT[1], 10) : 9;
                    const cleanDateStr = listing.date.replace(/ (GMT[+-]\d+|JST)/, '').trim();
                    const [datePart, timePart] = cleanDateStr.split(' ');
                    if (datePart && timePart) {
                        const [year, month, day] = datePart.split('-').map(Number);
                        const [hours, minutes] = timePart.split(':').map(Number);
                        
                        const sign = offsetHours >= 0 ? '+' : '-';
                        const absOffset = String(Math.abs(offsetHours)).padStart(2, '0');
                        const isoString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00${sign}${absOffset}:00`;
                        targetTimestampMs = new Date(isoString).getTime();
                    }
                }

                if (!targetTimestampMs || isNaN(targetTimestampMs)) {
                    targetTimestampMs = new Date(listing.date).getTime();
                }

                if (isNaN(targetTimestampMs)) continue;

                const diffMs = targetTimestampMs - nowUTC;
                const diffMins = Math.floor(diffMs / (1000 * 60));

                // Skip processing early if notification window isn't hit
                const needs30Min = diffMins >= 29 && diffMins <= 30 && !listing.notified30Min;
                const needsExact = diffMs <= 0 && diffMs > -30000 && !listing.notifiedExact;

                if (!needs30Min && !needsExact) continue;

                const guild = await client.guilds.fetch(listing.guildId).catch(() => null);
                if (!guild) continue;

                let targetChannel = null;
                let targetMessage = null;

                if (listing.channelId) {
                    targetChannel = await guild.channels.fetch(listing.channelId).catch(() => null);
                    if (targetChannel && targetChannel.isTextBased()) {
                        targetMessage = await targetChannel.messages.fetch(listing.messageId).catch(() => null);
                    }
                }

                // Fallback scan only if direct channel fetch failed
                if (!targetChannel || !targetMessage) {
                    const channels = await guild.channels.fetch().catch(() => new Map());
                    for (const [, channel] of channels) {
                        if (channel && channel.isTextBased()) {
                            const msg = await channel.messages.fetch(listing.messageId).catch(() => null);
                            if (msg) {
                                targetChannel = channel;
                                targetMessage = msg;
                                listing.channelId = channel.id;
                                break;
                            }
                        }
                    }
                }

                if (!targetChannel || !targetMessage) continue;

                const participantIds = new Set();
                if (listing.claims) {
                    for (const roleKey of Object.keys(listing.claims)) {
                        const claimList = listing.claims[roleKey];
                        if (Array.isArray(claimList)) {
                            claimList.forEach(entry => {
                                if (typeof entry === 'string') participantIds.add(entry);
                                else if (entry && entry.userId) participantIds.add(entry.userId);
                            });
                        }
                    }
                }
                if (listing.userId) participantIds.add(listing.userId);

                const lang = userLanguage.forGuild(targetChannel.guild); // public post: the server's language
                const pingList = Array.from(participantIds).map(id => `<@${id}>`).join(' ');
                const dutyName = listing.name || t(lang, 'pf.alert.event');
                const hammertimeStr = toDiscordTimestamp(targetTimestampMs, 'f');

                let updated = false;

                if (needs30Min) {
                    await targetChannel.send({
                        content: t(lang, 'pf.alert.in30', { name: dutyName, time: hammertimeStr, pings: pingList }),
                    }).catch(() => {});
                    listing.notified30Min = true;
                    updated = true;
                }

                if (needsExact) {
                    await targetChannel.send({
                        content: t(lang, 'pf.alert.now', { name: dutyName, pings: pingList }),
                    }).catch(() => {});
                    listing.notifiedExact = true;
                    listing.status = 'started';
                    updated = true;
                }

                if (updated) {
                    if (row.data) {
                        await db.query('UPDATE party_finders SET data = ? WHERE id = ?', [JSON.stringify(listing), listing.id]);
                    } else {
                        await db.query(
                            'UPDATE party_finders SET notified30Min = ?, notifiedExact = ?, status = ? WHERE id = ?',
                            [listing.notified30Min ? 1 : 0, listing.notifiedExact ? 1 : 0, listing.status || 'active', listing.id]
                        );
                    }
                }

                // the listing starts now (saved first, so it is never DMed twice): ask the host to post it again
                if (needsExact) await sendRepostDm(client, listing);
            }

        } catch (error) {
            console.error('Error running pfScheduler check:', error);
        }
    }, 5000);
}

module.exports = { startPfScheduler, REPOST_TTL_MS, repostCustomId, parseRepostCustomId, buildRepostDm, sendRepostDm };