const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ailistenhere')
        .setDescription('🎙️ Toggle AI auto-response mode in this channel (Admin only).')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        const channelId = interaction.channelId;
        const guildId = interaction.guildId;

        try {
            const [rows] = await pool.execute(`SELECT channel_id FROM ai_active_channels WHERE guild_id = ? AND channel_id = ?`, [guildId, channelId]);
            const isActive = rows.length > 0;

            if (isActive) {
                await pool.execute(`DELETE FROM ai_active_channels WHERE guild_id = ? AND channel_id = ?`, [guildId, channelId]);
                return interaction.reply({
                    content: `🔴 AI is no longer listening in <#${channelId}>.`,
                    flags: [MessageFlags.Ephemeral]
                });
            } else {
                await pool.execute(`INSERT INTO ai_active_channels (guild_id, channel_id) VALUES (?, ?)`, [guildId, channelId]);
                return interaction.reply({
                    content: `🟢 AI is now actively listening in <#${channelId}>! All normal messages in this channel will get AI responses.`,
                    flags: [MessageFlags.Ephemeral]
                });
            }
        } catch (e) {
            console.error('Failed to toggle active channel in MySQL:', e);
            return interaction.reply({
                content: `❌ Failed to update channel listening state.`,
                flags: [MessageFlags.Ephemeral]
            });
        }
    }
};