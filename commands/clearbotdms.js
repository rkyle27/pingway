const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { tryLock, unlock, userKey } = require('../utils/lock');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clearbotdms')
        .setDescription(t('en', 'clearbotdms.cmd.description')).setDescriptionLocalizations(discordLocalizations('clearbotdms.cmd.description')),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        // Ensure this command is only used in Direct Messages (DMs)
        if (interaction.guildId) {
            return interaction.reply({
                content: t(lang, 'clearbotdms.onlyDms'),
                flags: [MessageFlags.Ephemeral]
            });
        }

        // One DM cleanup at a time per user (nobody else is blocked)
        const lockKey = userKey(interaction.user.id);
        if (!tryLock(lockKey, 'Clearing Bot DM Messages')) {
            return interaction.reply({
                content: t(lang, 'clearbotdms.alreadyRunning'),
                flags: [MessageFlags.Ephemeral]
            });
        }

        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

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
                content: t(lang, 'clearbotdms.done', { deletedCount })
            });

        } catch (error) {
            console.error('❌ Error executing /clearbotdms:', error);
            return await interaction.editReply({
                content: t(lang, 'clearbotdms.failed')
            });
        } finally {
            // Always release this user's lock when finished (also on errors)
            unlock(lockKey);
        }
    }
};