// Curated Google Cloud Text-to-Speech voices for /vc.
// Only Standard + WaveNet voices (Google gives a free monthly character tier for each).
// At runtime tts.listVoices() (Google /v1/voices) hides any voice Google does not offer any more.

const FALLBACK_VOICE = 'en-US-Standard-C';

const LANGUAGES = [
    { code: 'en-US', label: 'English (US)', emoji: '🇺🇸' },
    { code: 'en-GB', label: 'English (UK)', emoji: '🇬🇧' },
    { code: 'ja-JP', label: 'Japanese', emoji: '🇯🇵' },
    { code: 'fil-PH', label: 'Filipino', emoji: '🇵🇭' },
    { code: 'ko-KR', label: 'Korean', emoji: '🇰🇷' },
    { code: 'cmn-CN', label: 'Chinese (Mandarin, China)', emoji: '🇨🇳' },
    { code: 'cmn-TW', label: 'Chinese (Mandarin, Taiwan)', emoji: '🇹🇼' },
    { code: 'es-ES', label: 'Spanish (Spain)', emoji: '🇪🇸' },
    { code: 'es-US', label: 'Spanish (Latin America)', emoji: '🌎' },
    { code: 'fr-FR', label: 'French', emoji: '🇫🇷' },
    { code: 'de-DE', label: 'German', emoji: '🇩🇪' },
    { code: 'pt-BR', label: 'Portuguese (Brazil)', emoji: '🇧🇷' }
];

// Only Standard and WaveNet voices (each has a free monthly tier). [suffix, gender] -> `${lang}-${suffix}`
const RAW = {
    'en-US': [['Standard-C', 'F'], ['Standard-D', 'M'], ['Wavenet-F', 'F'], ['Wavenet-D', 'M']],
    'en-GB': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M']],
    'ja-JP': [['Standard-A', 'F'], ['Standard-C', 'M'], ['Wavenet-A', 'F'], ['Wavenet-C', 'M']],
    'fil-PH': [['Standard-A', 'F'], ['Standard-C', 'M'], ['Wavenet-A', 'F'], ['Wavenet-C', 'M']],
    'ko-KR': [['Standard-A', 'F'], ['Standard-C', 'M'], ['Wavenet-A', 'F'], ['Wavenet-C', 'M']],
    'cmn-CN': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M']],
    'cmn-TW': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F']],
    'es-ES': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-C', 'F'], ['Wavenet-B', 'M']],
    'es-US': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M']],
    'fr-FR': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M']],
    'de-DE': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M']],
    'pt-BR': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M']]
};

// Voices offered before (Neural2) -> gender, so a saved choice maps to the same language + gender.
const LEGACY_GENDER = {
    'en-US-Neural2-F': 'F', 'en-US-Neural2-D': 'M', 'en-US-Neural2-J': 'M', 'en-GB-Neural2-A': 'F', 'en-GB-Neural2-B': 'M',
    'ja-JP-Neural2-B': 'F', 'ja-JP-Neural2-C': 'M', 'ko-KR-Neural2-A': 'F', 'ko-KR-Neural2-C': 'M',
    'es-ES-Neural2-A': 'F', 'es-ES-Neural2-B': 'M', 'es-US-Neural2-A': 'F', 'es-US-Neural2-B': 'M',
    'fr-FR-Neural2-A': 'F', 'fr-FR-Neural2-B': 'M', 'de-DE-Neural2-A': 'F', 'de-DE-Neural2-B': 'M',
    'pt-BR-Neural2-A': 'F', 'pt-BR-Neural2-B': 'M'
};

// Backup engine (eSpeak NG) voice for each language. eSpeak has no Filipino/Tagalog voice -> English.
const ESPEAK = {
    'en-US': 'en-us', 'en-GB': 'en-gb', 'ja-JP': 'ja', 'fil-PH': 'en-us', 'ko-KR': 'ko', 'cmn-CN': 'cmn', 'cmn-TW': 'cmn',
    'es-ES': 'es', 'es-US': 'es-419', 'fr-FR': 'fr', 'de-DE': 'de', 'pt-BR': 'pt-br'
};

const VOICES = [];
for (const lang of LANGUAGES) {
    for (const [suffix, gender] of RAW[lang.code] || []) {
        const [tier, letter] = suffix.split('-');
        VOICES.push({
            name: `${lang.code}-${suffix}`,
            lang: lang.code,
            tier, // Standard | Wavenet
            gender,
            label: `${lang.label} · ${tier === 'Wavenet' ? 'WaveNet' : tier} ${letter} (${gender === 'F' ? 'female' : 'male'})`
        });
    }
}
const BY_NAME = new Map(VOICES.map(v => [v.name, v]));

// "cmn-CN-Standard-A" -> "cmn-CN", "fil-PH-Wavenet-A" -> "fil-PH"
function languageCodeOf(voiceName) {
    const parts = String(voiceName || '').split('-');
    return parts.length >= 2 ? parts[0] + '-' + parts[1] : 'en-US';
}

function isKnownVoice(name) {
    return BY_NAME.has(name);
}

function getVoice(name) {
    return BY_NAME.get(name) || null;
}

function voicesFor(lang, available) {
    return VOICES.filter(v => v.lang === lang && (!available || available.has(v.name)));
}

function getLanguage(code) {
    return LANGUAGES.find(l => l.code === code) || null;
}

const VOICE_NAME_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+-[A-Z]$/;

/**
 * A saved voice name -> an allowed one. Removed tiers (Neural2, Studio, Chirp...) map to the same
 * language's Standard voice of the same gender when known. Unknown language -> null.
 */
function normalizeVoice(name) {
    if (!name) return null;
    if (BY_NAME.has(name)) return name;
    if (!VOICE_NAME_RE.test(String(name))) return null;
    const lang = languageCodeOf(name);
    const list = VOICES.filter(v => v.lang === lang);
    if (!list.length) return null;
    const gender = LEGACY_GENDER[name];
    const std = list.filter(v => v.tier === 'Standard');
    return ((gender && std.find(v => v.gender === gender)) || std[0] || list[0]).name;
}

// user choice -> server default -> en-US
function resolveVoice(userVoice, guildDefault) {
    return normalizeVoice(userVoice) || normalizeVoice(guildDefault) || FALLBACK_VOICE;
}

/** eSpeak voice id for a Google voice, e.g. "ja-JP-Wavenet-A" -> "ja+f3". */
function espeakVoiceFor(voiceName) {
    const v = getVoice(normalizeVoice(voiceName) || FALLBACK_VOICE);
    const base = ESPEAK[v.lang] || 'en-us';
    return v.gender === 'F' ? base + '+f3' : base;
}

module.exports = { FALLBACK_VOICE, LANGUAGES, VOICES, ESPEAK, languageCodeOf, isKnownVoice, getVoice, voicesFor, getLanguage, normalizeVoice, resolveVoice, espeakVoiceFor };
