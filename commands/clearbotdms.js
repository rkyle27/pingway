const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { setBotBusy } = require('../utils/lock');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clearbotdms')
        .setDescription('🧹 Clear all direct messages sent by the bot in this DM channel.'),

    async execute(interaction) {
        // Ensure this command is only used in Direct Messages (DMs)
        if (interaction.guildId) {
            return interaction.reply({
                content: '⚠️ This command can only be used in **Direct Messages (DMs)** with the bot.',
                flags: [MessageFlags.Ephemeral]
            });
        }

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        // Set global lock so other heavy commands wait
        setBotBusy(true, 'Clearing Bot DM Messages');

        try {
            // Safely fetch or fall back to creating the DM channel if cached channel is null
            const channel = interaction.channel || await interaction.user.createDM();

            let deletedCount = 0;
            let lastId = null;

            while (true) {
                // Fetch up to 100 messages per call
                const options = { limit: 100 };
                if (lastId) options.before = lastId;

                const messages = await channel.messages.fetch(options);
                if (messages.size === 0) break;

                // Filter messages sent by the bot
                const botMessages = messages.filter(msg => msg.author.id === interaction.client.user.id);

                for (const msg of botMessages.values()) {
                    try {
                        await msg.delete();
                        deletedCount++;
                        // Pause 300ms to avoid Discord API rate limits
                        await new Promise(res => setTimeout(res, 300));
                    } catch (err) {
                        if (err.code !== 10008) { // Ignore already deleted messages
                            console.error(`Failed to delete message ${msg.id}:`, err);
                        }
                    }
                }

                lastId = messages.lastKey();
            }

            return await interaction.editReply({
                content: `✅ Successfully cleaned up **${deletedCount}** message(s) sent by the bot in this DM.`
            });

        } catch (error) {
            console.error('❌ Error executing /clearbotdms:', error);
            return await interaction.editReply({
                content: '❌ An error occurred while clearing DM messages.'
            });
        } finally {
            // Always release the lock when finished
            setBotBusy(false);
        }
    }
};