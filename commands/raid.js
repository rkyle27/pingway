const { SlashCommandBuilder } = require('discord.js');
const { run } = require('../utils/sheetMenu');
const { t, discordLocalizations } = require('../utils/i18n');

// /raid: a menu with Open sheet, Check schedule and (admins) Create sheet. A server can have several named raid
// sheets; each can be limited to a role. Manage them on the website (server settings -> Raid & Logger).
module.exports = {
    data: new SlashCommandBuilder()
        .setName('raid')
        .setDescription(t('en', 'sheets.cmd.raid')).setDescriptionLocalizations(discordLocalizations('sheets.cmd.raid')),

    async execute(interaction) {
        return run(interaction, 'raid');
    }
};
