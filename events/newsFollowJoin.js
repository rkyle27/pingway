// Pingway news follow: when Pingway joins a server, follow #pingway-news into its Community Updates channel.
const { Events } = require('discord.js');
const { followGuild } = require('../utils/newsFollow');

module.exports = {
    name: Events.GuildCreate,
    async execute(guild) {
        await followGuild(guild, { reason: 'joined' });
    }
};
