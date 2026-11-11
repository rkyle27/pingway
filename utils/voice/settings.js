// Kill switch for Google voices (on / off for everyone).
// Saved in voice-settings.json in the bot folder ({"google": true|false}), so it survives restarts.
// A missing or unreadable file = Google on. Checked on every message, so a change works on the next message.

const fs = require('fs');
const path = require('path');

let filePath = path.join(__dirname, '..', '..', 'voice-settings.json');
let cached = null; // { google: boolean }

function readFile() {
    try {
        const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { google: !(j && j.google === false) };
    } catch {
        return { google: true }; // missing / corrupt = on
    }
}

/** true = Google voices allowed (normal rules), false = everyone gets the backup voice. */
function isGoogleOn() {
    if (!cached) cached = readFile();
    return cached.google;
}

/** Saves the switch. @returns {{ google: boolean, saved: boolean }} (saved = false when the file could not be written) */
function setGoogle(on) {
    cached = { google: !!on };
    try {
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(cached, null, 2) + '\n');
        fs.renameSync(tmp, filePath);
        return { google: cached.google, saved: true };
    } catch (err) {
        console.error('⚠️ [VC] voice-settings.json could not be saved:', err.code || err.message);
        return { google: cached.google, saved: false };
    }
}

/** Tests: use another file and forget the cached value. */
function _setPath(p) {
    filePath = p;
    cached = null;
}

module.exports = { isGoogleOn, setGoogle, _setPath };
