// Loads an optional module from the private/ folder, which is not part of the public repository.
// Returns null when the folder (or that module) is not there, or when PINGWAY_NO_PRIVATE=1 (tests).
// Errors inside a module that IS there are not hidden.
'use strict';

const path = require('path');

function loadPrivate(name) {
    if (process.env.PINGWAY_NO_PRIVATE === '1') return null;
    const file = path.join(__dirname, '..', 'private', name);
    try {
        return require(file);
    } catch (e) {
        const first = String(e && e.message || '').split('\n')[0];
        if (e && e.code === 'MODULE_NOT_FOUND' && first.includes(file)) return null;
        throw e;
    }
}

module.exports = { loadPrivate };
