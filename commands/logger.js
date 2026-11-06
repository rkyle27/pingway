const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { run } = require('../utils/sheetMenu');
const { t, discordLocalizations } = require('../utils/i18n');

// /logger (admins only): open or create the server's logger sheets. Every slash command used in the server is
// written to the logger sheets that are ON. Manage them on the website (server settings -> Raid & Logger).
module.exports = {
    data: new SlashCommandBuilder()
        .setName('logger')
        .setDescription(t('en', 'sheets.cmd.logger')).setDescriptionLocalizations(discordLocalizations('sheets.cmd.logger'))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        return run(interaction, 'log');
    }
};
