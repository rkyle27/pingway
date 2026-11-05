// Who may press which /vc control.
// - Join / Move here / Voice choice: anyone (Move only happens when Pingway's channel has no humans).
// - Leave / Skip / Clear / Pause / Play: people in the same voice channel as Pingway; if the server set a
//   DJ role (voice_settings.dj_role_id) they also need that role. Manage Server can always use them.

const OPEN_ACTIONS = new Set(['join', 'move', 'voice', 'refresh', 'lang']);
const DJ_ACTIONS = new Set(['leave', 'skip', 'clear', 'pause', 'play']);

function hasManageGuild(member) {
    try {
        return !!(member && member.permissions && member.permissions.has('ManageGuild'));
    } catch {
        return false;
    }
}

function hasRole(member, roleId) {
    try {
        const roles = member && member.roles;
        if (!roles) return false;
        if (roles.cache && typeof roles.cache.has === 'function') return roles.cache.has(roleId);
        if (Array.isArray(roles)) return roles.includes(roleId); // raw API member
        return false;
    } catch {
        return false;
    }
}

/**
 * @param {string} action
 * @param {{ member, botChannelId: string|null, settings: {djRoleId?: string|null} }} ctx
 * @returns {{ ok: boolean, reason?: string }}
 */
function canUse(action, { member, botChannelId, settings }) {
    if (OPEN_ACTIONS.has(action)) return { ok: true };
    if (!DJ_ACTIONS.has(action)) return { ok: false, reason: 'Unknown control.' };
    if (hasManageGuild(member)) return { ok: true };

    const userChannel = member && member.voice ? member.voice.channelId : null;
    // "play" while Pingway is not connected = it will join the user's channel
    const target = botChannelId || (action === 'play' ? userChannel : null);
    if (!target) return { ok: false, reason: "I'm not in a voice channel. Press **Join** first." };
    if (userChannel !== target) return { ok: false, reason: `Join <#${target}> to use the controls.` };

    const dj = settings && settings.djRoleId;
    if (dj && !hasRole(member, dj)) return { ok: false, reason: `You need the <@&${dj}> role (or Manage Server) for that.` };
    return { ok: true };
}

module.exports = { OPEN_ACTIONS, DJ_ACTIONS, canUse, hasManageGuild };
