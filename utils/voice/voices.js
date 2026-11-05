// Curated Google Cloud Text-to-Speech voices for /vc.
// Standard voices are the cheapest; WaveNet / Neural2 sound better but cost more (smaller free tier).
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

// [suffix, gender]  -> full name is `${lang}-${suffix}`
const RAW = {
    'en-US': [['Standard-C', 'F'], ['Standard-D', 'M'], ['Wavenet-F', 'F'], ['Wavenet-D', 'M'], ['Neural2-F', 'F'], ['Neural2-D', 'M'], ['Neural2-J', 'M']],
    'en-GB': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M'], ['Neural2-A', 'F'], ['Neural2-B', 'M']],
    'ja-JP': [['Standard-A', 'F'], ['Standard-C', 'M'], ['Wavenet-A', 'F'], ['Wavenet-C', 'M'], ['Neural2-B', 'F'], ['Neural2-C', 'M']],
    'fil-PH': [['Standard-A', 'F'], ['Standard-C', 'M'], ['Wavenet-A', 'F'], ['Wavenet-C', 'M']],
    'ko-KR': [['Standard-A', 'F'], ['Standard-C', 'M'], ['Wavenet-A', 'F'], ['Wavenet-C', 'M'], ['Neural2-A', 'F'], ['Neural2-C', 'M']],
    'cmn-CN': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M']],
    'cmn-TW': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F']],
    'es-ES': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-C', 'F'], ['Wavenet-B', 'M'], ['Neural2-A', 'F'], ['Neural2-B', 'M']],
    'es-US': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Neural2-A', 'F'], ['Neural2-B', 'M']],
    'fr-FR': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M'], ['Neural2-A', 'F'], ['Neural2-B', 'M']],
    'de-DE': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M'], ['Neural2-A', 'F'], ['Neural2-B', 'M']],
    'pt-BR': [['Standard-A', 'F'], ['Standard-B', 'M'], ['Wavenet-A', 'F'], ['Wavenet-B', 'M'], ['Neural2-A', 'F'], ['Neural2-B', 'M']]
};

const VOICES = [];
for (const lang of LANGUAGES) {
    for (const [suffix, gender] of RAW[lang.code] || []) {
        const [tier, letter] = suffix.split('-');
        VOICES.push({
            name: `${lang.code}-${suffix}`,
            lang: lang.code,
            tier, // Standard | Wavenet | Neural2
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

// user choice -> server default -> en-US
function resolveVoice(userVoice, guildDefault) {
    if (userVoice && isKnownVoice(userVoice)) return userVoice;
    if (guildDefault && isKnownVoice(guildDefault)) return guildDefault;
    return FALLBACK_VOICE;
}

module.exports = { FALLBACK_VOICE, LANGUAGES, VOICES, languageCodeOf, isKnownVoice, getVoice, voicesFor, getLanguage, resolveVoice };
