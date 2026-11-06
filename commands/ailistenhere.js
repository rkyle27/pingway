const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// The AI listens in ONE channel per server. Running this in another channel moves it here;
// running it in the AI channel itself turns the AI off.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('ailistenhere')
        .setDescription(t('en', 'ailistenhere.cmd.description')).setDescriptionLocalizations(discordLocalizations('ailistenhere.cmd.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
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
                    content: t(lang, 'ailistenhere.off', { channelId }),
                    flags: [MessageFlags.Ephemeral]
                });
            }

            await conn.execute(`DELETE FROM ai_active_channels WHERE guild_id = ?`, [guildId]);
            await conn.execute(`INSERT INTO ai_active_channels (guild_id, channel_id) VALUES (?, ?)`, [guildId, channelId]);
            await conn.commit();
            const moved = old.length ? t(lang, 'ailistenhere.moved', { channels: old.map(id => `<#${id}>`).join(', ') }) : '';
            return interaction.reply({
                content: t(lang, 'ailistenhere.on', { channelId, moved }),
                flags: [MessageFlags.Ephemeral]
            });
        } catch (e) {
            await conn.rollback().catch(() => {});
            console.error('Failed to set the AI channel in MySQL:', e);
            return interaction.reply({
                content: t(lang, 'ailistenhere.failed'),
                flags: [MessageFlags.Ephemeral]
            });
        } finally {
            conn.release();
        }
    }
};
