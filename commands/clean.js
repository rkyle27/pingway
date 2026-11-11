const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { tryLock, unlock, channelKey } = require('../utils/lock');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// Helper to delay execution and prevent hitting Discord rate limits
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// A clean that is still running after 30 minutes stops (very old messages are deleted one by one)
const TIME_LIMIT_MS = 30 * 60 * 1000;

module.exports = {
    TIME_LIMIT_MS,
    data: new SlashCommandBuilder()
        .setName('clean')
        .setDescription(t('en', 'clean.cmd.description')).setDescriptionLocalizations(discordLocalizations('clean.cmd.description'))
        .addStringOption(option =>
            option.setName('target')
                .setDescription(t('en', 'clean.cmd.target')).setDescriptionLocalizations(discordLocalizations('clean.cmd.target'))
                .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        // One clean at a time per channel (other channels / servers / commands are not blocked)
        const lockKey = channelKey(interaction.channelId || (interaction.channel && interaction.channel.id));
        if (!tryLock(lockKey, 'Cleaning channel messages')) {
            return interaction.reply({
                content: t(lang, 'clean.alreadyRunning'),
                flags: [MessageFlags.Ephemeral]
            });
        }

        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const targetOption = interaction.options.getString('target').trim().toLowerCase();
            let deletedTotal = 0;
            let isAll = targetOption === 'all';
            let targetAmount = isAll ? Infinity : parseInt(targetOption, 10);

            if (!isAll && (isNaN(targetAmount) || targetAmount <= 0)) {
                return await interaction.editReply({
                    content: t(lang, 'clean.invalid')
                });
            }

            const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
            let lastEditTime = Date.now();
            const startedAt = Date.now();
            let timedOut = false;
            const overTime = () => Date.now() - startedAt >= TIME_LIMIT_MS;

            try {
                while (deletedTotal < targetAmount) {
                    if (overTime()) { timedOut = true; break; }
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
                            if (overTime()) { timedOut = true; break; }
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
                                        content: t(lang, 'clean.progress', { deletedTotal })
                                    });
                                } catch (e) {
                                    // Ignore interaction token expiration error—loop keeps deleting!
                                }
                            }
                        }
                    }
                    if (timedOut) break;

                    // If no messages could be deleted in this pass, break out to avoid infinite loop
                    if (recentMessages.size === 0 && oldMessages.size === 0) break;
                }

                // Final status update (stopped after 30 minutes, or done)
                const finalText = timedOut
                    ? t(lang, 'clean.timeLimit', { deletedTotal })
                    : t(lang, 'clean.complete', { deletedTotal });
                try {
                    await interaction.editReply({ content: finalText });
                } catch (e) {
                    // Follow up if interaction token expired
                    await interaction.followUp({
                        content: finalText,
                        flags: [MessageFlags.Ephemeral]
                    }).catch(() => { });
                }

            } catch (error) {
                console.error('Error during clean execution:', error);
                try {
                    await interaction.editReply({ content: t(lang, 'clean.failed') });
                } catch (e) { }
            }
        } finally {
            // Unlocks this channel when the clean task completes or exits (also on errors)
            unlock(lockKey);
        }
    }
};
