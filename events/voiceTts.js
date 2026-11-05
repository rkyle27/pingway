// /vc text-to-speech: reads new messages in the voice channel's own text chat while Pingway is in that
// voice channel. A second 'messageCreate' listener (mybot.js binds every file in events/ on its own),
// so events/messageCreate.js is untouched. Message text is never stored or logged.

const { getSession } = require('../utils/voice/session');
const reader = require('../utils/voice/reader');
const store = require('../utils/voice/store');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        try {
            if (!message.guild || message.author?.bot) return;
            if (!getSession(message.guild.id)) return; // cheap exit for every normal message
            const { isMaintenance } = require('../maintenance');
            if (isMaintenance(message.guild.id)) return;
            await reader.handleMessage(message, { getSession, store });
        } catch (err) {
            console.error('⚠️ [VC] tts reader:', err.message);
        }
    }
};
