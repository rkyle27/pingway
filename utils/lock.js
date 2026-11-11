// Scoped locks for long cleanups: /clean locks only its channel, /clearbotdms only its user.
// Nothing else is blocked (other channels, servers, users and commands keep working).
// Use: if (!tryLock(key)) -> "already running"; always unlock(key) in a finally.
const held = new Map(); // key -> task name

module.exports = {
    channelKey: channelId => 'channel:' + channelId,
    userKey: userId => 'user:' + userId,
    /** Takes the lock when it is free -> true; already held -> false */
    tryLock: (key, taskName = '') => {
        if (held.has(key)) return false;
        held.set(key, taskName);
        return true;
    },
    unlock: key => { held.delete(key); },
    isLocked: key => held.has(key),
    _reset: () => held.clear()
};
