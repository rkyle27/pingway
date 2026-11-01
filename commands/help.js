const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { buildHelpPayload } = require('../utils/helpContent');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('📖 Lists all available Pingway bot commands and instructions.'),

    async execute(interaction) {
        return interaction.reply({ ...buildHelpPayload(), flags: [MessageFlags.Ephemeral] });
    }
};
