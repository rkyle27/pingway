const { SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const { isMaintenance } = require('../maintenance');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('logger')
        .setDescription('⚙️ Set up or update the Google Sheet logging destination for this server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        // Maintenance Check: Block command execution when maintenance mode is ON (allows whitelisted servers to bypass)
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!',
                flags: [MessageFlags.Ephemeral]
            });
        }

        const guildId = interaction.guildId;

        try {
            // Check if logger sheet is already set up in the database
            const [rows] = await pool.execute('SELECT logger_sheet_id FROM server_settings WHERE guild_id = ?', [guildId]);
            const loggerSheetId = rows[0]?.logger_sheet_id;

            if (loggerSheetId) {
                // Already set up: ask to remove or cancel
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('logger_remove_btn')
                        .setLabel('Remove Google Sheet')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('logger_cancel_btn')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Secondary)
                );

                const response = await interaction.reply({
                    content: '⚠️ **A logger Google Sheet is currently configured for this server.**\nWould you like to remove it or cancel?',
                    components: [row],
                    flags: [MessageFlags.Ephemeral]
                });

                const filter = i => i.user.id === interaction.user.id;
                try {
                    const confirmation = await response.awaitMessageComponent({ filter, time: 60000 });

                    if (confirmation.customId === 'logger_cancel_btn') {
                        return await confirmation.update({ content: '❌ Logger configuration action cancelled.', components: [] });
                    }

                    if (confirmation.customId === 'logger_remove_btn') {
                        // Ask for confirmation before final removal
                        const confirmRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('logger_confirm_yes')
                                .setLabel('Yes, Remove')
                                .setStyle(ButtonStyle.Danger),
                            new ButtonBuilder()
                                .setCustomId('logger_confirm_no')
                                .setLabel('No')
                                .setStyle(ButtonStyle.Secondary)
                        );

                        const confirmResponse = await confirmation.update({
                            content: '⚠️ **Are you sure you want to remove the logger Google Sheet link?**',
                            components: [confirmRow]
                        });

                        const finalConfirmation = await confirmResponse.awaitMessageComponent({ filter, time: 60000 });

                        if (finalConfirmation.customId === 'logger_confirm_no') {
                            return await finalConfirmation.update({ content: '❌ Removal cancelled.', components: [] });
                        }

                        if (finalConfirmation.customId === 'logger_confirm_yes') {
                            await pool.execute('UPDATE server_settings SET logger_sheet_id = NULL WHERE guild_id = ?', [guildId]);
                            return await finalConfirmation.update({
                                content: `"${interaction.user.tag}" successfully removed logger google sheet. Use /logger again to initialize the set up.`,
                                components: []
                            });
                        }
                    }
                } catch (e) {
                    return await interaction.editReply({ content: '⏳ Interaction timed out.', components: [] }).catch(() => {});
                }
            }

            // If not set up, show setup modal
            const modal = new ModalBuilder()
                .setCustomId('logger_setup_modal')
                .setTitle('Google Sheets Logger Setup');

            const urlInput = new TextInputBuilder()
                .setCustomId('logger_url_input')
                .setLabel('Logger Google Sheet URL or ID')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://docs.google.com/spreadsheets/d/...')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
            return await interaction.showModal(modal);
        } catch (error) {
            console.error('❌ Error in /logger execution:', error);
            if (interaction.deferred || interaction.replied) {
                return await interaction.editReply({ content: '❌ An error occurred while executing the logger command.' }).catch(() => {});
            } else {
                return await interaction.reply({ content: '❌ An error occurred while executing the logger command.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
        }
    }
};