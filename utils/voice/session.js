// One VoiceSession per server while Pingway is in a voice channel.
//
// Audio layout (keeps memory low on the 512 MB host):
//   musicPlayer  <- ffmpeg stdout (ONE ffmpeg per guild at most, killed on skip / stop / leave)
//   ttsPlayer    <- Google TTS Ogg Opus buffer (no ffmpeg, no JS encoder), or the eSpeak backup's
//                   48 kHz PCM (encoded by opusscript; still no ffmpeg)
// The connection is subscribed to exactly one player at a time.
//
// TTS priority: when speech arrives while music plays, the music player is paused and the connection switches
// to the TTS player. ffmpeg and the HTTP stream are kept open (paused by back-pressure), so after the speech
// the music continues exactly where it stopped - for files AND radio, without re-downloading or -ss seeking.
// Exception: a live radio stream that was held for more than 15 s is reconnected (so it is live again, not
// minutes behind, and because many radio servers drop a client that stops reading).
// -ss is only used when a file link breaks in the middle: it is reopened once at the elapsed position.

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const TTS_QUEUE_MAX = 15;
const MUSIC_QUEUE_MAX = 25;
const ALONE_MS = 60 * 1000;
const IDLE_MS = 15 * 60 * 1000;
const LIVE_RESYNC_MS = 15 * 1000;
const LIVE_MAX_RETRIES = 3;

const realClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: t => clearTimeout(t),
    now: () => Date.now()
};

class VoiceSession extends EventEmitter {
    /**
     * @param {object} o
     * @param {string} o.guildId
     * @param {string} o.channelId
     * @param {object} o.voice      the @discordjs/voice module (or a fake in tests)
     * @param {object} o.connection VoiceConnection
     * @param {object} o.deps       { synthesize(text, voice, session) -> Buffer (Ogg Opus) | {type:'ogg'|'pcm', data}, openAudio(url) -> {stream, live, title},
     *                                spawnFfmpeg({seekSeconds}) -> {proc, ogg}, clock, ttsEnabled: () => bool }
     */
    constructor({ guildId, channelId, voice, connection, deps }) {
        super();
        this.guildId = guildId;
        this.channelId = channelId;
        this.voice = voice;
        this.connection = connection;
        this.deps = deps;
        this.clock = deps.clock || realClock;

        this.ttsQueue = [];
        this.musicQueue = [];
        this.current = null;
        this.ttsBusy = false;
        this.userPaused = false;
        this.heldByTts = false;
        this.pausedAt = null;
        this.destroyed = false;
        this.playToken = 0;
        this.aloneTimer = null;
        this.idleTimer = null;
        this.lastNotice = null;

        // the person whose /vc brought Pingway into this call (Google voice rules, see members.js)
        this.callerId = null;
        this._callerPresent = null;
        this._sendNote = null;
        this.googleWindow = [];      // Google characters in the last hour: [{ at, n }]
        this.memberGoogleUsed = false;
        this.charsNoteSent = false;

        const behaviors = { noSubscriber: voice.NoSubscriberBehavior.Pause };
        this.musicPlayer = voice.createAudioPlayer({ behaviors });
        this.ttsPlayer = voice.createAudioPlayer({ behaviors });
        this.musicPlayer.on('error', err => this._log('music player error: ' + (err && err.message)));
        this.ttsPlayer.on('error', err => this._log('tts player error: ' + (err && err.message)));
        this.musicPlayer.on('stateChange', (o, n) => this._onMusicState(o, n));
        this.ttsPlayer.on('stateChange', (o, n) => {
            if (n.status === voice.AudioPlayerStatus.Idle && o.status !== voice.AudioPlayerStatus.Idle) this._onTtsEnd();
        });
        this.connection.subscribe(this.musicPlayer);
        this._updateIdle();
    }

    _log(msg) {
        console.log(`🔊 [VC] guild ${this.guildId}: ${msg}`);
    }

    _notice(msg) {
        this.lastNotice = msg;
        this.lastNoticeAt = this.clock.now();
        this.emit('update');
    }

    // ---------------- status for the panel ----------------
    status() {
        const cur = this.current;
        return {
            channelId: this.channelId,
            nowPlaying: cur ? { title: cur.item.title || 'Audio link', live: !!cur.item.live, paused: this.userPaused } : null,
            speaking: this.ttsBusy,
            musicQueue: this.musicQueue.length,
            ttsQueue: this.ttsQueue.length,
            notice: this.lastNotice && this.clock.now() - (this.lastNoticeAt || 0) < 60000 ? this.lastNotice : null
        };
    }

    // ---------------- caller ----------------
    /**
     * @param {string} userId who ran /vc to bring Pingway here (a later /vc that moves Pingway replaces it)
     * @param {{ isPresent: () => boolean, sendNote: (text) => any }} hooks
     */
    setCaller(userId, { isPresent, sendNote } = {}) {
        if (userId !== this.callerId) {
            this.memberGoogleUsed = false;
            this.charsNoteSent = false;
        }
        this.callerId = userId || null;
        this._callerPresent = typeof isPresent === 'function' ? isPresent : null;
        this._sendNote = typeof sendNote === 'function' ? sendNote : null;
    }

    callerPresent() {
        if (!this.callerId || !this._callerPresent) return false;
        try {
            return !!this._callerPresent();
        } catch {
            return false;
        }
    }

    /** One short line in the voice channel's chat (never fails the speech). */
    sendNote(text) {
        if (!this._sendNote || this.destroyed) return;
        try {
            Promise.resolve(this._sendNote(text)).catch(err => this._log('note failed: ' + (err && (err.code || err.message))));
        } catch (err) {
            this._log('note failed: ' + (err && err.message));
        }
    }

    // ---------------- TTS ----------------
    /** @returns {boolean} false when the speech queue is full or TTS is off */
    enqueueTts(text, voiceName) {
        if (this.destroyed || !text) return false;
        if (this.deps.ttsEnabled && !this.deps.ttsEnabled()) return false;
        if (this.ttsQueue.length >= TTS_QUEUE_MAX) return false;
        this.ttsQueue.push({ text, voice: voiceName });
        this._updateIdle();
        this._pumpTts();
        return true;
    }

    async _pumpTts() {
        if (this.ttsBusy || this.destroyed) return;
        const item = this.ttsQueue.shift();
        if (!item) return this._afterTts();
        this.ttsBusy = true;
        let out;
        try {
            out = await this.deps.synthesize(item.text, item.voice, this);
        } catch (err) {
            this._log('speech failed: ' + (err && err.message)); // message never contains the text or key
            this.ttsBusy = false;
            if (this.destroyed) return;
            return this._pumpTts();
        }
        if (this.destroyed) return;
        this._holdMusic();
        this.connection.subscribe(this.ttsPlayer);
        // Google -> Ogg Opus buffer; eSpeak backup -> { type: 'pcm', data } (48 kHz stereo s16le, Opus-encoded by opusscript)
        const pcm = out && !Buffer.isBuffer(out) && out.type === 'pcm';
        const input = new PassThrough();
        input.end(Buffer.isBuffer(out) ? out : out.data);
        const resource = this.voice.createAudioResource(input, { inputType: pcm ? this.voice.StreamType.Raw : this.voice.StreamType.OggOpus });
        this.ttsPlayer.play(resource);
        this.emit('update');
    }

    _holdMusic() {
        if (!this.current || this.heldByTts) return;
        const S = this.voice.AudioPlayerStatus;
        const st = this.musicPlayer.state.status;
        if (st === S.Playing) this.musicPlayer.pause(true);
        // Buffering / AutoPaused: switching the subscription away auto-pauses it (NoSubscriberBehavior.Pause)
        this.heldByTts = true;
        if (!this.pausedAt) this.pausedAt = this.clock.now();
    }

    _onTtsEnd() {
        this.ttsBusy = false;
        if (this.destroyed) return;
        if (this.ttsQueue.length) return this._pumpTts();
        this._afterTts();
    }

    _afterTts() {
        if (this.destroyed) return;
        this.connection.subscribe(this.musicPlayer);
        if (this.heldByTts) {
            this.heldByTts = false;
            if (!this.userPaused) this._continueMusic();
        }
        this._updateIdle();
        this.emit('update');
    }

    /** Continue after a hold: reconnect live radio held too long, otherwise just unpause. */
    _continueMusic() {
        const cur = this.current;
        const heldFor = this.pausedAt ? this.clock.now() - this.pausedAt : 0;
        this.pausedAt = null;
        if (!cur) return;
        if (cur.item.live && heldFor > LIVE_RESYNC_MS) {
            this._log('reconnecting live stream after ' + Math.round(heldFor / 1000) + ' s pause');
            this._restartCurrent(0);
            return;
        }
        this.musicPlayer.unpause();
    }

    // ---------------- music ----------------
    /** @returns {number} position in queue (0 = playing now) or -1 when full */
    enqueueMusic(item) {
        if (this.destroyed) return -1;
        if (this.musicQueue.length >= MUSIC_QUEUE_MAX) return -1;
        this.musicQueue.push({ ...item, retries: 0 });
        if (!this.current) {
            this._playNext();
            return 0;
        }
        this.emit('update');
        return this.musicQueue.length;
    }

    _killCurrent() {
        const cur = this.current;
        if (!cur) return;
        cur.stopping = true;
        try { cur.src && cur.src.stream && cur.src.stream.destroy(); } catch { /* ignore */ }
        try { cur.proc && !cur.proc.killed && cur.proc.kill('SIGKILL'); } catch { /* ignore */ }
    }

    _playNext() {
        this._killCurrent();
        this.musicPlayer.stop(true); // Idle for the old resource is ignored (it is marked stopping)
        this.playToken++; // cancels a link that is still opening
        this.current = null;
        this.pausedAt = null;
        this.heldByTts = false;
        const item = this.musicQueue.shift();
        if (!item || this.destroyed) {
            this._updateIdle();
            this.emit('update');
            return Promise.resolve();
        }
        return this._startItem(item, 0);
    }

    async _startItem(item, seekSeconds) {
        const token = ++this.playToken;
        // placeholder so the panel shows what is loading and a second Play queues behind it
        this.current = { item, proc: null, src: null, resource: null, offset: seekSeconds, token, stopping: false, loading: true };
        this._updateIdle();
        this.emit('update');
        let src;
        try {
            src = await this.deps.openAudio(item.url);
        } catch (err) {
            if (token !== this.playToken || this.destroyed) return;
            this._log('could not open link: ' + (err && (err.code || err.message)));
            this.current = null;
            this._notice(`⚠️ Could not play **${item.title || 'that link'}**: ${err && err.message ? err.message : 'error'}`);
            return this._playNext();
        }
        if (token !== this.playToken || this.destroyed) {
            try { src.stream.destroy(); } catch { /* ignore */ }
            return;
        }
        item.live = !!src.live;
        if (!item.title) item.title = src.title || safeHost(src.url || item.url);

        let proc, ogg;
        try {
            ({ proc, ogg } = this.deps.spawnFfmpeg({ seekSeconds }));
        } catch (err) {
            try { src.stream.destroy(); } catch { /* ignore */ }
            this.current = null;
            this._notice('⚠️ Music is not available on this host (ffmpeg missing).');
            this.musicQueue = [];
            this._updateIdle();
            return;
        }
        const cur = { item, proc, src, resource: null, offset: seekSeconds, token, stopping: false, exitCode: undefined, startedAt: this.clock.now() };
        proc.on('exit', code => { cur.exitCode = code; });
        proc.on('error', () => { cur.exitCode = -1; });
        src.stream.on('error', () => { try { proc.stdin.end(); } catch { /* ignore */ } });
        src.stream.pipe(proc.stdin);

        const S = this.voice.StreamType;
        cur.resource = this.voice.createAudioResource(proc.stdout, { inputType: ogg ? S.OggOpus : S.Raw, metadata: item });
        this.current = cur;
        if (!this.ttsBusy) this.userPaused = false; // a new track starts playing
        this.musicPlayer.play(cur.resource);
        if (this.ttsBusy) {
            this.heldByTts = true;
            this.pausedAt = this.clock.now();
        }
        this._updateIdle();
        this.emit('update');
    }

    _restartCurrent(seekSeconds) {
        const cur = this.current;
        if (!cur) return;
        this._killCurrent();
        this.musicPlayer.stop(true);
        return this._startItem(cur.item, seekSeconds);
    }

    _onMusicState(o, n) {
        const S = this.voice.AudioPlayerStatus;
        if (n.status === S.Playing && (this.userPaused || this.heldByTts)) {
            // started (after buffering) while it should be held
            this.musicPlayer.pause(true);
            return;
        }
        if (n.status === S.Idle && o.status !== S.Idle) this._onMusicEnd(o.resource);
    }

    async _onMusicEnd(resource) {
        const cur = this.current;
        if (!cur || this.destroyed || cur.stopping || cur.loading || !cur.resource) return;
        if (resource && resource !== cur.resource) return; // Idle of an older resource
        // wait (max 1.5 s) for ffmpeg's exit code: 0 = the file really ended
        for (let i = 0; i < 15 && cur.exitCode === undefined; i++) await new Promise(r => this.clock.setTimeout(r, 100));
        if (this.current !== cur || cur.stopping || this.destroyed) return;
        const playedS = cur.offset + ((cur.resource && cur.resource.playbackDuration) || 0) / 1000;
        this._killCurrent();

        if (cur.item.live) {
            // a live stream never "ends" - reconnect a few times (counter resets after 60 s of good play)
            if (this.clock.now() - (cur.startedAt || 0) > 60000) cur.item.retries = 0;
            if (cur.item.retries < LIVE_MAX_RETRIES) {
                cur.item.retries++;
                this._log('live stream dropped, reconnecting (' + cur.item.retries + ')');
                await new Promise(r => this.clock.setTimeout(r, 2000));
                if (this.current !== cur || this.destroyed) return;
                return this._startItem(cur.item, 0);
            }
            this._notice(`⚠️ **${cur.item.title}** stopped and could not reconnect.`);
        } else if (cur.exitCode !== 0 && cur.item.retries < 1 && playedS > 5) {
            cur.item.retries++;
            this._log('file stream broke at ' + Math.floor(playedS) + ' s, reopening there');
            return this._startItem(cur.item, playedS);
        }
        return this._playNext();
    }

    // ---------------- controls ----------------
    /** @returns {'speech'|'music'|null} */
    skip() {
        if (this.ttsBusy) {
            this.ttsPlayer.stop(true);
            return 'speech';
        }
        if (this.current) {
            this._playNext();
            return 'music';
        }
        return null;
    }

    clear() {
        const n = { music: this.musicQueue.length, speech: this.ttsQueue.length };
        this.musicQueue = [];
        this.ttsQueue = [];
        this._updateIdle();
        this.emit('update');
        return n;
    }

    /** @returns {'paused'|'resumed'|null} */
    togglePause() {
        if (!this.current) return null;
        if (this.userPaused) {
            this.userPaused = false;
            if (!this.ttsBusy) this._continueMusic();
            this._updateIdle();
            this.emit('update');
            return 'resumed';
        }
        this.userPaused = true;
        if (!this.ttsBusy) this.musicPlayer.pause(true);
        if (!this.pausedAt) this.pausedAt = this.clock.now();
        this._updateIdle();
        this.emit('update');
        return 'paused';
    }

    // ---------------- auto-leave ----------------
    isActive() {
        return !!(this.ttsBusy || this.ttsQueue.length || (this.current && !this.userPaused));
    }

    _updateIdle() {
        if (this.destroyed) return;
        if (this.isActive()) {
            if (this.idleTimer) this.clock.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        } else if (!this.idleTimer) {
            this.idleTimer = this.clock.setTimeout(() => this.destroy('idle'), IDLE_MS);
        }
    }

    /** Called from voiceStateUpdate with the number of non-bot members in Pingway's channel. */
    setHumanCount(n) {
        if (this.destroyed) return;
        if (n > 0) {
            if (this.aloneTimer) this.clock.clearTimeout(this.aloneTimer);
            this.aloneTimer = null;
        } else if (!this.aloneTimer) {
            this.aloneTimer = this.clock.setTimeout(() => this.destroy('alone'), ALONE_MS);
        }
    }

    destroy(reason = 'leave') {
        if (this.destroyed) return;
        this.destroyed = true;
        this.playToken++;
        this._log('leaving (' + reason + ')');
        if (this.aloneTimer) this.clock.clearTimeout(this.aloneTimer);
        if (this.idleTimer) this.clock.clearTimeout(this.idleTimer);
        this.aloneTimer = this.idleTimer = null;
        this._killCurrent();
        this.current = null;
        this.musicQueue = [];
        this.ttsQueue = [];
        try { this.musicPlayer.stop(true); } catch { /* ignore */ }
        try { this.ttsPlayer.stop(true); } catch { /* ignore */ }
        try {
            if (this.connection.state.status !== this.voice.VoiceConnectionStatus.Destroyed) this.connection.destroy();
        } catch { /* ignore */ }
        this.emit('destroyed', reason);
        this.removeAllListeners('update');
    }
}

function safeHost(u) {
    try {
        return new URL(u).hostname;
    } catch {
        return 'Audio link';
    }
}

// ---------------- manager ----------------
const sessions = new Map();

function getSession(guildId) {
    const s = sessions.get(guildId);
    return s && !s.destroyed ? s : null;
}

/**
 * Joins (or moves to) a voice channel and returns the session.
 * @param {{ guild, channel, voice, deps, timeoutMs? }} o
 */
async function joinChannel({ guild, channel, voice, deps, timeoutMs = 20000 }) {
    const existing = getSession(guild.id);
    const connection = voice.joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true, // we never receive audio
        selfMute: false
    });
    if (existing) {
        existing.channelId = channel.id;
        return existing;
    }
    try {
        await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, timeoutMs);
    } catch (err) {
        try { connection.destroy(); } catch { /* ignore */ }
        throw new Error('voice connection timed out');
    }
    const session = new VoiceSession({ guildId: guild.id, channelId: channel.id, voice, connection, deps });
    sessions.set(guild.id, session);
    session.once('destroyed', () => {
        if (sessions.get(guild.id) === session) sessions.delete(guild.id);
    });

    connection.on('stateChange', async (_o, n) => {
        if (session.destroyed) return;
        const C = voice.VoiceConnectionStatus;
        if (n.status === C.Destroyed) return session.destroy('connection destroyed');
        if (n.status === C.Disconnected) {
            try {
                // moved by a moderator / short network blip: it reconnects by itself
                await Promise.race([
                    voice.entersState(connection, C.Signalling, 5000),
                    voice.entersState(connection, C.Connecting, 5000)
                ]);
            } catch {
                session.destroy('disconnected');
            }
        }
    });
    return session;
}

function destroySession(guildId, reason) {
    const s = sessions.get(guildId);
    if (s) s.destroy(reason);
    sessions.delete(guildId);
}

function destroyAll(reason) {
    for (const id of [...sessions.keys()]) destroySession(id, reason);
}

module.exports = {
    TTS_QUEUE_MAX, MUSIC_QUEUE_MAX, ALONE_MS, IDLE_MS, LIVE_RESYNC_MS,
    VoiceSession, sessions, getSession, joinChannel, destroySession, destroyAll
};
