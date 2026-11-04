const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');

// The AI listens in ONE channel per server. Running this in another channel moves it here;
// running it in the AI channel itself turns the AI off.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('ailistenhere')
        .setDescription('🎙️ Move the AI to this channel, or turn it off if it is already here (Admin only).')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        const channelId = interaction.channelId;
        const guildId = interaction.guildId;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [rows] = await conn.execute(`SELECT channel_id FROM ai_active_channels WHERE guild_id = ? FOR UPDATE`, [guildId]);
            const old = rows.map(r => String(r.channel_id));

            if (old.includes(channelId)) {
                await conn.execute(`DELETE FROM ai_active_channels WHERE guild_id = ?`, [guildId]);
                await conn.commit();
                return interaction.reply({
                    content: `🔴 AI is no longer listening in <#${channelId}>.`,
                    flags: [MessageFlags.Ephemeral]
                });
            }

            await conn.execute(`DELETE FROM ai_active_channels WHERE guild_id = ?`, [guildId]);
            await conn.execute(`INSERT INTO ai_active_channels (guild_id, channel_id) VALUES (?, ?)`, [guildId, channelId]);
            await conn.commit();
            const moved = old.length ? ` It moved here from ${old.map(id => `<#${id}>`).join(', ')} (one AI channel per server).` : '';
            return interaction.reply({
                content: `🟢 AI is now actively listening in <#${channelId}>! All normal messages in this channel will get AI responses.${moved}`,
                flags: [MessageFlags.Ephemeral]
            });
        } catch (e) {
            await conn.rollback().catch(() => {});
            console.error('Failed to set the AI channel in MySQL:', e);
            return interaction.reply({
                content: `❌ Failed to update the AI channel.`,
                flags: [MessageFlags.Ephemeral]
            });
        } finally {
            conn.release();
        }
    }
};
