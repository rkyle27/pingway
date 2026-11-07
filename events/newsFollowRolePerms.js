// Pingway news follow: retry when one of Pingway's own roles changes, for servers not followed yet.
const { Events } = require('discord.js');
const { retryIfNotFollowed } = require('../utils/newsFollow');

module.exports = {
    name: Events.GuildRoleUpdate,
    async execute(oldRole, newRole) {
        const guild = newRole && newRole.guild;
        const me = guild && guild.members && guild.members.me;
        if (!me || !me.roles.cache.has(newRole.id)) return;
        await retryIfNotFollowed(guild, 'bot role changed');
    }
};
