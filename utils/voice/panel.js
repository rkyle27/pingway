// /vc control panel as raw Discord API JSON (no builders needed, easy to test against Discord's limits).
// Every customId starts with 'vc_' and contains none of the words other handlers match on
// ('release', 'evercold', 'warp', 'btn_', 'select_').

const { LANGUAGES, getLanguage, getVoice, voicesFor } = require('./voices');
const { stationOption } = require('./radio');

const ID = {
    join: 'vc_join', move: 'vc_move', leave: 'vc_leave', refresh: 'vc_refresh',
    play: 'vc_play', pause: 'vc_pause', skip: 'vc_skip', clear: 'vc_clear',
    lang: 'vc_lang', voice: 'vc_voice', radio: 'vc_radio',
    modal: 'vc_playmodal', modalInput: 'vc_play_input'
};
const DEFAULT_VALUE = 'server_default';

const STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 };
const button = (custom_id, label, style, { emoji, disabled } = {}) => {
    const b = { type: 2, custom_id, label, style: STYLE[style] };
    if (emoji) b.emoji = { name: emoji };
    if (disabled) b.disabled = true;
    return b;
};
const row = (...components) => ({ type: 1, components });
const trim = (s, n) => {
    const a = Array.from(String(s == null ? '' : s));
    return a.length <= n ? a.join('') : a.slice(0, n - 1).join('') + '…';
};

/**
 * @param {object} p
 * @param {object|null} p.status       session.status() or null when not connected
 * @param {boolean} p.voiceReady       @discordjs/voice installed
 * @param {boolean} p.ttsEnabled       Google key set or eSpeak backup installed
 * @param {object|null} p.ttsEngine    tts.engineStatus(): { mode: 'google'|'backup'|'off', reason }
 * @param {string}  p.voiceName        the user's effective voice
 * @param {boolean} p.voiceIsDefault   true when it comes from the server / global default
 * @param {string|null} p.selectedLang language picked in the first menu (shows the voice menu)
 * @param {Set|null} p.available       voices Google offers (null = unknown -> show all)
 * @param {Array|null} p.radioResults  stations from the last search
 * @param {string|null} p.moveOffer    channel id Pingway can be moved out of (empty of humans)
 * @param {string|null} p.djRoleId
 * @param {string|null} p.notice       one-line feedback for this user
 */
function buildPanel(p) {
    const st = p.status;
    const connected = !!st;
    const lines = [];

    if (!p.voiceReady) {
        lines.push('⚠️ Voice is not installed on this bot yet (missing voice libraries).');
    } else if (connected) {
        lines.push(`**Channel:** <#${st.channelId}>`);
    } else {
        lines.push('**Channel:** not connected - join a voice channel and press **Join**.');
    }

    if (connected) {
        const np = st.nowPlaying;
        lines.push('**Now playing:** ' + (np ? `${np.live ? '📻' : '🎵'} ${trim(np.title, 80)}${np.paused ? ' (paused)' : ''}` : 'nothing'));
        lines.push(`**Queue:** ${st.musicQueue} track${st.musicQueue === 1 ? '' : 's'} · ${st.ttsQueue} message${st.ttsQueue === 1 ? '' : 's'} to read${st.speaking ? ' · 🗣️ speaking' : ''}`);
    }

    if (p.ttsEnabled) {
        lines.push(connected
            ? `**Text-to-speech:** on - I read messages posted in <#${st.channelId}>'s text chat by people in the channel.`
            : '**Text-to-speech:** on - once I join, I read the voice channel\'s text chat.');
    } else {
        lines.push('**Text-to-speech:** off - no voice engine is available on this bot. Music still works.');
    }
    const eng = p.ttsEngine;
    if (p.ttsEnabled && eng && eng.mode === 'backup') {
        lines.push(eng.reason === 'no_key' ? '*🤖 Backup voice (no Google key)*' : '*🤖 Using the backup voice today (Google voices come back after midnight Pacific time)*');
    }

    const v = getVoice(p.voiceName);
    lines.push(`**Your voice:** ${v ? v.label : p.voiceName}${p.voiceIsDefault ? ' (default)' : ''}`);
    if (p.djRoleId) lines.push(`**DJ role:** <@&${p.djRoleId}> (needed for Play, Pause, Skip, Clear and Leave)`);
    if (p.notice) lines.push('', trim(p.notice, 300));

    const embed = {
        title: '🔊 Pingway Voice',
        description: trim(lines.join('\n'), 4000),
        color: 0x5865f2,
        footer: { text: 'Play: paste an audio / radio link, or type words to search internet radio.' }
    };

    const disabledAll = !p.voiceReady;
    const np = connected && st.nowPlaying;
    const components = [];

    const r1 = [button(ID.join, 'Join', 'success', { emoji: '🔊', disabled: disabledAll })];
    if (p.moveOffer) r1.push(button(ID.move, 'Move here', 'primary', { emoji: '↪️', disabled: disabledAll }));
    r1.push(button(ID.leave, 'Leave', 'danger', { emoji: '👋', disabled: disabledAll || !connected }));
    r1.push(button(ID.refresh, 'Refresh', 'secondary', { emoji: '🔄' }));
    components.push(row(...r1));

    components.push(row(
        button(ID.play, 'Play', 'primary', { emoji: '▶️', disabled: disabledAll }),
        button(ID.pause, np && np.paused ? 'Resume' : 'Pause', 'secondary', { emoji: np && np.paused ? '▶️' : '⏸️', disabled: disabledAll || !np }),
        button(ID.skip, 'Skip', 'secondary', { emoji: '⏭️', disabled: disabledAll || !(np || (connected && st.speaking)) }),
        button(ID.clear, 'Clear queue', 'secondary', { emoji: '🧹', disabled: disabledAll || !(connected && (st.musicQueue || st.ttsQueue)) })
    ));

    components.push(row({
        type: 3,
        custom_id: ID.lang,
        placeholder: 'Choose your TTS voice: language…',
        min_values: 1,
        max_values: 1,
        options: LANGUAGES.slice(0, 25).map(l => ({
            label: trim(l.label, 80), value: l.code, emoji: { name: l.emoji }, default: l.code === p.selectedLang
        }))
    }));

    if (p.selectedLang && getLanguage(p.selectedLang)) {
        const list = voicesFor(p.selectedLang, p.available).slice(0, 24);
        components.push(row({
            type: 3,
            custom_id: ID.voice,
            placeholder: trim('Choose a ' + getLanguage(p.selectedLang).label + ' voice…', 150),
            min_values: 1,
            max_values: 1,
            options: [
                { label: 'Use the server default voice', value: DEFAULT_VALUE, emoji: { name: '↩️' } },
                ...list.map(x => ({ label: trim(x.label, 80), value: x.name, default: x.name === p.voiceName && !p.voiceIsDefault }))
            ]
        }));
    }

    if (Array.isArray(p.radioResults) && p.radioResults.length && components.length < 5) {
        components.push(row({
            type: 3,
            custom_id: ID.radio,
            placeholder: 'Pick a radio station to play…',
            min_values: 1,
            max_values: 1,
            options: p.radioResults.slice(0, 10).map(stationOption)
        }));
    }

    return { embeds: [embed], components };
}

function buildPlayModal() {
    return {
        title: 'Play audio or internet radio',
        custom_id: ID.modal,
        components: [row({
            type: 4,
            custom_id: ID.modalInput,
            style: 1,
            label: 'Audio / radio link, or radio search words',
            placeholder: 'https://example.com/stream.mp3  or  lofi',
            min_length: 2,
            max_length: 400,
            required: true
        })]
    };
}

module.exports = { ID, DEFAULT_VALUE, buildPanel, buildPlayModal };
