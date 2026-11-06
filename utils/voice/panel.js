// /vc control panel as raw Discord API JSON (no builders needed, easy to test against Discord's limits).
// Every customId starts with 'vc_' and contains none of the words other handlers match on
// ('release', 'evercold', 'warp', 'btn_', 'select_').

const { LANGUAGES, getLanguage, getVoice, voicesFor } = require('./voices');
const { stationOption } = require('./radio');
const { t, tOr } = require('../i18n');

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
 * @param {object|null} p.ttsEngine    tts.engineStatus(): { mode: 'google'|'backup'|'off', reason } ('call' = this call uses the backup voice)
 * @param {string}  p.voiceName        the user's effective voice
 * @param {boolean} p.voiceIsDefault   true when it comes from the server / global default
 * @param {string|null} p.selectedLang language picked in the first menu (shows the voice menu)
 * @param {Set|null} p.available       voices Google offers (null = unknown -> show all)
 * @param {Array|null} p.radioResults  stations from the last search
 * @param {string|null} p.moveOffer    channel id Pingway can be moved out of (empty of humans)
 * @param {string|null} p.djRoleId
 * @param {string|null} p.notice       one-line feedback for this user
 * @param {string} [p.lang]            the reader's language (en, fr, de, ja); texts in locales/<lang>/vc.json
 */
function buildPanel(p) {
    const lang = p.lang || 'en';
    const st = p.status;
    const connected = !!st;
    const lines = [];

    if (!p.voiceReady) {
        lines.push(t(lang, 'vc.panel.notInstalled'));
    } else if (connected) {
        lines.push(t(lang, 'vc.panel.channel', { channelId: st.channelId }));
    } else {
        lines.push(t(lang, 'vc.panel.notConnected'));
    }

    if (connected) {
        const np = st.nowPlaying;
        lines.push(t(lang, 'vc.panel.nowPlaying', { what: np ? `${np.live ? '📻' : '🎵'} ${trim(np.title, 80)}${np.paused ? t(lang, 'vc.panel.paused') : ''}` : t(lang, 'vc.panel.nothing') }));
        lines.push(t(lang, 'vc.panel.queue', {
            tracks: t(lang, st.musicQueue === 1 ? 'vc.panel.track' : 'vc.panel.tracks', { n: st.musicQueue }),
            messages: t(lang, st.ttsQueue === 1 ? 'vc.panel.message' : 'vc.panel.messages', { n: st.ttsQueue }),
            speaking: st.speaking ? t(lang, 'vc.panel.speaking') : ''
        }));
    }

    if (p.ttsEnabled) {
        lines.push(connected
            ? t(lang, 'vc.panel.ttsOnIn', { channelId: st.channelId })
            : t(lang, 'vc.panel.ttsOnLater'));
    } else {
        lines.push(t(lang, 'vc.panel.ttsOff'));
    }
    const eng = p.ttsEngine;
    if (p.ttsEnabled && eng && eng.mode === 'backup') {
        lines.push(eng.reason === 'no_key' ? t(lang, 'vc.panel.backupNoKey')
            : eng.reason === 'call' ? t(lang, 'vc.panel.backupCall')   // per-call rules (names nobody)
            : eng.reason === 'switch' ? t(lang, 'vc.panel.backup')
            : t(lang, 'vc.panel.backupToday'));
    }

    const v = getVoice(p.voiceName);
    lines.push(t(lang, 'vc.panel.yourVoice', { voice: v ? v.label : p.voiceName, isDefault: p.voiceIsDefault ? t(lang, 'vc.panel.default') : '' }));
    if (p.djRoleId) lines.push(t(lang, 'vc.panel.djRole', { roleId: p.djRoleId }));
    if (p.notice) lines.push('', trim(p.notice, 300));

    const embed = {
        title: t(lang, 'vc.panel.title'),
        description: trim(lines.join('\n'), 4000),
        color: 0x5865f2,
        footer: { text: t(lang, 'vc.panel.footer') }
    };

    const disabledAll = !p.voiceReady;
    const np = connected && st.nowPlaying;
    const components = [];

    const r1 = [button(ID.join, t(lang, 'vc.panel.join'), 'success', { emoji: '🔊', disabled: disabledAll })];
    if (p.moveOffer) r1.push(button(ID.move, t(lang, 'vc.panel.move'), 'primary', { emoji: '↪️', disabled: disabledAll }));
    r1.push(button(ID.leave, t(lang, 'vc.panel.leave'), 'danger', { emoji: '👋', disabled: disabledAll || !connected }));
    r1.push(button(ID.refresh, t(lang, 'vc.panel.refresh'), 'secondary', { emoji: '🔄' }));
    components.push(row(...r1));

    components.push(row(
        button(ID.play, t(lang, 'vc.panel.play'), 'primary', { emoji: '▶️', disabled: disabledAll }),
        button(ID.pause, np && np.paused ? t(lang, 'vc.panel.resume') : t(lang, 'vc.panel.pause'), 'secondary', { emoji: np && np.paused ? '▶️' : '⏸️', disabled: disabledAll || !np }),
        button(ID.skip, t(lang, 'vc.panel.skip'), 'secondary', { emoji: '⏭️', disabled: disabledAll || !(np || (connected && st.speaking)) }),
        button(ID.clear, t(lang, 'vc.panel.clear'), 'secondary', { emoji: '🧹', disabled: disabledAll || !(connected && (st.musicQueue || st.ttsQueue)) })
    ));

    components.push(row({
        type: 3,
        custom_id: ID.lang,
        placeholder: t(lang, 'vc.panel.chooseLanguage'),
        min_values: 1,
        max_values: 1,
        options: LANGUAGES.slice(0, 25).map(l => ({
            label: trim(tOr(lang, 'vc.languages.' + l.code, l.label), 80), value: l.code, emoji: { name: l.emoji }, default: l.code === p.selectedLang
        }))
    }));

    if (p.selectedLang && getLanguage(p.selectedLang)) {
        const list = voicesFor(p.selectedLang, p.available).slice(0, 24);
        components.push(row({
            type: 3,
            custom_id: ID.voice,
            placeholder: trim(t(lang, 'vc.panel.chooseVoice', { language: tOr(lang, 'vc.languages.' + p.selectedLang, getLanguage(p.selectedLang).label) }), 150),
            min_values: 1,
            max_values: 1,
            options: [
                { label: t(lang, 'vc.panel.serverDefault'), value: DEFAULT_VALUE, emoji: { name: '↩️' } },
                ...list.map(x => ({ label: trim(x.label, 80), value: x.name, default: x.name === p.voiceName && !p.voiceIsDefault }))
            ]
        }));
    }

    if (Array.isArray(p.radioResults) && p.radioResults.length && components.length < 5) {
        components.push(row({
            type: 3,
            custom_id: ID.radio,
            placeholder: t(lang, 'vc.panel.pickStation'),
            min_values: 1,
            max_values: 1,
            options: p.radioResults.slice(0, 10).map(x => stationOption(x, lang))
        }));
    }

    return { embeds: [embed], components };
}

function buildPlayModal(lang = 'en') {
    return {
        title: t(lang, 'vc.modal.title'),
        custom_id: ID.modal,
        components: [row({
            type: 4,
            custom_id: ID.modalInput,
            style: 1,
            label: t(lang, 'vc.modal.label'),
            placeholder: 'https://example.com/stream.mp3  or  lofi',
            min_length: 2,
            max_length: 400,
            required: true
        })]
    };
}

module.exports = { ID, DEFAULT_VALUE, buildPanel, buildPlayModal };
