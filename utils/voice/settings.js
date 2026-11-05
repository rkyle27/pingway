// Console kill switch for Google voices: "tts google off" / "tts google on" (mybot.js).
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

const jst = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' JST';

/**
 * Console: "tts" (report), "tts google off" / "tts google on" (kill switch). Prints and returns the lines.
 * deps (tests): { sessions, usage, members, tts, now }
 */
async function ttsConsole(args = [], deps = {}) {
    const out = [];
    const sub = (args[0] || '').toLowerCase();
    const val = (args[1] || '').toLowerCase();
    if (sub === 'google' && (val === 'on' || val === 'off')) {
        const r = setGoogle(val === 'on');
        out.push(r.google
            ? '🔊 [TTS] Google voices ON again (normal rules) from the next message.'
            : '🔊 [TTS] Google voices OFF: everyone gets the backup voice (eSpeak) from the next message.');
        if (!r.saved) out.push('⚠️ [TTS] Could not save voice-settings.json - this lasts only until the next restart.');
    } else if (sub) {
        out.push('[CONSOLE] Usage: tts | tts google on | tts google off');
    } else {
        const members = deps.members || require('./members');
        const usage = deps.usage || require('./usage').getUsage();
        const tts = deps.tts || require('./tts');
        const sessions = deps.sessions || require('./session').sessions;
        const now = deps.now !== undefined ? deps.now : Date.now();
        const limit = require('./usage').dailyLimit();
        try { await usage.check(0, now); } catch { /* shows what is in memory */ }
        const st = usage.state(now);
        const free = members.isFreePeriod(now);
        const live = [...sessions.values()].filter(x => !x.destroyed);
        let google = 0;
        const eng = tts.engineStatus();
        if (eng.mode === 'google' || eng.reason === 'limit') {
            for (const x of live) {
                try {
                    const p = await members.planGoogle(x, 1, { dryRun: true, now });
                    if (p.google && !(p.dailyCap && eng.reason === 'limit')) google++;
                } catch { /* counted as backup */ }
            }
        }
        out.push('🔊 [TTS] Google voices: ' + (isGoogleOn() ? 'ON' : 'OFF (kill switch)') + (tts.apiKey() ? '' : ' - no Google key set'));
        out.push('  Free period: ' + (free ? 'active until ' + jst(members.freeUntil()) : 'over (since ' + jst(members.freeUntil()) + ')'));
        out.push('  Free Google characters today (Pacific day ' + st.day + '): ' + Number(st.chars).toLocaleString('en-US') + ' / ' + limit.toLocaleString('en-US') +
            (st.reason === 'quota' ? ' - paused by a Google quota error until midnight Pacific' : st.reason === 'limit' ? ' - daily cap reached' : ''));
        out.push('  Active calls: ' + live.length + ', using Google: ' + google);
    }
    for (const line of out) console.log(line);
    return out;
}

/** Tests: use another file and forget the cached value. */
function _setPath(p) {
    filePath = p;
    cached = null;
}

module.exports = { isGoogleOn, setGoogle, ttsConsole, _setPath };
