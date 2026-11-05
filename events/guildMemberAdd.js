const { Events } = require('discord.js');
const welcome = require('../utils/welcome');

// New member: post a welcome card if the server has welcome cards on (utils/welcome.js)
module.exports = {
    name: Events.GuildMemberAdd,
    async execute(member) {
        try {
            await welcome.handleJoin(member);
        } catch (err) {
            console.error('❌ [WELCOME] Join handling failed:', err.message);
        }
    },
};
