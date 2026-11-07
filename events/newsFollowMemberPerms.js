// Pingway news follow: retry when Pingway itself gets or loses roles, for servers not followed yet.
const { Events } = require('discord.js');
const { retryIfNotFollowed } = require('../utils/newsFollow');

function sameRoles(a, b) {
    if (!a || !b || a.size !== b.size) return false;
    for (const id of a.keys()) if (!b.has(id)) return false;
    return true;
}

module.exports = {
    name: Events.GuildMemberUpdate,
    async execute(oldMember, newMember, client) {
        const botId = (client && client.user && client.user.id) || (newMember && newMember.client && newMember.client.user && newMember.client.user.id);
        if (!newMember || !botId || newMember.id !== botId) return;
        const oldRoles = oldMember && !oldMember.partial && oldMember.roles ? oldMember.roles.cache : null;
        if (oldRoles && sameRoles(oldRoles, newMember.roles.cache)) return;
        await retryIfNotFollowed(newMember.guild, 'bot roles changed');
    }
};
