const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const { isMaintenance } = require('../maintenance');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

module.exports = {
    // events/ready.js gives commands without a description "Execute the <name> command" (English stays as it was)
    data: { name: 'firmament', description_localizations: discordLocalizations('firmament.cmd.description') },
    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        // Maintenance Check: Block command execution when maintenance mode is ON (allows whitelisted servers to bypass)
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: t(lang, 'core.maintenance'),
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
                    .setLabel(t(lang, 'firmament.setCountdown'))
                    .setStyle(ButtonStyle.Primary)
            );

            const embed = new EmbedBuilder()
                .setTitle(t(lang, 'firmament.trackerTitleNew'))
                .setColor('#f1c40f')
                .setDescription(t(lang, 'firmament.noCountdown'));

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
            if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return t(lang, 'firmament.calculating');
            const totalHours = Math.floor(ms / (1000 * 60 * 60));
            const days = Math.floor(totalHours / 24);
            const hours = totalHours % 24;
            const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));

            if (days > 0) return t(lang, 'core.time.dhm', { d: days, h: hours, m: minutes });
            return t(lang, 'core.time.hm', { h: hours, m: minutes });
        };

        if (currentMacroCycleMs < ACTIVE_PERIOD) {
            const sessionProgressMs = currentMacroCycleMs % SESSION_INTERVAL;
            const activeSessionIndex = Math.floor(currentMacroCycleMs / SESSION_INTERVAL) + 1;

            if (sessionProgressMs < SESSION_DURATION) {
                statusTitle = t(lang, 'firmament.live');
                statusDescription = t(lang, 'firmament.running', { session: activeSessionIndex });
                countdownString = t(lang, 'firmament.timeRemaining', { time: formatMs(SESSION_DURATION - sessionProgressMs) });
            } else {
                statusTitle = t(lang, 'firmament.between');
                statusDescription = t(lang, 'firmament.preparing', { session: activeSessionIndex + 1 });
                countdownString = t(lang, 'firmament.nextSession', { time: formatMs(SESSION_INTERVAL - sessionProgressMs) });
            }
        } else {
            statusTitle = t(lang, 'firmament.cooldown');
            countdownString = t(lang, 'firmament.nextCelebration', { time: formatMs(nextCelebrationTimestamp - now) });
        }

        const embed = new EmbedBuilder()
            .setTitle(t(lang, 'firmament.trackerTitle'))
            .setColor('#f1c40f')
            .setDescription(t(lang, 'firmament.status', { title: statusTitle, description: statusDescription, countdown: countdownString }));

        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('toggle_firmament_dm')
                .setLabel(notifyDm ? t(lang, 'firmament.disableDm') : t(lang, 'firmament.getDm'))
                .setStyle(notifyDm ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('sync_firmament_timer')
                .setLabel(t(lang, 'firmament.setCountdown'))
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('remove_firmament_counter')
                .setLabel(t(lang, 'firmament.remove'))
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