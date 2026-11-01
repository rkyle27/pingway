const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const fs = require('fs');
const path = require('path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notifhere')
        .setDescription('⚙️ Set this channel for startup notifications.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const guildId = interaction.guild.id;
        const channelId = interaction.channel.id;

        try {
            // Upsert the startup channel ID into your MySQL server_settings table
            await pool.execute(
                `INSERT INTO server_settings (guild_id, startup_channel_id) 
                 VALUES (?, ?) 
                 ON DUPLICATE KEY UPDATE startup_channel_id = ?`,
                [guildId, channelId, channelId]
            );

            // Read funnyMessages.txt dynamically from the root folder
            let randomJoke = "";
            try {
                const filePath = path.join(process.cwd(), 'funnyMessages.txt');
                if (fs.existsSync(filePath)) {
                    const fileContent = fs.readFileSync(filePath, 'utf8');
                    // Split lines and filter out empty ones
                    const lines = fileContent.split(/\r?\n/).filter(line => line.trim().length > 0);
                    if (lines.length > 0) {
                        const randomIndex = Math.floor(Math.random() * lines.length);
                        randomJoke = `\n\n*${lines[randomIndex]}*`;
                    }
                }
            } catch (err) {
                console.error('⚠️ [NOTIFHERE] Failed to read funnyMessages.txt:', err.message);
            }

            return await interaction.reply({
                content: `✅ Notifications for this server will now be sent to <#${channelId}>!${randomJoke}`,
                flags: [MessageFlags.Ephemeral]
            });
        } catch (error) {
            console.error('❌ Failed to save startup channel to database:', error);
            return await interaction.reply({
                content: '❌ An error occurred while saving the notification channel setting.',
                flags: [MessageFlags.Ephemeral]
            });
        }
    }
};