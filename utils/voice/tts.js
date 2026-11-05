// Google Cloud Text-to-Speech (REST v1) - API key from env GOOGLE_TTS_API_KEY.
// The key is sent ONLY as the X-Goog-Api-Key header: never in the URL, never logged.
// Output is OGG_OPUS at 48 kHz, which @discordjs/voice plays as StreamType.OggOpus without any transcoding.
// speak() picks the engine: Google when allowed (key set, daily safety limit not reached, no quota error today),
// otherwise the eSpeak NG backup voice (raw PCM, see espeak.js).

const { languageCodeOf, VOICES, espeakVoiceFor } = require('./voices');
const espeak = require('./espeak');
const { getUsage } = require('./usage');

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const VOICES_ENDPOINT = 'https://texttospeech.googleapis.com/v1/voices';
const TIMEOUT_MS = 10000;
const VOICE_LIST_TTL_MS = 24 * 60 * 60 * 1000;

function apiKey() {
    const k = process.env.GOOGLE_TTS_API_KEY;
    return k && String(k).trim() ? String(k).trim() : null;
}

/** TTS works when Google has a key OR the eSpeak backup is installed. */
function isEnabled() {
    return !!apiKey() || espeak.isInstalled();
}

// Google errors that mean "no more Google today": quota, billing, permission, disabled API, bad key
const BLOCKING_DETAILS = new Set(['RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED', 'BILLING_DISABLED', 'SERVICE_DISABLED', 'API_KEY_INVALID', 'API_KEY_SERVICE_BLOCKED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
function isBlockingError(err) {
    if (!err || err.name !== 'TtsError') return false;
    return err.status === 429 || err.status === 403 || err.reason === 'RESOURCE_EXHAUSTED' || err.reason === 'PERMISSION_DENIED' ||
        (err.detail && BLOCKING_DETAILS.has(err.detail));
}

/** Builds the fetch() arguments. Pure function (tested). */
function buildRequest(text, voiceName, key, langOnly) {
    const languageCode = voiceName ? languageCodeOf(voiceName) : (langOnly || 'en-US');
    const voice = voiceName ? { languageCode, name: voiceName } : { languageCode };
    return {
        url: ENDPOINT,
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Goog-Api-Key': key },
            body: JSON.stringify({
                input: { text: String(text) },
                voice,
                audioConfig: { audioEncoding: 'OGG_OPUS', sampleRateHertz: 48000, speakingRate: 1.0 }
            })
        }
    };
}

class TtsError extends Error {
    constructor(status, reason, detail) {
        super(`Google TTS failed (HTTP ${status}${reason ? ', ' + reason : ''}${detail ? ', ' + detail : ''})`);
        this.name = 'TtsError';
        this.status = status;
        this.reason = reason || null;
        this.detail = detail || null;
    }
}

async function callOnce(fetchImpl, text, voiceName, key, langOnly) {
    const { url, init } = buildRequest(text, voiceName, key, langOnly);
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
        let reason = null;
        let detail = null;
        try {
            const j = await res.json();
            // only Google's fixed codes (e.g. RESOURCE_EXHAUSTED / BILLING_DISABLED) - never the message text
            reason = j && j.error && typeof j.error.status === 'string' ? j.error.status.slice(0, 40) : null;
            const d = j && j.error && Array.isArray(j.error.details) ? j.error.details.find(x => x && typeof x.reason === 'string') : null;
            detail = d && /^[A-Z_]{3,40}$/.test(d.reason) ? d.reason : null;
        } catch { /* ignore */ }
        throw new TtsError(res.status, reason, detail);
    }
    const j = await res.json();
    if (!j || typeof j.audioContent !== 'string' || !j.audioContent) throw new TtsError(res.status, 'EMPTY_AUDIO');
    return Buffer.from(j.audioContent, 'base64');
}

/**
 * @returns {Promise<Buffer>} Ogg Opus audio
 * If Google rejects the voice name (HTTP 400), retries once with only the language code (Google picks a voice).
 */
async function synthesize(text, voiceName, opts = {}) {
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const key = opts.key === undefined ? apiKey() : opts.key;
    if (!key) throw new TtsError(0, 'NO_API_KEY');
    try {
        return await callOnce(fetchImpl, text, voiceName, key);
    } catch (err) {
        if (!(err instanceof TtsError) || err.status !== 400 || !voiceName || isBlockingError(err)) throw err;
        return callOnce(fetchImpl, text, null, key, languageCodeOf(voiceName)).catch(() => { throw err; });
    }
}

/**
 * Speaks with Google if allowed, else with the eSpeak backup.
 * @returns {Promise<{type: 'ogg'|'pcm', data: Buffer, engine: 'google'|'espeak'}>}
 *   ogg = Ogg Opus (StreamType.OggOpus), pcm = 48 kHz stereo s16le (StreamType.Raw)
 */
async function speak(text, voiceName, opts = {}) {
    const key = opts.key === undefined ? apiKey() : opts.key;
    const usage = opts.usage || getUsage();
    const backup = opts.espeak || espeak;
    if (key) {
        const chars = Array.from(String(text)).length;
        const gate = await usage.check(chars);
        if (gate.ok) {
            try {
                const data = await synthesize(text, voiceName, { fetchImpl: opts.fetchImpl, key });
                usage.add(chars);
                return { type: 'ogg', data, engine: 'google' };
            } catch (err) {
                if (isBlockingError(err)) usage.block(err.detail || err.reason || ('HTTP ' + err.status));
                else console.error('⚠️ [VC] ' + err.message + ' - using the backup voice for this message');
            }
        }
    }
    if (!backup.isInstalled()) throw new TtsError(0, key ? 'GOOGLE_UNAVAILABLE_NO_BACKUP' : 'NO_ENGINE');
    const data = await backup.synthesize(text, espeakVoiceFor(voiceName));
    return { type: 'pcm', data, engine: 'espeak' };
}

/** For the panel: which voice engine messages use right now. */
function engineStatus(opts = {}) {
    const key = opts.key === undefined ? apiKey() : opts.key;
    const backupOk = (opts.espeak || espeak).isInstalled();
    if (!key) return { mode: backupOk ? 'backup' : 'off', reason: 'no_key' };
    const st = (opts.usage || getUsage()).state();
    if (st.reason) return { mode: backupOk ? 'backup' : 'off', reason: st.reason };
    return { mode: 'google', reason: null };
}

let voiceCache = { set: null, at: 0 };

/** Set of curated voice names that Google currently offers (null = unknown, show all). Cached 24 h. */
async function availableVoices({ fetchImpl = globalThis.fetch, key = apiKey(), now = Date.now() } = {}) {
    if (!key) return null;
    if (voiceCache.set && now - voiceCache.at < VOICE_LIST_TTL_MS) return voiceCache.set;
    try {
        const res = await fetchImpl(VOICES_ENDPOINT, { headers: { 'X-Goog-Api-Key': key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return voiceCache.set;
        const j = await res.json();
        const names = new Set((j.voices || []).map(v => v && v.name).filter(Boolean));
        const set = new Set(VOICES.filter(v => names.has(v.name)).map(v => v.name));
        if (set.size) voiceCache = { set, at: now };
        return voiceCache.set;
    } catch {
        return voiceCache.set;
    }
}

function _resetVoiceCache() {
    voiceCache = { set: null, at: 0 };
}

module.exports = { ENDPOINT, isEnabled, apiKey, buildRequest, synthesize, speak, engineStatus, isBlockingError, availableVoices, TtsError, _resetVoiceCache };
