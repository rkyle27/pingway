// /vc: Pingway Voice - text-to-speech of the voice channel's text chat + music / internet radio player.
// The command replies with ONE private (ephemeral) control panel. Its buttons / menus / modal use customIds
// starting with 'vc_' and are routed here from events/interactionCreate.js -> handleInteraction().
// Every component is acknowledged right away (deferUpdate) and the panel is then edited (editReply),
// except the Play button, whose first answer must be the modal.
// Logic lives in utils/voice/*. Message text is never stored or logged.

const store = require('../utils/voice/store');
const tts = require('../utils/voice/tts');
const radio = require('../utils/voice/radio');
const lib = require('../utils/voice/lib');
const { canUse } = require('../utils/voice/perms');
const { checkUrl, looksLikeUrl, openAudioUrl, UrlRefused } = require('../utils/voice/urlSafety');
const { ID, DEFAULT_VALUE, buildPanel, buildPlayModal } = require('../utils/voice/panel');
const { resolveVoice, isKnownVoice, getVoice, getLanguage, languageCodeOf } = require('../utils/voice/voices');
const { getSession, joinChannel, destroySession } = require('../utils/voice/session');
const members = require('../utils/voice/members');
const i18n = require('../utils/i18n');
const { t, tOr } = i18n;

// Language of the person using the panel (their choice -> Discord app language -> English). Never fails:
// without a database (tests) it falls back to the Discord app language.
async function langOf(interaction) {
    try {
        return await require('../utils/userLanguage').forInteraction(interaction);
    } catch (e) {
        return i18n.fromDiscordLocale(interaction && interaction.locale) || 'en';
    }
}
// A refused link (urlSafety) in the reader's language
const urlReason = (lang, err) => (err && err.code ? tOr(lang, 'vc.url.' + err.code, err.message, err.vars || undefined) : (err && err.message) || 'error');
// A notice the session made by itself (shown in the panel) in the reader's language
function sessionNotice(lang, status) {
    if (!status || !status.notice) return null;
    const n = status.noticeI18n;
    if (!n || !n.key) return status.notice;
    const v = n.vars || {};
    if (n.key === 'vc.couldNotPlay') {
        return t(lang, n.key, { title: v.title || t(lang, 'vc.thatLink'), reason: v.code ? urlReason(lang, { code: v.code, message: v.reason, vars: v.codeVars }) : v.reason });
    }
    return t(lang, n.key, v);
}

const EPHEMERAL = 64;            // MessageFlags.Ephemeral
const GUILD_STAGE_VOICE = 13;    // ChannelType.GuildStageVoice
const PANEL_STATE_TTL_MS = 15 * 60 * 1000;

// per person+server panel state: chosen language (voice menu) and last radio search results
const panelState = new Map();
function stateOf(guildId, userId) {
    const key = guildId + ':' + userId;
    const now = Date.now();
    let s = panelState.get(key);
    if (!s || now - s.at > PANEL_STATE_TTL_MS) s = { lang: null, radio: null, at: now };
    s.at = now;
    panelState.set(key, s);
    if (panelState.size > 2000) {
        for (const [k, v] of panelState) if (now - v.at > PANEL_STATE_TTL_MS) panelState.delete(k);
    }
    return s;
}

const realDeps = {
    // Google, or the eSpeak backup voice; the session's caller decides Google after the free period (members.js)
    synthesize: (text, voiceName, session) => tts.speak(text, voiceName, session ? { plan: chars => members.planGoogle(session, chars) } : {}),
    openAudio: url => openAudioUrl(url),
    spawnFfmpeg: opts => lib.spawnFfmpeg(opts),
    ttsEnabled: () => tts.isEnabled()
};

function humansIn(channel) {
    try {
        return channel.members.filter(m => !m.user.bot).size;
    } catch {
        return 0;
    }
}

async function availableQuick() {
    // never let the Google voice list slow the panel down
    return Promise.race([tts.availableVoices(), new Promise(r => setTimeout(() => r(null), 1500))]);
}

/** Engine for the panel: only ever "Google voice" or "backup voice" (names nobody). */
async function callEngine(session, { engineStatus = tts.engineStatus, plan = members.planGoogle } = {}) {
    const eng = engineStatus();
    if (!session || eng.mode === 'off' || eng.reason === 'no_key' || eng.reason === 'switch' || eng.reason === 'quota') return eng;
    try {
        const p = await plan(session, 1, { dryRun: true });
        if (!p.google) return { mode: 'backup', reason: 'call' };
        if (p.reason === 'member') return { mode: 'google', reason: null }; // the daily cap is for free use only
    } catch { /* keep the global status */ }
    return eng;
}

/** Remembers who brought Pingway into this call (Google voice rules) and how to post a short note in its chat. */
function setCaller(session, guild, userId) {
    session.setCaller(userId, {
        isPresent: () => {
            const vs = guild.voiceStates && guild.voiceStates.cache.get(userId);
            return !!vs && vs.channelId === session.channelId;
        },
        sendNote: text => {
            // the note is posted in the voice channel's chat: the server's language
            const glang = require('../utils/guildLanguage').get(guild && guild.id) || i18n.fromDiscordLocale(guild && guild.preferredLocale) || 'en'; // Server language card first
            if (text === members.OUT_OF_CHARS_NOTE) text = t(glang, 'vc.outOfChars');
            const ch = guild.channels.cache.get(session.channelId);
            if (ch && typeof ch.send === 'function') return ch.send({ content: text, allowedMentions: { parse: [] } });
        }
    });
}

async function render(interaction, notice, extra = {}) {
    const lang = await langOf(interaction);
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const st = stateOf(guildId, userId);
    const session = getSession(guildId);
    const [settings, userVoice, available] = await Promise.all([
        store.getGuildSettings(guildId), store.getUserVoice(userId), availableQuick()
    ]);
    const voiceName = resolveVoice(userVoice, settings.defaultVoice);
    return buildPanel({
        status: session ? session.status() : null,
        voiceReady: !!lib.loadVoice(),
        ttsEnabled: tts.isEnabled(),
        ttsEngine: await callEngine(session),
        voiceName,
        voiceIsDefault: !userVoice,
        selectedLang: st.lang,
        available,
        radioResults: st.radio,
        moveOffer: extra.moveOffer || null,
        djRoleId: settings.djRoleId,
        notice: notice || (session && sessionNotice(lang, session.status())) || null,
        lang
    });
}

/**
 * Makes sure Pingway is in the member's voice channel.
 * @returns {{ session?, notice?, moveOffer? }}
 */
async function ensureJoined(interaction, { allowMove = false } = {}) {
    const lang = await langOf(interaction);
    const voice = lib.loadVoice();
    if (!voice) return { notice: t(lang, 'vc.notInstalled') };
    const guild = interaction.guild;
    const member = interaction.member;
    const channel = member && member.voice ? member.voice.channel : null;
    if (!channel) return { notice: t(lang, 'vc.joinFirst') };
    if (channel.type === GUILD_STAGE_VOICE) return { notice: t(lang, 'vc.noStage') };

    const session = getSession(guild.id);
    if (session && session.channelId === channel.id) return { session };
    if (session) {
        const other = guild.channels.cache.get(session.channelId);
        const people = other ? humansIn(other) : 0;
        if (people > 0) return { notice: t(lang, 'vc.alreadyIn', { channelId: session.channelId }) };
        if (!allowMove) {
            return { notice: t(lang, 'vc.moveOffer', { channelId: session.channelId, here: channel.id }), moveOffer: channel.id };
        }
    }

    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms || !perms.has(['ViewChannel', 'Connect', 'Speak'])) {
        return { notice: t(lang, 'vc.needPerms', { channelId: channel.id }) };
    }
    if (!channel.joinable) return { notice: t(lang, 'vc.cantJoin', { channelId: channel.id }) };

    try {
        const s = await joinChannel({ guild, channel, voice, deps: realDeps });
        setCaller(s, guild, interaction.user.id); // joined or moved by this /vc: this person is the caller now
        s.setHumanCount(humansIn(channel));
        return { session: s, joined: true };
    } catch (err) {
        console.error(`❌ [VC] join failed | guild ${guild.id}:`, err.message);
        return { notice: t(lang, 'vc.connectFailed') };
    }
}

/**
 * "Stay in voice" from the panel button (want = 'toggle') or /vc stay:<true|false>.
 * Same permission rules as the other panel controls (same channel as Pingway, DJ role if set).
 * @returns {Promise<string>} short notice for the (ephemeral) panel
 */
async function applyStay(interaction, lang, want) {
    const guildId = interaction.guildId;
    const session = getSession(guildId);
    const settings = await store.getGuildSettings(guildId);
    const ok = canUse('stay', { member: interaction.member, botChannelId: session ? session.channelId : null, settings, lang });
    if (!ok.ok) return '🚫 ' + ok.reason;
    if (!session) return t(lang, 'vc.notInVoice');
    const on = session.setStay(want === 'toggle' ? !session.stay : !!want);
    return t(lang, on ? 'vc.stayOn' : 'vc.stayOff');
}

/** Waits (max `ms`) until the queued link starts or fails, so the panel shows the real result. */
async function waitForStart(session, item, ms = 6000) {
    const until = Date.now() + ms;
    const before = session.lastNotice;
    while (Date.now() < until && !session.destroyed) {
        const cur = session.current;
        if (!cur || cur.item !== item || !cur.loading) return; // started, failed or replaced
        if (session.lastNotice !== before) return;
        await new Promise(r => setTimeout(r, 250));
    }
}

async function queueUrl(interaction, url, title) {
    const lang = await langOf(interaction);
    const joined = await ensureJoined(interaction);
    if (!joined.session) return joined;
    const session = joined.session;
    const before = session.musicQueue.length;
    const pos = session.enqueueMusic({ url, title: title || null, requestedBy: interaction.user.id });
    if (pos < 0) return { notice: t(lang, 'vc.queueFull') };
    const item = pos === 0 ? (session.current && session.current.item) : session.musicQueue[session.musicQueue.length - 1];
    if (pos === 0 && item) await waitForStart(session, item);
    if (pos === 0) {
        if (session.current && session.current.item === item) return { notice: t(lang, 'vc.playing', { title: (item.title || t(lang, 'vc.yourLink')).slice(0, 80) }) };
        return { notice: (session.lastNotice && sessionNotice(lang, { notice: session.lastNotice, noticeI18n: session.lastNoticeI18n })) || t(lang, 'vc.cantPlay') };
    }
    return { notice: t(lang, 'vc.queued', { pos: before + 1, title: (title || t(lang, 'vc.yourLink')).slice(0, 80) }) };
}

module.exports = {
    data: {
        name: 'vc',
        description: t('en', 'vc.cmd.description'),
        description_localizations: i18n.discordLocalizations('vc.cmd.description'),
        contexts: [0],          // servers only
        integration_types: [0],
        // optional: plain /vc still just opens the panel
        options: [{
            type: 5,            // BOOLEAN
            name: 'stay',     // read back with getBoolean('stay')
            name_localizations: i18n.discordLocalizations('vc.cmd.stayName'),
            description: t('en', 'vc.cmd.stayDescription'),
            description_localizations: i18n.discordLocalizations('vc.cmd.stayDescription'),
            required: false
        }]
    },

    async execute(interaction) {
        const lang = await langOf(interaction);
        if (!interaction.inGuild || !interaction.inGuild()) {
            return interaction.reply({ content: t(lang, 'vc.serverOnly'), flags: EPHEMERAL });
        }
        await interaction.deferReply({ flags: EPHEMERAL });
        try {
            await store.ensureTables().catch(err => console.error('⚠️ [VC] tables:', err.code || err.message));
            const stayOpt = interaction.options && typeof interaction.options.getBoolean === 'function' ? interaction.options.getBoolean('stay') : null;
            if (stayOpt !== null && stayOpt !== undefined) return interaction.editReply(await render(interaction, await applyStay(interaction, lang, stayOpt)));
            const payload = await render(interaction);
            return interaction.editReply(payload);
        } catch (err) {
            console.error('❌ [VC] panel:', err.message);
            return interaction.editReply({ content: t(lang, 'vc.panelUnavailable'), embeds: [], components: [] }).catch(() => {});
        }
    },

    async handleInteraction(interaction) {
        const cid = interaction.customId || '';
        if (!cid.startsWith('vc_')) return;
        if (!interaction.inGuild || !interaction.inGuild()) return;
        const lang = await langOf(interaction);
        const guildId = interaction.guildId;
        const member = interaction.member;
        const session = getSession(guildId);
        const botChannelId = session ? session.channelId : null;

        // ---- Play button: the modal must be the FIRST answer (no defer before it) ----
        if (cid === ID.play && interaction.isButton()) {
            const settings = store.peekGuildSettings(guildId) || { djRoleId: null }; // re-checked on submit
            const ok = canUse('play', { member, botChannelId, settings, lang });
            if (ok.ok) return interaction.showModal(buildPlayModal(lang));
            await interaction.deferUpdate();
            return interaction.editReply(await render(interaction, '🚫 ' + ok.reason));
        }

        await interaction.deferUpdate();
        let notice = null;
        let extra = {};
        try {
            const settings = await store.getGuildSettings(guildId);
            const check = action => canUse(action, { member, botChannelId, settings, lang });
            const st = stateOf(guildId, interaction.user.id);

            switch (cid) {
                case ID.refresh:
                    break;

                case ID.join:
                case ID.move: {
                    const r = await ensureJoined(interaction, { allowMove: cid === ID.move });
                    if (r.session) {
                        notice = r.joined ? t(lang, 'vc.joined', { channelId: r.session.channelId }) : t(lang, 'vc.imIn', { channelId: r.session.channelId });
                    } else {
                        notice = r.notice;
                        extra.moveOffer = r.moveOffer;
                    }
                    break;
                }

                case ID.leave: {
                    const ok = check('leave');
                    if (!ok.ok) { notice = '🚫 ' + ok.reason; break; }
                    destroySession(guildId, 'leave button');
                    notice = t(lang, 'vc.left');
                    break;
                }

                case ID.stay:
                    notice = await applyStay(interaction, lang, 'toggle');
                    break;

                case ID.skip:
                case ID.clear:
                case ID.pause: {
                    const action = cid === ID.skip ? 'skip' : cid === ID.clear ? 'clear' : 'pause';
                    const ok = check(action);
                    if (!ok.ok) { notice = '🚫 ' + ok.reason; break; }
                    if (!session) { notice = t(lang, 'vc.notInVoice'); break; }
                    if (action === 'skip') {
                        const what = session.skip();
                        notice = what === 'speech' ? t(lang, 'vc.skippedSpeech') : what === 'music' ? t(lang, 'vc.skipped') : t(lang, 'vc.nothingToSkip');
                    } else if (action === 'clear') {
                        const n = session.clear();
                        notice = t(lang, 'vc.cleared', { tracks: t(lang, n.music === 1 ? 'vc.panel.track' : 'vc.panel.tracks', { n: n.music }), messages: t(lang, n.speech === 1 ? 'vc.panel.message' : 'vc.panel.messages', { n: n.speech }) });
                    } else {
                        const r = session.togglePause();
                        notice = r === 'paused' ? t(lang, 'vc.paused') : r === 'resumed' ? t(lang, 'vc.resumed') : t(lang, 'vc.nothingPlaying');
                    }
                    break;
                }

                case ID.lang: {
                    const v = interaction.values && interaction.values[0];
                    st.lang = getLanguage(v) ? v : null;
                    if (st.lang) notice = t(lang, 'vc.pickVoice', { language: tOr(lang, 'vc.languages.' + st.lang, getLanguage(st.lang).label) });
                    break;
                }

                case ID.voice: {
                    const v = interaction.values && interaction.values[0];
                    if (v === DEFAULT_VALUE) {
                        await store.setUserVoice(interaction.user.id, null);
                        notice = t(lang, 'vc.defaultVoice');
                    } else if (isKnownVoice(v)) {
                        await store.setUserVoice(interaction.user.id, v);
                        st.lang = languageCodeOf(v);
                        notice = t(lang, 'vc.voiceSet', { voice: getVoice(v).label });
                    } else {
                        notice = t(lang, 'vc.unknownVoice');
                    }
                    break;
                }

                case ID.radio: {
                    const ok = check('play');
                    if (!ok.ok) { notice = '🚫 ' + ok.reason; break; }
                    const uuid = interaction.values && interaction.values[0];
                    const station = (st.radio || []).find(x => x.uuid === uuid);
                    if (!station) { notice = t(lang, 'vc.searchOld'); break; }
                    const url = await radio.clickStation(station.uuid, station.url);
                    st.radio = null;
                    const r = await queueUrl(interaction, url, station.name);
                    notice = r.notice;
                    extra.moveOffer = r.moveOffer;
                    break;
                }

                case ID.modal: {
                    const ok = check('play');
                    if (!ok.ok) { notice = '🚫 ' + ok.reason; break; }
                    const input = String(interaction.fields.getTextInputValue(ID.modalInput) || '').trim();
                    if (looksLikeUrl(input)) {
                        try {
                            await checkUrl(input); // fast refusal: bad scheme, YouTube/Spotify/SoundCloud, private address
                        } catch (err) {
                            notice = '🚫 ' + (err instanceof UrlRefused ? urlReason(lang, err) : t(lang, 'vc.linkCantPlay'));
                            break;
                        }
                        const r = await queueUrl(interaction, input, null);
                        notice = r.notice;
                        extra.moveOffer = r.moveOffer;
                    } else {
                        let results = [];
                        try {
                            results = await radio.searchStations(input);
                        } catch (err) {
                            console.error('⚠️ [VC] radio search failed:', err.message);
                            notice = t(lang, 'vc.radioUnavailable');
                            break;
                        }
                        st.radio = results.length ? results : null;
                        notice = results.length
                            ? t(lang, results.length === 1 ? 'vc.foundOne' : 'vc.foundMany', { n: results.length, query: input.slice(0, 50) })
                            : t(lang, 'vc.noStations', { query: input.slice(0, 50) });
                    }
                    break;
                }

                default:
                    return;
            }
        } catch (err) {
            console.error(`❌ [VC] ${cid} | guild ${guildId}:`, err.message);
            notice = t(lang, 'vc.failed');
        }
        return interaction.editReply(await render(interaction, notice, extra));
    },

    // exported for tests
    _internal: { ensureJoined, render, stateOf, realDeps, callEngine, setCaller, applyStay }
};
