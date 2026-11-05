// Console helpers: say WHERE an error came from, without ever logging tokens.
// - 10062 (Unknown interaction) and 40060 (already acknowledged) are just the slow host:
//   they get one short "⏱️ [SLOW]" line instead of a big dump.

const SLOW_CODES = new Set([10062, 40060]);

function isDiscordApiError(err) {
    return !!err && typeof err.code === 'number' && String(err.name || '').startsWith('DiscordAPIError');
}

function isSlowError(err) {
    return isDiscordApiError(err) && SLOW_CODES.has(err.code);
}

// "https://discord.com/api/v10/interactions/123/<token>/callback?x=1" -> "/interactions/123/<token-redacted>/callback"
function safeApiPath(url) {
    if (!url) return '?';
    let p = String(url).split('?')[0].split('#')[0];
    p = p.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/api(\/v\d+)?/i, '');
    p = p.replace(/\/(interactions|webhooks)\/(\d+)\/[^/]+/gi, '/$1/$2/<token-redacted>');
    return p || '/';
}

// "METHOD /path" for a DiscordAPIError (token-free)
function apiWhere(err) {
    return String(err.method || '?').toUpperCase() + ' ' + safeApiPath(err.url);
}

// Copy of a DiscordAPIError that is safe to dump: keeps message/stack/code/status/rawError,
// drops url (token inside) and requestBody.
function redactApiError(err) {
    if (!isDiscordApiError(err)) return err;
    const safe = new Error(err.message);
    safe.name = err.name;
    safe.stack = err.stack;
    Object.assign(safe, { code: err.code, status: err.status, method: err.method, path: safeApiPath(err.url), rawError: err.rawError });
    return safe;
}

function interactionKind(interaction) {
    const is = (fn) => typeof interaction[fn] === 'function' && interaction[fn]();
    if (is('isChatInputCommand') || is('isContextMenuCommand') || is('isCommand')) return 'command';
    if (is('isAutocomplete')) return 'autocomplete';
    if (is('isButton')) return 'button';
    if (is('isAnySelectMenu') || is('isStringSelectMenu') || is('isChannelSelectMenu') ||
        is('isRoleSelectMenu') || is('isUserSelectMenu') || is('isMentionableSelectMenu')) return 'select';
    if (is('isModalSubmit')) return 'modal';
    return 'other';
}

// Compact context line: 'button "poll_vote_12" | guild 123 | age 3120ms'
function describeInteraction(interaction) {
    try {
        if (!interaction) return 'no interaction';
        const kind = interactionKind(interaction);
        let what;
        if (kind === 'command' || kind === 'autocomplete') {
            what = '/' + (interaction.commandName || '?');
        } else {
            let cid = String(interaction.customId || '?');
            if (cid.length > 60) cid = cid.slice(0, 60) + '…';
            what = '"' + cid + '"';
        }
        const where = interaction.guildId ? 'guild ' + interaction.guildId : 'DM';
        const age = Number.isFinite(interaction.createdTimestamp) ? (Date.now() - interaction.createdTimestamp) + 'ms' : '?';
        return kind + ' ' + what + ' | ' + where + ' | age ' + age;
    } catch (e) {
        return 'unknown interaction';
    }
}

module.exports = { SLOW_CODES, isDiscordApiError, isSlowError, safeApiPath, apiWhere, redactApiError, describeInteraction };
