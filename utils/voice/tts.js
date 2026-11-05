// Google Cloud Text-to-Speech (REST v1) - API key from env GOOGLE_TTS_API_KEY.
// The key is sent ONLY as the X-Goog-Api-Key header: never in the URL, never logged.
// Output is OGG_OPUS at 48 kHz, which @discordjs/voice plays as StreamType.OggOpus without any transcoding.

const { languageCodeOf, VOICES } = require('./voices');

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const VOICES_ENDPOINT = 'https://texttospeech.googleapis.com/v1/voices';
const TIMEOUT_MS = 10000;
const VOICE_LIST_TTL_MS = 24 * 60 * 60 * 1000;

function apiKey() {
    const k = process.env.GOOGLE_TTS_API_KEY;
    return k && String(k).trim() ? String(k).trim() : null;
}

function isEnabled() {
    return !!apiKey();
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
    constructor(status, reason) {
        super(`Google TTS failed (HTTP ${status}${reason ? ', ' + reason : ''})`);
        this.name = 'TtsError';
        this.status = status;
        this.reason = reason || null;
    }
}

async function callOnce(fetchImpl, text, voiceName, key, langOnly) {
    const { url, init } = buildRequest(text, voiceName, key, langOnly);
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
        let reason = null;
        try {
            const j = await res.json();
            reason = j && j.error && (j.error.status || null); // e.g. INVALID_ARGUMENT - never the message text
        } catch { /* ignore */ }
        throw new TtsError(res.status, reason);
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
        if (!(err instanceof TtsError) || err.status !== 400 || !voiceName) throw err;
        return callOnce(fetchImpl, text, null, key, languageCodeOf(voiceName)).catch(() => { throw err; });
    }
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

module.exports = { ENDPOINT, isEnabled, apiKey, buildRequest, synthesize, availableVoices, TtsError, _resetVoiceCache };
