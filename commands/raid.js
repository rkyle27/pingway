const { SlashCommandBuilder } = require('discord.js');
const { run } = require('../utils/sheetMenu');

// /raid: a menu with Open sheet, Check schedule and (admins) Create sheet. A server can have several named raid
// sheets; each can be limited to a role. Manage them on the website (server settings -> Raid & Logger).
module.exports = {
    data: new SlashCommandBuilder()
        .setName('raid')
        .setDescription('📅 Raid sheets: open one, check the schedule, or create one (admins).'),

    async execute(interaction) {
        return run(interaction, 'raid');
    }
};
