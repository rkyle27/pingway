const { pool } = require('./utils/db');
const { toDiscordTimestamp } = require('./utils/hammertime');
const { isMaintenance } = require('./maintenance');

// The database host sometimes closes idle connections ("Connection lost"). The read below is safe to repeat,
// so it is tried once more after a short wait. If it still fails, one short warning is logged (at most every
// 10 minutes) and the next check 30 seconds later tries again.
const CONNECTION_ERRORS = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'PROTOCOL_SEQUENCE_TIMEOUT']);
const isConnectionError = err => !!err && (CONNECTION_ERRORS.has(err.code) || /connection lost|closed state|server has gone away/i.test(err.message || ''));
let lastConnectionWarning = 0;

// A release whose server, channel or permissions are gone keeps failing. Once it is more than a day late,
// stop trying: mark it as notified (nothing is sent) so it is not checked every 30 seconds forever.
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
async function giveUp(guildId, eventName, reason) {
    await pool.execute(`UPDATE server_releases SET is_notified = TRUE WHERE guild_id = ?`, [guildId]);
    console.log(`[ReleaseManager] Skipped "${eventName}" for server ${guildId} (${reason}, more than a day late).`);
}

async function readPendingReleases() {
    const sql = `SELECT * FROM server_releases WHERE is_notified = FALSE`;
    try {
        return await pool.execute(sql);
    } catch (err) {
        if (!isConnectionError(err)) throw err;
        await new Promise(resolve => setTimeout(resolve, 2000));
        return pool.execute(sql); // one retry on a fresh connection
    }
}

function startEvercoldScheduler(client) {
    // Check every 30 seconds for upcoming or due releases
    setInterval(async () => {
        // Skip execution if maintenance mode is active
        if (isMaintenance()) return;

        try {
            const [rows] = await readPendingReleases();

            if (!rows || rows.length === 0) return;

            const now = Date.now();

            for (const row of rows) {
                const { guild_id, event_name, release_time, role_id, channel_id } = row;
                
                // Properly parse numeric timestamps or UTC date strings ("YYYY/MM/DD HH:mm:ss")
                let targetTimestampMs = null;
                if (!isNaN(release_time)) {
                    targetTimestampMs = Number(release_time);
                } else if (typeof release_time === 'string') {
                    const parts = release_time.split(' ');
                    if (parts.length === 2) {
                        const [y, m, d] = parts[0].split('/');
                        const timeParts = parts[1].split(':');
                        const h = timeParts[0];
                        const min = timeParts[1] || 0;
                        const s = timeParts[2] || 0;

                        if (y && m && d && h) {
                            targetTimestampMs = Date.UTC(
                                parseInt(y, 10),
                                parseInt(m, 10) - 1,
                                parseInt(d, 10),
                                parseInt(h, 10),
                                parseInt(min, 10),
                                parseInt(s, 10)
                            );
                        }
                    } else {
                        targetTimestampMs = new Date(release_time).getTime();
                    }
                }
                
                if (!targetTimestampMs || isNaN(targetTimestampMs)) continue;

                // Fire notification if release time has arrived or passed
                if (targetTimestampMs <= now) {
                    try {
                        const tooLate = now - targetTimestampMs > GIVE_UP_AFTER_MS;
                        const guild = await client.guilds.fetch(guild_id).catch(() => null);
                        if (!guild) {
                            if (tooLate) await giveUp(guild_id, event_name, 'Pingway is no longer in that server');
                            continue;
                        }

                        const channel = await guild.channels.fetch(channel_id).catch(() => null);
                        if (!channel || !channel.isTextBased()) {
                            if (tooLate) await giveUp(guild_id, event_name, 'channel not found');
                            continue;
                        }

                        const roleMention = role_id ? `<@&${role_id}>` : '';
                        const hammertimeStr = toDiscordTimestamp(targetTimestampMs, 'f');
                        const relativeTime = toDiscordTimestamp(targetTimestampMs, 'R');

                        await channel.send({
                            content: `🚨 **Event Release Alert!**\n\n**${event_name}** is starting now! (${hammertimeStr} / ${relativeTime}) ${roleMention}`
                        });

                        // Mark as notified so it doesn't spam repeatedly
                        await pool.execute(
                            `UPDATE server_releases SET is_notified = TRUE WHERE guild_id = ?`,
                            [guild_id]
                        );
                        console.log(`[ReleaseManager] Sent notification for guild ${guild.name} (${event_name})`);
                    } catch (err) {
                        if (now - targetTimestampMs > GIVE_UP_AFTER_MS) {
                            await giveUp(guild_id, event_name, 'could not post: ' + err.message).catch(() => {});
                        } else {
                            console.error(`[ReleaseManager Error] Failed to send notification for guild ${guild_id}:`, err.message);
                        }
                    }
                }
            }
        } catch (error) {
            if (isConnectionError(error)) {
                if (Date.now() - lastConnectionWarning > 10 * 60 * 1000) {
                    lastConnectionWarning = Date.now();
                    console.warn('⚠️ [ReleaseManager] Database connection lost twice in a row; will try again in 30 seconds.');
                }
                return;
            }
            console.error('❌ Error in releaseManager background scheduler:', error);
        }
    }, 30000);
}

module.exports = { startEvercoldScheduler };