const { pool } = require('./db');
const { isMaintenance } = require('../maintenance');
const { t } = require('./i18n');
const userLanguage = require('./userLanguage');

function startFirmamentScheduler(client) {
    // Check every 10 seconds
    setInterval(async () => {
        // Skip execution if global maintenance mode is active
        if (isMaintenance()) return;

        try {
            const now = Date.now();
            
            // Query users due for notification
            const [rows] = await pool.execute(
                `SELECT user_id, next_celebration_timestamp, cycle_length, guild_id FROM firmament_personal_data WHERE notify_dm = 1 AND next_celebration_timestamp <= ?`,
                [now]
            );

            if (!rows || rows.length === 0) return;

            for (const row of rows) {
                const userId = row.user_id;
                const guildId = row.guild_id;
                let nextCelebration = Number(row.next_celebration_timestamp);
                const cycleLength = Number(row.cycle_length || (3 * 24 * 60 * 60 * 1000));

                // Skip if originating guild is in maintenance
                if (guildId && isMaintenance(guildId)) {
                    continue;
                }

                // Advance timer first to prevent duplicate processing on slow DM sends
                while (now >= nextCelebration) {
                    nextCelebration += cycleLength;
                }

                // Update database immediately
                await pool.execute(
                    `UPDATE firmament_personal_data SET next_celebration_timestamp = ? WHERE user_id = ?`,
                    [nextCelebration, userId]
                ).catch(err => console.error(`[ERROR] Failed to update celebration timestamp for user ${userId}:`, err.message));

                const lang = await userLanguage.forUser(userId); // DM: the user's language
                // Fetch guild name if available
                let serverName = t(lang, 'firmament.thisServer');
                if (guildId) {
                    try {
                        const guild = await client.guilds.fetch(guildId).catch(() => null);
                        if (guild) {
                            serverName = `**${guild.name}**`;
                        }
                    } catch (e) {
                        // Ignore guild fetch errors
                    }
                }

                // Send DM notification
                try {
                    const user = await client.users.fetch(userId).catch(() => null);
                    if (user) {
                        const messageText = t(lang, 'firmament.dmStarting', { server: serverName });
                        await user.send(messageText);
                        console.log(`[SUCCESS] Sent Firmament DM notification to user ${userId}`);
                    }
                } catch (dmErr) {
                    console.error(`[ERROR] Could not send Firmament DM to user ${userId}:`, dmErr.message);
                }
            }
        } catch (error) {
            console.error('❌ Error in Firmament background scheduler:', error);
        }
    }, 10000);
}

module.exports = { startFirmamentScheduler };