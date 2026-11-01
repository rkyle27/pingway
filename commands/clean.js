const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { setBotBusy, isBotBusy } = require('../utils/lock');

// Helper to delay execution and prevent hitting Discord rate limits
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clean')
        .setDescription('🧹 Bulk delete messages (including older than 14 days).')
        .addStringOption(option =>
            option.setName('target')
                .setDescription('Number of messages to delete (e.g. 5, 67) or "all"')
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        // Prevent running multiple clean tasks at the same time
        if (isBotBusy()) {
            return interaction.reply({
                content: '⚠️ A cleanup task is already running in the background! Please wait for it to finish.',
                flags: [MessageFlags.Ephemeral]
            });
        }

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const targetOption = interaction.options.getString('target').trim().toLowerCase();
        let deletedTotal = 0;
        let isAll = targetOption === 'all';
        let targetAmount = isAll ? Infinity : parseInt(targetOption, 10);

        if (!isAll && (isNaN(targetAmount) || targetAmount <= 0)) {
            return interaction.editReply({
                content: '❌ Invalid input. Please enter a positive number (e.g., `/clean 5`) or `"all"`.'
            });
        }

        // Set system lock so other heavy operations wait
        setBotBusy(true, 'Cleaning channel messages');

        const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
        let lastEditTime = Date.now();

        try {
            while (deletedTotal < targetAmount) {
                const fetchLimit = Math.min(targetAmount - deletedTotal, 100);
                const fetched = await interaction.channel.messages.fetch({ limit: fetchLimit });

                if (fetched.size === 0) break;

                const recentMessages = fetched.filter(msg => msg.createdTimestamp > fourteenDaysAgo);
                const oldMessages = fetched.filter(msg => msg.createdTimestamp <= fourteenDaysAgo);

                // 1. Bulk Delete for recent messages (<14 days old)
                if (recentMessages.size > 0) {
                    const deletedBulk = await interaction.channel.bulkDelete(recentMessages, true);
                    deletedTotal += deletedBulk.size;
                }

                // 2. Single Delete for messages older than 14 days
                if (oldMessages.size > 0 && deletedTotal < targetAmount) {
                    for (const msg of oldMessages.values()) {
                        if (deletedTotal >= targetAmount) break;
                        try {
                            await msg.delete();
                            deletedTotal++;
                            // 1-second delay keeps the bot within Discord's rate limits
                            await sleep(1000);
                        } catch (err) {
                            // If message was already deleted or unobtainable, keep going
                        }

                        // Safely update the user every 10 seconds without spamming token edits
                        if (Date.now() - lastEditTime > 10000) {
                            lastEditTime = Date.now();
                            try {
                                await interaction.editReply({
                                    content: `🧹 Cleaning in progress... Deleted **${deletedTotal}** message(s) so far.`
                                });
                            } catch (e) {
                                // Ignore interaction token expiration error—loop keeps deleting!
                            }
                        }
                    }
                }

                // If no messages could be deleted in this pass, break out to avoid infinite loop
                if (recentMessages.size === 0 && oldMessages.size === 0) break;
            }

            // Final status update
            try {
                await interaction.editReply({
                    content: `🧹 **Clean Complete!** Successfully deleted **${deletedTotal}** message(s).`
                });
            } catch (e) {
                // Follow up if interaction token expired
                await interaction.followUp({
                    content: `🧹 **Clean Complete!** Successfully deleted **${deletedTotal}** message(s).`,
                    flags: [MessageFlags.Ephemeral]
                });
            }

        } catch (error) {
            console.error('Error during clean execution:', error);
            try {
                await interaction.editReply({ content: '❌ An error occurred during channel cleanup.' });
            } catch (e) { }
        } finally {
            // Unlocks system when clean task completes or exits
            setBotBusy(false);
        }
    }
};