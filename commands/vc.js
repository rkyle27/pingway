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
    synthesize: (text, voiceName) => tts.synthesize(text, voiceName),
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

async function render(interaction, notice, extra = {}) {
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
        voiceName,
        voiceIsDefault: !userVoice,
        selectedLang: st.lang,
        available,
        radioResults: st.radio,
        moveOffer: extra.moveOffer || null,
        djRoleId: settings.djRoleId,
        notice: notice || (session && session.status().notice) || null
    });
}

/**
 * Makes sure Pingway is in the member's voice channel.
 * @returns {{ session?, notice?, moveOffer? }}
 */
async function ensureJoined(interaction, { allowMove = false } = {}) {
    const voice = lib.loadVoice();
    if (!voice) return { notice: '⚠️ Voice is not installed on this bot yet.' };
    const guild = interaction.guild;
    const member = interaction.member;
    const channel = member && member.voice ? member.voice.channel : null;
    if (!channel) return { notice: '🔇 Join a voice channel first, then press **Join**.' };
    if (channel.type === GUILD_STAGE_VOICE) return { notice: '⚠️ Stage channels are not supported. Use a normal voice channel.' };

    const session = getSession(guild.id);
    if (session && session.channelId === channel.id) return { session };
    if (session) {
        const other = guild.channels.cache.get(session.channelId);
        const people = other ? humansIn(other) : 0;
        if (people > 0) return { notice: `⚠️ I'm already in <#${session.channelId}> and people are listening there.` };
        if (!allowMove) {
            return { notice: `ℹ️ I'm in <#${session.channelId}>, but nobody is there. Press **Move here** to bring me to <#${channel.id}>.`, moveOffer: channel.id };
        }
    }

    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms || !perms.has(['ViewChannel', 'Connect', 'Speak'])) {
        return { notice: `⚠️ I need **View Channel**, **Connect** and **Speak** permissions in <#${channel.id}>.` };
    }
    if (!channel.joinable) return { notice: `⚠️ I can't join <#${channel.id}> (it may be full).` };

    try {
        const s = await joinChannel({ guild, channel, voice, deps: realDeps });
        s.setHumanCount(humansIn(channel));
        return { session: s, joined: true };
    } catch (err) {
        console.error(`❌ [VC] join failed | guild ${guild.id}:`, err.message);
        return { notice: '❌ I could not connect to the voice channel. Please try again in a moment.' };
    }
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
    const joined = await ensureJoined(interaction);
    if (!joined.session) return joined;
    const session = joined.session;
    const before = session.musicQueue.length;
    const pos = session.enqueueMusic({ url, title: title || null, requestedBy: interaction.user.id });
    if (pos < 0) return { notice: '⚠️ The music queue is full (25). Skip or clear something first.' };
    const item = pos === 0 ? (session.current && session.current.item) : session.musicQueue[session.musicQueue.length - 1];
    if (pos === 0 && item) await waitForStart(session, item);
    if (pos === 0) {
        if (session.current && session.current.item === item) return { notice: `▶️ Playing **${(item.title || 'your link').slice(0, 80)}**.` };
        return { notice: session.lastNotice || '⚠️ That link could not be played.' };
    }
    return { notice: `➕ Queued at position ${before + 1}: **${(title || 'your link').slice(0, 80)}**.` };
}

module.exports = {
    data: {
        name: 'vc',
        description: '🔊 Voice: read the voice chat aloud (TTS) and play music / internet radio.',
        contexts: [0],          // servers only
        integration_types: [0]
    },

    async execute(interaction) {
        if (!interaction.inGuild || !interaction.inGuild()) {
            return interaction.reply({ content: '⚠️ /vc only works in a server.', flags: EPHEMERAL });
        }
        await interaction.deferReply({ flags: EPHEMERAL });
        try {
            await store.ensureTables().catch(err => console.error('⚠️ [VC] tables:', err.code || err.message));
            const payload = await render(interaction);
            return interaction.editReply(payload);
        } catch (err) {
            console.error('❌ [VC] panel:', err.message);
            return interaction.editReply({ content: '❌ The voice panel is not available right now.', embeds: [], components: [] }).catch(() => {});
        }
    },

    async handleInteraction(interaction) {
        const cid = interaction.customId || '';
        if (!cid.startsWith('vc_')) return;
        if (!interaction.inGuild || !interaction.inGuild()) return;
        const guildId = interaction.guildId;
        const member = interaction.member;
        const session = getSession(guildId);
        const botChannelId = session ? session.channelId : null;

        // ---- Play button: the modal must be the FIRST answer (no defer before it) ----
        if (cid === ID.play && interaction.isButton()) {
            const settings = store.peekGuildSettings(guildId) || { djRoleId: null }; // re-checked on submit
            const ok = canUse('play', { member, botChannelId, settings });
            if (ok.ok) return interaction.showModal(buildPlayModal());
            await interaction.deferUpdate();
            return interaction.editReply(await render(interaction, '🚫 ' + ok.reason));
        }

        await interaction.deferUpdate();
        let notice = null;
        let extra = {};
        try {
            const settings = await store.getGuildSettings(guildId);
            const check = action => canUse(action, { member, botChannelId, settings });
            const st = stateOf(guildId, interaction.user.id);

            switch (cid) {
                case ID.refresh:
                    break;

                case ID.join:
                case ID.move: {
                    const r = await ensureJoined(interaction, { allowMove: cid === ID.move });
                    if (r.session) {
                        notice = r.joined ? `✅ Joined <#${r.session.channelId}>.` : `✅ I'm in <#${r.session.channelId}>.`;
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
                    notice = '👋 Left the voice channel.';
                    break;
                }

                case ID.skip:
                case ID.clear:
                case ID.pause: {
                    const action = cid === ID.skip ? 'skip' : cid === ID.clear ? 'clear' : 'pause';
                    const ok = check(action);
                    if (!ok.ok) { notice = '🚫 ' + ok.reason; break; }
                    if (!session) { notice = "I'm not in a voice channel."; break; }
                    if (action === 'skip') {
                        const what = session.skip();
                        notice = what === 'speech' ? '⏭️ Skipped the message being read.' : what === 'music' ? '⏭️ Skipped.' : 'Nothing to skip.';
                    } else if (action === 'clear') {
                        const n = session.clear();
                        notice = `🧹 Cleared ${n.music} track${n.music === 1 ? '' : 's'} and ${n.speech} message${n.speech === 1 ? '' : 's'}.`;
                    } else {
                        const r = session.togglePause();
                        notice = r === 'paused' ? '⏸️ Paused.' : r === 'resumed' ? '▶️ Resumed.' : 'Nothing is playing.';
                    }
                    break;
                }

                case ID.lang: {
                    const v = interaction.values && interaction.values[0];
                    st.lang = getLanguage(v) ? v : null;
                    if (st.lang) notice = `Pick a ${getLanguage(st.lang).label} voice in the menu below.`;
                    break;
                }

                case ID.voice: {
                    const v = interaction.values && interaction.values[0];
                    if (v === DEFAULT_VALUE) {
                        await store.setUserVoice(interaction.user.id, null);
                        notice = '✅ You now use the server default voice.';
                    } else if (isKnownVoice(v)) {
                        await store.setUserVoice(interaction.user.id, v);
                        st.lang = languageCodeOf(v);
                        notice = `✅ Your voice is now **${getVoice(v).label}** (in every server).`;
                    } else {
                        notice = '⚠️ Unknown voice.';
                    }
                    break;
                }

                case ID.radio: {
                    const ok = check('play');
                    if (!ok.ok) { notice = '🚫 ' + ok.reason; break; }
                    const uuid = interaction.values && interaction.values[0];
                    const station = (st.radio || []).find(x => x.uuid === uuid);
                    if (!station) { notice = '⚠️ That search is too old. Press **Play** and search again.'; break; }
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
                            notice = '🚫 ' + (err instanceof UrlRefused ? err.message : 'That link cannot be played.');
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
                            notice = '⚠️ Radio search is not available right now. Try again later or paste a direct link.';
                            break;
                        }
                        st.radio = results.length ? results : null;
                        notice = results.length
                            ? `📻 Found ${results.length} station${results.length === 1 ? '' : 's'} for "${input.slice(0, 50)}" - pick one below.`
                            : `📻 No stations found for "${input.slice(0, 50)}".`;
                    }
                    break;
                }

                default:
                    return;
            }
        } catch (err) {
            console.error(`❌ [VC] ${cid} | guild ${guildId}:`, err.message);
            notice = '❌ Something went wrong. Please try again.';
        }
        return interaction.editReply(await render(interaction, notice, extra));
    },

    // exported for tests
    _internal: { ensureJoined, render, stateOf, realDeps }
};
