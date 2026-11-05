// Google TTS safety counter + "use the backup voice until Google's quota resets" switch.
// Google's daily quotas reset at midnight Pacific time (America/Los_Angeles), so the day key is the
// Pacific date. Characters sent to Google are counted in memory and saved in the voice_usage table
// (so a restart does not reset them). Over GOOGLE_TTS_DAILY_CHARS (default 120000; 0 = never use Google)
// or after a quota / billing / permission error from Google -> backup voice (eSpeak) for the rest of that day.

const DEFAULT_DAILY_CHARS = 120000;
const FLUSH_MS = 10000;

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'YYYY-MM-DD' in America/Los_Angeles (DST handled by Intl). */
function pacificDay(ms = Date.now()) {
    return dayFmt.format(new Date(ms));
}

function dailyLimit() {
    const raw = process.env.GOOGLE_TTS_DAILY_CHARS;
    if (raw === undefined || String(raw).trim() === '') return DEFAULT_DAILY_CHARS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_CHARS;
}

function createUsage({ store, clock = { now: () => Date.now(), setTimeout, clearTimeout }, limit = dailyLimit } = {}) {
    const s = { day: null, chars: 0, blocked: null, loaded: null, flushTimer: null };

    function rollover(now) {
        const d = pacificDay(now);
        if (d === s.day) return;
        if (s.flushTimer) {
            clock.clearTimeout(s.flushTimer);
            s.flushTimer = null;
            flush(s.day, s.chars, !!s.blocked); // save the old day's last numbers
        }
        s.day = d;
        s.chars = 0;
        s.blocked = null;
        s.loaded = null;
    }

    async function loadDay() {
        if (!s.loaded) {
            const day = s.day;
            s.loaded = (async () => {
                try {
                    const row = await store.getUsage(day);
                    if (s.day !== day) return;
                    s.chars = Math.max(s.chars, row.chars);
                    if (row.blocked && !s.blocked) s.blocked = 'quota';
                } catch (err) {
                    console.error('⚠️ [VC] voice_usage read failed:', err.code || err.message);
                }
            })();
        }
        return s.loaded;
    }

    function flush(day, chars, blocked) {
        Promise.resolve()
            .then(() => store.saveUsage(day, chars, blocked))
            .catch(err => console.error('⚠️ [VC] voice_usage save failed:', err.code || err.message));
    }

    function scheduleFlush(now) {
        if (s.flushTimer) return;
        s.flushTimer = clock.setTimeout(() => {
            s.flushTimer = null;
            flush(s.day, s.chars, !!s.blocked);
        }, FLUSH_MS);
        if (s.flushTimer && typeof s.flushTimer.unref === 'function') s.flushTimer.unref();
    }

    return {
        /** @returns {Promise<{ok: boolean, reason?: 'quota'|'limit'}>} may this text go to Google? */
        async check(chars, now = clock.now()) {
            rollover(now);
            await loadDay();
            rollover(now);
            if (s.blocked) return { ok: false, reason: 'quota' };
            const max = limit();
            if (s.chars + chars > max) return { ok: false, reason: 'limit' };
            return { ok: true };
        },
        /** count characters Google accepted */
        add(chars, now = clock.now()) {
            rollover(now);
            s.chars += chars;
            scheduleFlush(now);
        },
        /** Google refused (quota / billing / permission): backup voice until the Pacific day changes */
        block(reason = 'quota', now = clock.now()) {
            rollover(now);
            if (!s.blocked) console.log(`🔊 [VC] Google TTS paused until midnight Pacific (${reason}); using the backup voice.`);
            s.blocked = reason;
            flush(s.day, s.chars, true);
        },
        /** sync snapshot for the panel: null = Google usable (as far as we know) */
        state(now = clock.now()) {
            if (s.day !== pacificDay(now)) return { day: pacificDay(now), chars: 0, reason: null };
            const reason = s.blocked ? 'quota' : (s.chars >= limit() ? 'limit' : null);
            return { day: s.day, chars: s.chars, reason };
        }
    };
}

let shared = null;
function getUsage() {
    if (!shared) shared = createUsage({ store: require('./store') });
    return shared;
}

module.exports = { DEFAULT_DAILY_CHARS, pacificDay, dailyLimit, createUsage, getUsage };
