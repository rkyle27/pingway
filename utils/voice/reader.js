// Reads new messages from the voice channel's built-in text chat aloud.
// Only: message.channel.id === Pingway's voice channel, humans (no bots / webhooks / system messages)
// who are in that voice channel right now. 1 message per 2 s per person; the speech queue holds max 15.

const { cleanText, withSpeaker } = require('./textClean');
const { resolveVoice } = require('./voices');

const USER_GAP_MS = 2000;

const lastByUser = new Map();   // `${guildId}:${userId}` -> time
const lastSpeaker = new Map();  // guildId -> { userId, at }

function sweep(now) {
    if (lastByUser.size < 2000) return;
    for (const [k, t] of lastByUser) if (now - t > 60000) lastByUser.delete(k);
}

function resolvers(message) {
    const guild = message.guild;
    return {
        user: id => {
            const m = (message.mentions && message.mentions.members && message.mentions.members.get(id)) || (guild && guild.members.cache.get(id));
            if (m) return m.displayName;
            const u = message.mentions && message.mentions.users && message.mentions.users.get(id);
            return u ? (u.globalName || u.username) : null;
        },
        role: id => {
            const r = guild && guild.roles.cache.get(id);
            return r ? r.name : null;
        },
        channel: id => {
            const c = (guild && guild.channels.cache.get(id)) || (message.client && message.client.channels.cache.get(id));
            return c ? c.name : null;
        }
    };
}

/**
 * @returns {Promise<string>} why it was (not) read - used by tests and debugging, never contains text
 */
async function handleMessage(message, { getSession, store, now = Date.now() }) {
    if (!message || !message.guild || !message.author) return 'no_guild';
    if (message.author.bot || message.webhookId || message.system) return 'not_human';
    const session = getSession(message.guild.id);
    if (!session) return 'no_session';
    if (session.deps && session.deps.ttsEnabled && !session.deps.ttsEnabled()) return 'tts_off';
    if (message.channel.id !== session.channelId) return 'other_channel';
    const member = message.member;
    if (!member || !member.voice || member.voice.channelId !== session.channelId) return 'not_in_voice';

    const key = message.guild.id + ':' + message.author.id;
    const last = lastByUser.get(key);
    if (last !== undefined && now - last < USER_GAP_MS) return 'rate_limited';

    let text = cleanText(message.content, resolvers(message));
    const fileOnly = !text && !String(message.content || '').trim() && !!(message.attachments && message.attachments.size);
    if (!text && !fileOnly) return 'empty';

    lastByUser.set(key, now);
    sweep(now);

    const [userVoice, settings] = await Promise.all([store.getUserVoice(message.author.id), store.getGuildSettings(message.guild.id)]);
    const voiceName = resolveVoice(userVoice, settings.defaultVoice);
    const speech = withSpeaker(text || '', {
        guildId: message.guild.id, userId: message.author.id, displayName: member.displayName, now, lastSpeaker, fileOnly
    });

    return session.enqueueTts(speech, voiceName) ? 'queued' : 'queue_full';
}

function _reset() {
    lastByUser.clear();
    lastSpeaker.clear();
}

module.exports = { USER_GAP_MS, handleMessage, _reset };
