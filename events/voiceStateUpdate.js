// /vc auto-leave: counts the humans in Pingway's voice channel on every voice change.
// Nobody left for 60 s -> leave (timer lives in utils/voice/session.js). Also follows Pingway when a
// moderator moves or disconnects it.

const { getSession } = require('../utils/voice/session');

function humansIn(channel) {
    try {
        return channel.members.filter(m => !m.user.bot).size;
    } catch {
        return 0;
    }
}

module.exports = {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, client) {
        try {
            const guild = newState.guild || oldState.guild;
            const session = guild && getSession(guild.id);
            if (!session) return;

            if (client && client.user && newState.id === client.user.id) {
                if (!newState.channelId) return session.destroy('disconnected by someone');
                if (newState.channelId !== session.channelId) session.channelId = newState.channelId; // moved
            }
            const channel = guild.channels.cache.get(session.channelId);
            session.setHumanCount(channel ? humansIn(channel) : 0);
        } catch (err) {
            console.error('⚠️ [VC] voiceStateUpdate:', err.message);
        }
    }
};
