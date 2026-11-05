// Backup TTS engine: eSpeak NG compiled to WebAssembly (@echogarden/espeak-ng-emscripten).
// - pure JS + inlined wasm + voice data file inside the npm tarball: no install scripts, no compiling
// - ES module -> loaded with a lazy dynamic import() the first time the backup voice is needed
// - output: 16-bit mono PCM at the engine sample rate (22050 Hz); converted here to 48 kHz stereo s16le
//   for @discordjs/voice StreamType.Raw (encoded to Opus by opusscript). No ffmpeg needed.
// If the package is missing or fails to load, this logs ONE clear line and the backup is off.

const PKG = '@echogarden/espeak-ng-emscripten';
const OUT_RATE = 48000;
const RATE_WPM = 165;

let state = { status: 'idle', worker: null, promise: null, lastVoice: null }; // idle | loading | ready | missing
let importer = spec => import(spec); // tests replace these two
let resolver = () => require.resolve(PKG);

function isInstalled() {
    if (state.status === 'missing') return false;
    if (state.status === 'ready' || state.status === 'loading') return true;
    try {
        resolver();
        return true;
    } catch {
        return false;
    }
}

async function load() {
    if (state.status === 'ready') return state.worker;
    if (state.status === 'missing') throw new Error('eSpeak NG backup voice is not available');
    if (!state.promise) {
        state.status = 'loading';
        state.promise = (async () => {
            const { pathToFileURL } = require('url');
            const file = resolver(); // .../espeak-ng.js (CommonJS can resolve it, then import() the ESM file)
            const mod = await importer(pathToFileURL(file).href);
            const init = mod && (mod.default || mod);
            const m = await init();
            const worker = new m.eSpeakNGWorker();
            state.worker = worker;
            state.status = 'ready';
            console.log('🔊 [VC] eSpeak NG backup voice loaded (' + (Number(worker.samplerate) || 22050) + ' Hz)');
            return worker;
        })().catch(err => {
            state.status = 'missing';
            state.promise = null;
            console.error(`⚠️ [VC] eSpeak NG backup voice could not be loaded (${PKG}): ${err.code || err.message}. Without a Google key TTS is off.`);
            throw err;
        });
    }
    return state.promise;
}

/** eSpeak reads its input as markup: remove characters that could be taken as tags / entities. */
function safeText(text) {
    return String(text).replace(/&/g, ' and ').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Int16 mono at `fromRate` -> Buffer of s16le stereo at 48 kHz (linear interpolation; plenty for speech). */
function toDiscordPcm(samples, fromRate) {
    const n = samples.length;
    if (!n) return Buffer.alloc(0);
    const ratio = fromRate / OUT_RATE;
    const outFrames = Math.floor((n - 1) / ratio) + 1;
    const out = Buffer.allocUnsafe(outFrames * 4);
    for (let i = 0; i < outFrames; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = i0 + 1 < n ? i0 + 1 : i0;
        const frac = pos - i0;
        let v = Math.round(samples[i0] + (samples[i1] - samples[i0]) * frac);
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        out.writeInt16LE(v, i * 4);
        out.writeInt16LE(v, i * 4 + 2);
    }
    return out;
}

/**
 * @param {string} text
 * @param {string} voice eSpeak voice id, e.g. "en-us", "ja+f3"
 * @returns {Promise<Buffer>} 48 kHz stereo s16le PCM
 */
async function synthesize(text, voice = 'en-us') {
    const worker = await load();
    if (state.lastVoice !== voice) {
        let rc;
        try {
            rc = worker.set_voice(voice);
        } catch {
            rc = -1;
        }
        if (rc && rc !== 0) {
            // unknown variant / voice -> plain language, then English
            const base = String(voice).split('+')[0];
            try { rc = worker.set_voice(base); } catch { rc = -1; }
            if (rc && rc !== 0) worker.set_voice('en-us');
        }
        state.lastVoice = voice;
        worker.set_rate(RATE_WPM);
    }
    const chunks = [];
    let total = 0;
    // synchronous: the callback runs for each audio chunk; returning false = keep going
    worker.synthesize(safeText(text), samples => {
        if (samples && samples.length) {
            chunks.push(samples);
            total += samples.length;
        }
        return false;
    });
    const all = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
        all.set(c, off);
        off += c.length;
    }
    return toDiscordPcm(all, Number(worker.samplerate) || 22050);
}

/** Tests only. */
function _setImporter(fn, resolveFn) {
    importer = fn;
    if (resolveFn) resolver = resolveFn;
    state = { status: 'idle', worker: null, promise: null, lastVoice: null };
}
function _forceStatus(status) {
    state.status = status;
}

module.exports = { PKG, OUT_RATE, isInstalled, load, synthesize, toDiscordPcm, safeText, _setImporter, _forceStatus };
