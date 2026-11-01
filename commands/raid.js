const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { fetchRaidSchedule } = require('../events/interactions/raidHandler');
const { pool } = require('../utils/db');
const { isMaintenance } = require('../maintenance');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('raid')
        .setDescription('📅 Check the upcoming raid schedule for the next 7 days.'),

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
            const [rows] = await pool.execute('SELECT raid_sheet_id FROM server_settings WHERE guild_id = ?', [guildId]);
            const spreadsheetId = rows[0]?.raid_sheet_id;

            // If not set up yet, handle setup
            if (!spreadsheetId) {
                if (!interaction.member.permissions.has('Administrator')) {
                    return await interaction.reply({
                        content: '⚠️ **Raid Planner Sheet not set up yet!**\nPlease ask a server Administrator to run the `/raid` command to configure the Google Sheet URL.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('Google Sheet Template')
                        .setStyle(ButtonStyle.Link)
                        .setURL('https://docs.google.com/spreadsheets/d/1ud9oeY779L94Es91Jix9OXApXaxU8mW1k025KWLrffE/edit?usp=sharing')
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('raid_setup_ok_btn')
                        .setLabel('OK')
                        .setStyle(ButtonStyle.Primary)
                );

                const instructions =
                    '⚠️ **Raid Planner Sheet not set up yet!**\n\n' +
                    '**Instructions:**\n' +
                    '1. Make a COPY of this Google Sheet "Raid Planner" (Rename it to whatever you want).\n' +
                    '2. Open your copy of Google Sheet, then COPY the FULL URL to be pasted on the window that will pop up.\n' +
                    '3. Click/Press OK when ready.';

                const response = await interaction.reply({
                    content: instructions,
                    components: [row1, row2],
                    flags: [MessageFlags.Ephemeral]
                });

                const filter = i => i.user.id === interaction.user.id && i.customId === 'raid_setup_ok_btn';
                try {
                    const confirmation = await response.awaitMessageComponent({ filter, time: 60000 });

                    const modal = new ModalBuilder()
                        .setCustomId('raid_setup_modal')
                        .setTitle('Raid Planner Google Sheet Setup');

                    const urlInput = new TextInputBuilder()
                        .setCustomId('sheet_url_input')
                        .setLabel('Google Sheet URL or ID')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('https://docs.google.com/spreadsheets/d/...')
                        .setRequired(true);

                    modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
                    return await confirmation.showModal(modal);
                } catch (e) {
                    return;
                }
            }

            // If already set up, safe to defer and fetch data
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            }

            const replyMessage = await fetchRaidSchedule(guildId);
            const isAdmin = interaction.member.permissions.has('Administrator');

            // Add Open Google Sheet button and Remove button (disabled if not admin) alongside the schedule output
            const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Open Google Sheet')
                    .setStyle(ButtonStyle.Link)
                    .setURL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`),
                new ButtonBuilder()
                    .setCustomId('raid_remove_sheet_btn')
                    .setLabel('Remove Raid Google Sheet')
                    .setStyle(ButtonStyle.Danger)
                    .setDisabled(!isAdmin)
            );

            const response = await interaction.editReply({ 
                content: replyMessage, 
                components: [actionRow] 
            });

            if (!isAdmin) return;

            const filter = i => i.customId === 'raid_remove_sheet_btn';
            const collector = response.createMessageComponentCollector({ filter, time: 60000 });

            collector.on('collect', async i => {
                if (!i.member.permissions.has('Administrator')) {
                    return await i.reply({
                        content: '⚠️ Only an administrator can execute this task.',
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('raid_remove_confirm_yes')
                        .setLabel('Yes, Remove')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('raid_remove_confirm_no')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Secondary)
                );

                const confirmMsg = await i.reply({
                    content: '⚠️ **Are you sure you want to remove the raid Google Sheet link for this server?**',
                    components: [confirmRow],
                    flags: [MessageFlags.Ephemeral],
                    withResponse: true
                }).then(res => res.resource.message);

                try {
                    const confirmation = await confirmMsg.awaitMessageComponent({
                        filter: btnInteraction => btnInteraction.user.id === i.user.id,
                        time: 30000
                    });

                    if (confirmation.customId === 'raid_remove_confirm_yes') {
                        await pool.execute('UPDATE server_settings SET raid_sheet_id = NULL WHERE guild_id = ?', [guildId]);
                        await confirmation.update({
                            content: '✅ Raid Google Sheet link has been successfully removed from the database.',
                            components: []
                        });
                        await interaction.editReply({ components: [] }).catch(() => {});
                    } else {
                        await confirmation.update({
                            content: '❌ Removal cancelled.',
                            components: []
                        });
                    }
                } catch (err) {
                    // Interaction timed out
                }
            });

        } catch (error) {
            console.error('❌ Error in /raid execution:', error);
            if (interaction.deferred || interaction.replied) {
                return await interaction.editReply({ content: '❌ An error occurred while checking the raid schedule.' }).catch(() => { });
            } else {
                return await interaction.reply({ content: '❌ An error occurred while checking the raid schedule.', flags: [MessageFlags.Ephemeral] }).catch(() => { });
            }
        }
    }
};