const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const { isMaintenance } = require('../maintenance');

module.exports = {
    data: { name: 'firmament' },
    async execute(interaction) {
        // Maintenance Check: Block command execution when maintenance mode is ON (allows whitelisted servers to bypass)
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!',
                flags: [MessageFlags.Ephemeral]
            });
        }

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        let now = Date.now();

        let [rows] = await pool.execute(
            `SELECT next_celebration_timestamp, cycle_length, notify_dm FROM firmament_personal_data WHERE user_id = ?`,
            [userId]
        );

        const ACTIVE_PERIOD = 24 * 60 * 60 * 1000;
        const DEFAULT_CYCLE = 3 * 24 * 60 * 60 * 1000;

        // If no personal data exists, prompt user to calibrate/set actual countdown
        if (!rows || rows.length === 0) {
            const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('sync_firmament_timer')
                    .setLabel('⚙️ Set Actual Countdown')
                    .setStyle(ButtonStyle.Primary)
            );

            const embed = new EmbedBuilder()
                .setTitle('🏗️ Ishgard Restoration Tracker')
                .setColor('#f1c40f')
                .setDescription('⚠️ No personalized countdown found for you yet.\n\nCan only be done while Skyrise Celebration is on cooldown. Click the button below to set up your personal anchor!');

            return interaction.reply({ embeds: [embed], components: [actionRow], flags: [MessageFlags.Ephemeral] });
        }

        let nextCelebrationTimestamp = Number(rows[0].next_celebration_timestamp);
        let cycleLength = Number(rows[0].cycle_length || DEFAULT_CYCLE);
        const notifyDm = Boolean(rows[0].notify_dm);

        let stateChanged = false;
        while (now > nextCelebrationTimestamp) {
            nextCelebrationTimestamp += cycleLength;
            stateChanged = true;
        }

        if (stateChanged) {
            await pool.execute(
                `UPDATE firmament_personal_data SET next_celebration_timestamp = ? WHERE user_id = ?`,
                [nextCelebrationTimestamp, userId]
            );
        }

        const knownBaseStart = nextCelebrationTimestamp - cycleLength;
        const currentMacroCycleMs = now - knownBaseStart;
        const SESSION_INTERVAL = 2 * 60 * 60 * 1000;
        const SESSION_DURATION = 30 * 60 * 1000;

        let statusTitle = "", statusDescription = "", countdownString = "";

        const formatMs = (ms) => {
            if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return "Calculating...";
            const totalHours = Math.floor(ms / (1000 * 60 * 60));
            const days = Math.floor(totalHours / 24);
            const hours = totalHours % 24;
            const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));

            if (days > 0) return `${days}d ${hours}h ${minutes}m`;
            return `${hours}h ${minutes}m`;
        };

        if (currentMacroCycleMs < ACTIVE_PERIOD) {
            const sessionProgressMs = currentMacroCycleMs % SESSION_INTERVAL;
            const activeSessionIndex = Math.floor(currentMacroCycleMs / SESSION_INTERVAL) + 1;

            if (sessionProgressMs < SESSION_DURATION) {
                statusTitle = "🏰🎉 Skyrise Celebration is LIVE!🎉";
                statusDescription = `Running session **${activeSessionIndex} of 12**!`;
                countdownString = `**Time Remaining:** ${formatMs(SESSION_DURATION - sessionProgressMs)}`;
            } else {
                statusTitle = "⏱️ Between Sessions !!!";
                statusDescription = `Preparing for session **${activeSessionIndex + 1} of 12**.`;
                countdownString = `**Next session starts in:** ${formatMs(SESSION_INTERVAL - sessionProgressMs)}`;
            }
        } else {
            statusTitle = "💤 Skyrise Celebration is on cooldown...";
            countdownString = `**Next 24-hour celebration begins in:** ${formatMs(nextCelebrationTimestamp - now)}`;
        }

        const embed = new EmbedBuilder()
            .setTitle('🏰 Ishgard Restoration Tracker')
            .setColor('#f1c40f')
            .setDescription(`**Status:** ${statusTitle}\n${statusDescription}\n\n${countdownString}`);

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('toggle_firmament_dm')
                .setLabel(notifyDm ? '🔕 Disable DM Alerts' : '🔔 Get Notification DM')
                .setStyle(notifyDm ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('sync_firmament_timer')
                .setLabel('⚙️ Set Actual Countdown')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('remove_firmament_counter')
                .setLabel('🗑️ Remove Current Counter')
                .setStyle(ButtonStyle.Danger)
        );

        // Make sure guild_id is tracked on invocation too
        await pool.execute(`UPDATE firmament_personal_data SET guild_id = ? WHERE user_id = ?`, [guildId, userId]);

        if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ embeds: [embed], components: [actionRow] });
        }
        return interaction.reply({ embeds: [embed], components: [actionRow], flags: [MessageFlags.Ephemeral] });
    }
};