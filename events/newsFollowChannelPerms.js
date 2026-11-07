// Pingway news follow: retry when the Community Updates channel changes (e.g. its permissions), for servers not followed yet.
const { Events } = require('discord.js');
const { retryIfNotFollowed } = require('../utils/newsFollow');

module.exports = {
    name: Events.ChannelUpdate,
    async execute(oldChannel, newChannel) {
        const guild = newChannel && newChannel.guild;
        if (!guild || newChannel.id !== guild.publicUpdatesChannelId) return;
        await retryIfNotFollowed(guild, 'channel perms changed');
    }
};
