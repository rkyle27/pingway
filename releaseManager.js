const { pool } = require('./utils/db');
const { toDiscordTimestamp } = require('./utils/hammertime');
const { isMaintenance } = require('./maintenance');

function startEvercoldScheduler(client) {
    // Check every 30 seconds for upcoming or due releases
    setInterval(async () => {
        // Skip execution if maintenance mode is active
        if (isMaintenance()) return;

        try {
            const [rows] = await pool.execute(
                `SELECT * FROM server_releases WHERE is_notified = FALSE`
            );

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
                        const guild = await client.guilds.fetch(guild_id).catch(() => null);
                        if (!guild) continue;

                        const channel = await guild.channels.fetch(channel_id).catch(() => null);
                        if (!channel || !channel.isTextBased()) continue;

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
                        console.error(`[ReleaseManager Error] Failed to send notification for guild ${guild_id}:`, err.message);
                    }
                }
            }
        } catch (error) {
            console.error('❌ Error in releaseManager background scheduler:', error);
        }
    }, 30000);
}

module.exports = { startEvercoldScheduler };