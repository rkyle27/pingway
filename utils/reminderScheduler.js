const { pool } = require('./db');
const { REST, Routes } = require('discord.js');
const { isMaintenance } = require('../maintenance');
const { t } = require('./i18n');
const userLanguage = require('./userLanguage');

// Give up on a reminder after this many failed delivery attempts (channel gone AND DMs closed)
const MAX_SEND_ATTEMPTS = 5;
const failedAttempts = new Map();

function startReminderScheduler(client) {
    console.log('⏰ Reminder background scheduler started.');

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    // Check every 10 seconds for due reminders
    setInterval(async () => {
        // Skip execution if global maintenance mode is active
        if (isMaintenance()) return;

        try {
            const now = Date.now();

            // Fetch all pending reminders that are due
            const [rows] = await pool.execute(
                `SELECT id, guild_id, channel_id, user_id, reminder_text, target_timestamp, is_recurring, recurrence_rule 
                 FROM reminders 
                 WHERE is_sent = FALSE AND target_timestamp <= ?`,
                [now]
            );

            if (!rows || rows.length === 0) return;

            for (const reminder of rows) {
                // Skip individual reminders if their home guild is in maintenance
                if (reminder.guild_id && isMaintenance(reminder.guild_id)) {
                    continue;
                }

                try {
                    let sentSuccessfully = false;
                    const discordUnix = Math.floor(reminder.target_timestamp / 1000);
                    const lang = await userLanguage.forUser(reminder.user_id); // a reminder for one user: their language
                    const messageContent = t(lang, 'reminders.channel', { userId: reminder.user_id, text: reminder.reminder_text, time: discordUnix });

                    // 1. Try sending directly to the channel via Discord REST API
                    try {
                        await rest.post(Routes.channelMessages(reminder.channel_id), {
                            body: { content: messageContent }
                        });
                        sentSuccessfully = true;
                    } catch (channelErr) {
                        console.warn(`⚠️ REST failed to send reminder ${reminder.id} to channel ${reminder.channel_id}. Trying DM fallback...`);
                    }

                    // 2. Fallback: Send DM to user
                    if (!sentSuccessfully) {
                        try {
                            const dmChannel = await rest.post(Routes.userChannels(), {
                                body: { recipient_id: reminder.user_id }
                            });

                            if (dmChannel && dmChannel.id) {
                                await rest.post(Routes.channelMessages(dmChannel.id), {
                                    body: { content: t(lang, 'reminders.dm', { text: reminder.reminder_text }) }
                                });
                                sentSuccessfully = true;
                            }
                        } catch (dmErr) {
                            console.error(`❌ Failed to send reminder ${reminder.id} via REST DM:`, dmErr.message);
                        }
                    }

                    // Track failed deliveries so undeliverable reminders don't retry forever
                    let gaveUp = false;
                    if (sentSuccessfully) {
                        failedAttempts.delete(reminder.id);
                    } else {
                        const attempts = (failedAttempts.get(reminder.id) || 0) + 1;
                        failedAttempts.set(reminder.id, attempts);
                        if (attempts >= MAX_SEND_ATTEMPTS) {
                            failedAttempts.delete(reminder.id);
                            gaveUp = true;
                            console.warn(`⚠️ Giving up on reminder ${reminder.id} after ${attempts} failed delivery attempts (channel unavailable and DMs closed).`);
                        }
                    }

                    // 3. Handle Completion / Recurrence Calculation
                    if (sentSuccessfully || gaveUp) {
                        if (reminder.is_recurring) {
                            let intervalMs = 86400000; // Default: +24 hours
                            const rule = (reminder.recurrence_rule || '').toLowerCase();

                            if (rule.includes('minute')) {
                                const match = rule.match(/(\d+)\s*min/);
                                const mins = match ? parseInt(match[1], 10) : 1;
                                intervalMs = mins * 60 * 1000;
                            } else if (rule.includes('hour')) {
                                const match = rule.match(/(\d+)\s*hour/);
                                const hours = match ? parseInt(match[1], 10) : 1;
                                intervalMs = hours * 60 * 60 * 1000;
                            } else if (rule.includes('week')) {
                                const match = rule.match(/(\d+)\s*week/);
                                const weeks = match ? parseInt(match[1], 10) : 1;
                                intervalMs = weeks * 7 * 24 * 60 * 60 * 1000;
                            }

                            let nextTimestamp = reminder.target_timestamp + intervalMs;

                            // Prevent infinite/stuck loops by ensuring timestamp advances past 'now'
                            while (nextTimestamp <= now) {
                                nextTimestamp += intervalMs;
                            }

                            await pool.execute(
                                `UPDATE reminders SET target_timestamp = ? WHERE id = ?`,
                                [nextTimestamp, reminder.id]
                            );
                            console.log(`🔁 Successfully triggered and advanced recurring reminder ID ${reminder.id} using rule: [${reminder.recurrence_rule || 'Daily'}]`);
                        } else {
                            await pool.execute(
                                `DELETE FROM reminders WHERE id = ?`,
                                [reminder.id]
                            );
                            console.log(`🗑️ Successfully sent and deleted one-time reminder ID ${reminder.id}`);
                        }
                    }
                } catch (innerErr) {
                    console.error(`❌ Failed to process reminder ID ${reminder.id}:`, innerErr.message);
                }
            }
        } catch (error) {
            console.error('❌ Error in reminder scheduler loop:', error);
        }
    }, 10000);
}

module.exports = { startReminderScheduler };