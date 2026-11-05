// /vc cleanup when Pingway is removed from a server (or the server goes unavailable):
// stops the players, kills ffmpeg, clears timers and destroys the voice connection.

const { destroySession } = require('../utils/voice/session');

module.exports = {
    name: 'guildDelete',
    async execute(guild) {
        try {
            if (guild && guild.id) destroySession(guild.id, 'guild removed');
        } catch (err) {
            console.error('⚠️ [VC] guildDelete cleanup:', err.message);
        }
    }
};
