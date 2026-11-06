const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildHelpPayload } = require('../utils/helpContent');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription(t('en', 'help.cmd.description'))
        .setDescriptionLocalizations(discordLocalizations('help.cmd.description')),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        return interaction.reply({ ...buildHelpPayload(lang), flags: [MessageFlags.Ephemeral] });
    }
};
