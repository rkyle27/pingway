// Turns a Discord chat message into short, speakable text for TTS.
// Nothing here is stored or logged - text only lives in memory until it is spoken.

const MAX_CHARS = 200;
const SKIP_PREFIXES = ['/']; // Pingway has no text prefix; "/" = someone typing a slash command

function cut(text, max) {
    const chars = Array.from(text); // code points, so emoji / CJK are not split in half
    if (chars.length <= max) return text;
    let out = chars.slice(0, max).join('');
    const sp = out.lastIndexOf(' ');
    if (sp > max * 0.6) out = out.slice(0, sp);
    return out.trim();
}

/**
 * @param {string} content raw message content
 * @param {object} [resolve] { user(id) -> name, role(id) -> name, channel(id) -> name }
 * @param {number} [max] max characters (the caller's "Max characters per message", 20..200; default 200)
 * @returns {string|null} speakable text, or null when the message should not be read
 */
function cleanText(content, resolve = {}, max = MAX_CHARS) {
    if (typeof content !== 'string') return null;
    let t = content.trim();
    if (!t) return null;
    if (SKIP_PREFIXES.some(p => t.startsWith(p))) return null;

    const name = (fn, id, fallback) => {
        try {
            const v = typeof fn === 'function' ? fn(id) : null;
            return v ? String(v) : fallback;
        } catch {
            return fallback;
        }
    };

    // code blocks first (their contents may look like links / mentions)
    t = t.replace(/```[\s\S]*?```/g, ' code ');
    t = t.replace(/```[\s\S]*$/g, ' code '); // unclosed block
    t = t.replace(/`([^`\n]*)`/g, '$1');

    // masked links [text](url) -> text, then bare / <wrapped> URLs
    t = t.replace(/\[([^\]]{1,100})\]\(\s*<?https?:\/\/[^)\s]+>?\s*\)/gi, '$1');
    t = t.replace(/<https?:\/\/[^>\s]+>/gi, ' a link ');
    t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, ' a link ');

    // Discord tokens
    t = t.replace(/<@!?(\d{15,25})>/g, (_, id) => ' ' + name(resolve.user, id, 'someone') + ' ');
    t = t.replace(/<@&(\d{15,25})>/g, (_, id) => ' ' + name(resolve.role, id, 'a role') + ' ');
    t = t.replace(/<#(\d{15,25})>/g, (_, id) => ' ' + name(resolve.channel, id, 'a channel') + ' ');
    t = t.replace(/<a?:(\w{1,32}):\d{15,25}>/g, (_, n) => ' ' + n.replace(/_/g, ' ') + ' ');
    t = t.replace(/<t:-?\d{1,13}(?::[tTdDfFR])?>/g, ' a time ');
    t = t.replace(/<\/[\w -]{1,32}:\d{15,25}>/g, ' a command ');
    t = t.replace(/@(everyone|here)\b/g, '$1');

    // markdown
    t = t.replace(/\|\|[\s\S]*?\|\|/g, ' spoiler ');
    t = t.replace(/^\s{0,3}(#{1,3}|-#|>{1,3})\s+/gm, '');
    t = t.replace(/[*_~]{1,3}/g, '');

    // "noooooo!!!!!!" -> "noo!!" (digits are left alone so 1000 stays 1000)
    t = t.replace(/([^\d\s])\1{2,}/gu, '$1$1');

    t = t.replace(/\s+/g, ' ').trim();
    if (!t || !/[\p{L}\p{N}]/u.test(t)) return null;
    const limit = Number.isInteger(max) && max > 0 && max < MAX_CHARS ? max : MAX_CHARS;
    return cut(t, limit);
}

/**
 * Adds "<name> says:" unless the same person spoke in this guild within the last 20 s.
 * @param {Map} lastSpeaker guildId -> { userId, at }
 */
function withSpeaker(text, { guildId, userId, displayName, now, lastSpeaker, windowMs = 20000, fileOnly = false }) {
    const prev = lastSpeaker.get(guildId);
    const same = prev && prev.userId === userId && now - prev.at < windowMs;
    lastSpeaker.set(guildId, { userId, at: now });
    const who = cleanName(displayName);
    if (fileOnly) return same ? 'They sent a file' : `${who} sent a file`;
    if (same) return text;
    return `${who} says: ${text}`;
}

function cleanName(n) {
    const s = String(n || 'Someone').replace(/[*_~`|<>@#]/g, '').replace(/\s+/g, ' ').trim();
    return cut(s || 'Someone', 32);
}

module.exports = { MAX_CHARS, SKIP_PREFIXES, cleanText, withSpeaker, cleanName };
