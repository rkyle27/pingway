// Recurring Party Finder (v2.2): a listing can repeat every week on the days the host picks, at the same time.
// - The host picks the days in the /pf preview ("🔁 Repeat weekly"). They are weekdays in the listing's own time zone
//   (the GMT offset chosen in /pf), the time is the listing's time. Saved in the listing's data:
//   recurring = { days: [0..6] (0 = Sunday), active: true, series: '<id of the first listing>' }
// - When a repeating listing reaches its start time, Pingway posts the NEXT one (the next ticked day after it, same time,
//   same channel, nobody signed up yet). Only one upcoming listing per series exists at a time.
// - No double posts after a restart: the old listing is marked first (recurPosted), a listing of the same series and
//   date is never posted twice, and the new row is saved before its message is sent. If Pingway stops in between, the
//   next one is skipped rather than posted twice.
// - The host stops it with "Stop repeating" (/pf -> Check My PF(s), or the button in the start DM).
// Time zones work like the rest of /pf: a fixed GMT offset (no summer time), e.g. "2026-11-10 21:00 GMT+9".

const { pool: db } = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS_AHEAD = 7 * 520; // safety stop for the search (10 years)
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Clean list of weekdays: unique numbers 0..6, sorted Monday first (1..6, 0). */
function cleanDays(days) {
    if (!Array.isArray(days)) return [];
    const set = new Set();
    for (const d of days) {
        const n = Number(d);
        if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
    }
    return [1, 2, 3, 4, 5, 6, 0].filter(n => set.has(n));
}

/** "2026-11-10 21:00 GMT+9" -> { ms, offset, suffix } (offset in hours), or null. Same rules as commands/pf.js. */
function parseDate(dateStr) {
    if (!dateStr) return null;
    const s = String(dateStr);
    const matchGMT = s.match(/GMT([+-]\d+)/);
    const isJST = s.includes('JST');
    const offset = matchGMT ? parseInt(matchGMT[1], 10) : (isJST ? 9 : 0);
    const suffix = matchGMT ? matchGMT[0] : (isJST ? 'JST' : '');
    const [datePart, timePart] = s.replace(/ (GMT[+-]\d+|JST)/, '').trim().split(' ');
    if (!datePart || !timePart) return null;
    const [y, mo, d] = datePart.split('-').map(Number);
    const [h, mi] = timePart.split(':').map(Number);
    if (![y, mo, d, h, mi].every(Number.isFinite)) return null;
    const ms = Date.UTC(y, mo - 1, d, h, mi) - offset * 3600 * 1000;
    return Number.isFinite(ms) ? { ms, offset, suffix } : null;
}

/** Weekday (0 = Sunday) of a moment, in a fixed GMT offset. */
function weekdayAt(ms, offset) {
    return new Date(ms + offset * 3600 * 1000).getUTCDay();
}

/** The listing's date text for a moment, in the same style and offset ("YYYY-MM-DD HH:MM GMT+9"). */
function formatDate(ms, offset, suffix) {
    const iso = new Date(ms + offset * 3600 * 1000).toISOString();
    return iso.slice(0, 10) + ' ' + iso.slice(11, 16) + (suffix ? ' ' + suffix : '');
}

/**
 * Next run of a weekly listing: the first ticked weekday AFTER the listing's start, same time, and later than `now`
 * (so a bot that was offline for a while skips the runs that are already over). Wraps over the week end.
 * @returns {{ ms, date }|null}
 */
function nextRun(dateStr, days, now = Date.now()) {
    const p = parseDate(dateStr);
    const list = cleanDays(days);
    if (!p || !list.length) return null;
    for (let k = 1; k <= MAX_DAYS_AHEAD; k++) {
        const ms = p.ms + k * DAY_MS;
        if (ms <= now) continue;
        if (list.includes(weekdayAt(ms, p.offset))) return { ms, date: formatDate(ms, p.offset, p.suffix) };
    }
    return null;
}

/** Ticked days as text in the reader's language ("Mon, Thu"). */
function daysText(days, t, lang) {
    return cleanDays(days).map(d => t(lang, 'pf.recur.day.' + DAY_KEYS[d])).join(', ');
}

/** Is this listing an active weekly series? */
function isActive(listing) {
    return !!(listing && listing.recurring && listing.recurring.active && cleanDays(listing.recurring.days).length);
}

let lastId = 0;
function newId(now) {
    lastId = Math.max(Number(now) || Date.now(), lastId + 1);
    return String(lastId);
}

/**
 * Called by the PF scheduler for a listing whose start time has passed. Posts the next listing of the series once.
 * @param row      the database row (row.data = JSON)
 * @param listing  the listing as the scheduler read it (it is changed: recurPosted = true)
 * @returns 'posted' | 'exists' | 'skipped' | 'failed'
 */
async function handleStarted(client, row, listing, now = Date.now()) {
    if (!isActive(listing) || listing.recurPosted) return 'skipped';
    // 1) mark the started listing first: whatever happens next, it never posts its follow-up twice
    listing.recurPosted = true;
    try {
        await db.query('UPDATE party_finders SET data = ? WHERE id = ?', [JSON.stringify(listing), listing.id]);
    } catch (e) {
        listing.recurPosted = false;
        console.error('❌ [PF REPEAT] Could not mark listing ' + listing.id + ':', e.message);
        return 'failed';
    }

    const next = nextRun(listing.date, listing.recurring.days, now);
    if (!next) return 'skipped';
    const series = String(listing.recurring.series || listing.id);

    // 2) never two listings of the same series on the same date (e.g. a second bot process)
    try {
        const [rows] = await db.query('SELECT * FROM party_finders');
        const exists = (rows || []).some(r => {
            if (!r.data) return false;
            let d;
            try { d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data; } catch (e) { return false; }
            return d && d.recurring && String(d.recurring.series) === series && d.date === next.date;
        });
        if (exists) return 'exists';
    } catch (e) {
        console.error('❌ [PF REPEAT] Could not check listings:', e.message);
        return 'failed';
    }

    const pf = require('../commands/pf'); // lazy: commands/pf.js loads this file's neighbour (pfScheduler) itself
    const channel = listing.channelId ? await client.channels.fetch(String(listing.channelId)).catch(() => null) : null;
    if (!channel || !channel.isTextBased()) {
        console.log('🔁 [PF REPEAT] Channel of series ' + series + ' is gone: the weekly listing stops.');
        return 'failed';
    }

    const fresh = {
        id: newId(now),
        userId: String(listing.userId),
        guildId: String(listing.guildId),
        channelId: channel.id,
        name: listing.name,
        size: listing.size,
        tanks: listing.tanks ?? 0,
        healers: listing.healers ?? 0,
        dps: listing.dps ?? 0,
        meleedps: listing.meleedps ?? 0,
        range: listing.range ?? 0,
        caster: listing.caster ?? 0,
        date: next.date,
        imageUrl: listing.imageUrl || null,
        claims: { tanks: [], healers: [], dps: [], meleedps: [], range: [], caster: [], other: [], reserves: [] },
        messageId: null,
        status: 'active',
        notified30Min: false,
        notifiedExact: false,
        recurring: { days: cleanDays(listing.recurring.days), active: true, series },
        mount: listing.mount || null // Mount farm: the next week farms the same mount
    };

    // 3) save the row first (no message yet), then post, then save the message id
    await pf.saveListingToDB(fresh);
    try {
        const lang = require('./userLanguage').forGuild(channel.guild);
        const { embed, components } = await pf.buildPFEmbedAndRows(fresh, channel.guild, '<@' + fresh.userId + '>');
        const sent = await channel.send({ content: require('./i18n').t(lang, 'pf.recur.posted'), embeds: [embed], components });
        fresh.messageId = sent.id;
        await pf.saveListingToDB(fresh);
        console.log('🔁 [PF REPEAT] Posted the next "' + fresh.name + '" (' + fresh.date + ') in #' + (channel.name || channel.id) + '.');
        return 'posted';
    } catch (e) {
        // could not post (missing permissions ...): remove the empty row, the series stops here
        await db.query('DELETE FROM party_finders WHERE id = ?', [fresh.id]).catch(() => {});
        console.error('❌ [PF REPEAT] Could not post the next listing of series ' + series + ':', e.message);
        return 'failed';
    }
}

/** Stops a series: every listing of it is no longer repeated. Only the host. @returns number of listings changed */
async function stopSeries(listings, series, userId) {
    let n = 0;
    for (const l of listings) {
        if (!l.recurring || String(l.recurring.series) !== String(series) || String(l.userId) !== String(userId)) continue;
        if (!l.recurring.active) continue;
        l.recurring = { ...l.recurring, active: false };
        await require('../commands/pf').saveListingToDB(l);
        n++;
    }
    return n;
}

module.exports = { DAY_KEYS, cleanDays, parseDate, weekdayAt, formatDate, nextRun, daysText, isActive, handleStarted, stopSeries };
