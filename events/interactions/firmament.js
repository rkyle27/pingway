const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { pool } = require('../../utils/db');
const { isMaintenance } = require('../../maintenance');

module.exports = {
    async handleInteraction(interaction) {
        // Maintenance Check: Block interaction when maintenance mode is ON (allows whitelisted servers to bypass)
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!',
                flags: [MessageFlags.Ephemeral]
            });
        }

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const cid = interaction.customId;

        // 1. Toggle Direct Message Notifications Handler
        if (interaction.isButton() && cid === 'toggle_firmament_dm') {
            const [rows] = await pool.execute(
                `SELECT notify_dm FROM firmament_personal_data WHERE user_id = ?`,
                [userId]
            );

            if (!rows || rows.length === 0) {
                return interaction.reply({
                    content: "❌ You need to set up your personal countdown first by clicking **⚙️ Set Actual Countdown**.",
                    flags: [MessageFlags.Ephemeral]
                });
            }

            const currentStatus = Boolean(rows[0].notify_dm);
            const newStatus = !currentStatus;

            // Update notify_dm status and save current guild_id for future DMs
            await pool.execute(
                `UPDATE firmament_personal_data SET notify_dm = ?, guild_id = ? WHERE user_id = ?`,
                [newStatus ? 1 : 0, guildId, userId]
            );

            return interaction.reply({
                content: newStatus
                    ? "🔔 **DM Notifications Enabled!** You will receive a direct message when your Skyrise Celebration begins."
                    : "🔕 **DM Notifications Disabled.** You will no longer receive direct messages for this event.",
                flags: [MessageFlags.Ephemeral]
            });
        }

        // 2. Remove Current Counter Handler
        if (interaction.isButton() && cid === 'remove_firmament_counter') {
            await pool.execute(
                `DELETE FROM firmament_personal_data WHERE user_id = ?`,
                [userId]
            );

            return interaction.reply({
                content: "🗑️ **Successfully removed your personal Firmament counter.** Run `/firmament` again anytime to set up a new anchor.",
                flags: [MessageFlags.Ephemeral]
            });
        }

        // 3. Firmament Sync Button Handler (Validation check for Cooldown)
        if (interaction.isButton() && cid === 'sync_firmament_timer') {
            const now = Date.now();
            const [rows] = await pool.execute(
                `SELECT next_celebration_timestamp, cycle_length FROM firmament_personal_data WHERE user_id = ?`,
                [userId]
            );

            if (rows && rows.length > 0) {
                const nextCelebrationTimestamp = Number(rows[0].next_celebration_timestamp);
                const cycleLength = Number(rows[0].cycle_length || (3 * 24 * 60 * 60 * 1000));
                const knownBaseStart = nextCelebrationTimestamp - cycleLength;
                const currentMacroCycleMs = now - knownBaseStart;
                const ACTIVE_PERIOD = 24 * 60 * 60 * 1000;

                if (currentMacroCycleMs < ACTIVE_PERIOD) {
                    return interaction.reply({
                        content: "❌ Can only be done while Skyrise Celebration is on cooldown.",
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }

            const modal = new ModalBuilder()
                .setCustomId('firmament_sync_modal')
                .setTitle('Set Actual Firmament Countdown');

            const daysInput = new TextInputBuilder()
                .setCustomId('sync_days')
                .setLabel('Days remaining (Enter 0 if < 1 day)')
                .setStyle(TextInputStyle.Short)
                .setValue('0')
                .setRequired(true);

            const hoursInput = new TextInputBuilder()
                .setCustomId('sync_hours')
                .setLabel('Hours remaining (0-23)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g., 14')
                .setRequired(true);

            const minutesInput = new TextInputBuilder()
                .setCustomId('sync_minutes')
                .setLabel('Minutes remaining (0-59)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g., 30')
                .setRequired(true);

            modal.addComponents(
                new ActionRowBuilder().addComponents(daysInput),
                new ActionRowBuilder().addComponents(hoursInput),
                new ActionRowBuilder().addComponents(minutesInput)
            );

            return await interaction.showModal(modal);
        }

        // 4. Firmament Sync Modal Submit Handler
        if (interaction.isModalSubmit() && cid === 'firmament_sync_modal') {
            const days = parseInt(interaction.fields.getTextInputValue('sync_days'), 10);
            const hours = parseInt(interaction.fields.getTextInputValue('sync_hours'), 10);
            const minutes = parseInt(interaction.fields.getTextInputValue('sync_minutes'), 10);

            if (isNaN(days) || isNaN(hours) || isNaN(minutes) || days < 0 || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
                return interaction.reply({
                    content: "❌ Invalid input. Ensure days >= 0, hours are 0–23, and minutes are 0–59.",
                    flags: [MessageFlags.Ephemeral]
                });
            }

            const now = Date.now();
            const totalRemainingMs = (days * 24 * 3600 * 1000) + (hours * 3600 * 1000) + (minutes * 60 * 1000);
            const nextCelebrationTimestamp = now + totalRemainingMs;
            const cycleLength = 3 * 24 * 60 * 60 * 1000;

            // Insert record with default notify_dm = 0 if new, or update timestamps without touching notify_dm if existing
            await pool.execute(
                `INSERT INTO firmament_personal_data (user_id, guild_id, next_celebration_timestamp, cycle_length, notify_dm) 
                 VALUES (?, ?, ?, ?, 0)
                 ON DUPLICATE KEY UPDATE 
                    guild_id = VALUES(guild_id), 
                    next_celebration_timestamp = VALUES(next_celebration_timestamp), 
                    cycle_length = VALUES(cycle_length)`,
                [userId, guildId, nextCelebrationTimestamp, cycleLength]
            );

            return interaction.reply({
                content: `✅ Successfully calibrated your personal timer! Next celebration is set for **${days}d ${hours}h ${minutes}m** from now.`,
                flags: [MessageFlags.Ephemeral]
            });
        }
    }
};