const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const fs = require('fs');
const path = require('path');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notifhere')
        .setDescription(t('en', 'notifhere.cmd.description')).setDescriptionLocalizations(discordLocalizations('notifhere.cmd.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
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
                content: t(lang, 'notifhere.saved', { channelId, joke: randomJoke }),
                flags: [MessageFlags.Ephemeral]
            });
        } catch (error) {
            console.error('❌ Failed to save startup channel to database:', error);
            return await interaction.reply({
                content: t(lang, 'notifhere.failed'),
                flags: [MessageFlags.Ephemeral]
            });
        }
    }
};