// Lazy loading of the voice libraries + ffmpeg helpers.
// If @discordjs/voice is not installed yet, the rest of Pingway keeps working and /vc says so.

const { spawn, spawnSync } = require('child_process');

let voiceLib;      // undefined = not tried, null = missing
let ffmpegInfo;    // { path, libopus } | null

function loadVoice() {
    if (voiceLib !== undefined) return voiceLib;
    try {
        voiceLib = require('@discordjs/voice');
    } catch (err) {
        console.error('⚠️ [VC] @discordjs/voice is not installed - /vc is disabled:', err.code || err.message);
        voiceLib = null;
    }
    return voiceLib;
}

function ffmpegPath() {
    // @ffmpeg-installer ships the binary inside the npm package (no install script needed on the host)
    try {
        const p = require('@ffmpeg-installer/ffmpeg').path;
        if (p && require('fs').existsSync(p)) return p;
    } catch { /* try the next one */ }
    try {
        const p = require('ffmpeg-static');
        if (p && require('fs').existsSync(p)) return p;
    } catch { /* fall back to system ffmpeg */ }
    return 'ffmpeg';
}

/** { path, libopus } or null when no ffmpeg can be run. Checked once. */
function getFfmpeg() {
    if (ffmpegInfo !== undefined) return ffmpegInfo;
    const path = ffmpegPath();
    try {
        const r = spawnSync(path, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
        if (r.error || r.status !== 0) throw r.error || new Error('exit ' + r.status);
        ffmpegInfo = { path, libopus: /\blibopus\b/.test(r.stdout) };
    } catch (err) {
        console.error('⚠️ [VC] ffmpeg not usable - music is disabled:', err.code || err.message);
        ffmpegInfo = null;
    }
    return ffmpegInfo;
}

/**
 * Starts ONE ffmpeg that reads audio from stdin and writes Discord-ready audio to stdout.
 * With libopus: Ogg Opus 48 kHz stereo 20 ms frames (played as StreamType.OggOpus, no JS encoder needed).
 * Without libopus: raw s16le 48 kHz stereo (StreamType.Raw, encoded by opusscript).
 * @param {{ seekSeconds?: number, volume?: number }} opts
 */
function ffmpegArgs({ seekSeconds = 0, volume = 0.6, libopus = true } = {}) {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (seekSeconds > 0) args.push('-ss', String(Math.floor(seekSeconds)));
    args.push('-i', 'pipe:0', '-vn', '-sn', '-dn', '-af', `volume=${volume}`, '-ac', '2', '-ar', '48000');
    if (libopus) args.push('-c:a', 'libopus', '-b:a', '96k', '-frame_duration', '20', '-application', 'audio', '-f', 'ogg', 'pipe:1');
    else args.push('-f', 's16le', 'pipe:1');
    return args;
}

function spawnFfmpeg(opts = {}) {
    const info = getFfmpeg();
    if (!info) throw new Error('ffmpeg missing');
    const args = ffmpegArgs({ ...opts, libopus: info.libopus });
    const proc = spawn(info.path, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    proc.stdin.on('error', () => {}); // EPIPE when we kill it on skip
    return { proc, ogg: info.libopus };
}

module.exports = { loadVoice, getFfmpeg, ffmpegArgs, spawnFfmpeg };
