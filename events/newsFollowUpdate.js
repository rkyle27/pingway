// Pingway news follow: when a server sets or changes its Community Updates channel, follow #pingway-news there.
const { Events } = require('discord.js');
const { followGuild } = require('../utils/newsFollow');

module.exports = {
    name: Events.GuildUpdate,
    async execute(oldGuild, newGuild) {
        if (!newGuild || !newGuild.publicUpdatesChannelId) return;
        if (oldGuild && oldGuild.publicUpdatesChannelId === newGuild.publicUpdatesChannelId) return;
        await followGuild(newGuild, { reason: 'community channel changed' });
    }
};
