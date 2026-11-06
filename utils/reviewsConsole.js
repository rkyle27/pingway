// Console command "reviews" (read only): website reviews of Pingway.
//   reviews      -> how many, average stars, and the latest 10
//   reviews all  -> every review, read from the database 20 at a time
// The table `reviews` is created by the website; until then this just says it does not exist yet.
// Never prints user_id.
const PAGE = 20;
const COLS = 'id, stars, text, name, name_random, lang, approved, created_at';

function stars(n) {
    const s = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return '★'.repeat(s) + '☆'.repeat(5 - s);
}

function toDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number' || /^\d+$/.test(String(v))) {
        const n = Number(v);
        const d = new Date(n < 1e12 ? n * 1000 : n); // seconds or milliseconds
        return isNaN(d) ? null : d;
    }
    const d = new Date(v);
    return isNaN(d) ? null : d;
}

function fmtDate(v) {
    const d = toDate(v);
    if (!d) return '????-??-?? ??:??';
    return d.toISOString().slice(0, 16).replace('T', ' ');
}

function displayName(r) {
    const nr = r.name_random;
    const name = (r.name == null ? '' : String(r.name)).trim();
    // name_random: a flag (1/0) on the website, or the random name itself
    if (typeof nr === 'string' && nr.trim() && !/^[01]$/.test(nr.trim())) return name || nr.trim();
    const random = nr === true || nr === 1 || nr === '1';
    return (name || '(no name)') + (random ? ' (random name)' : '');
}

function formatReview(r) {
    const text = (r.text == null ? '' : String(r.text)).replace(/\s+/g, ' ').trim();
    const status = (r.approved === 0 || r.approved === false || r.approved === '0') ? ' [not approved]' : '';
    return '  #' + r.id + ' | ' + fmtDate(r.created_at) + ' UTC | ' + stars(r.stars) + ' | ' + displayName(r) +
        ' | ' + (r.lang || '-') + status + '\n      ' + (text || '(no text)');
}

async function reviewsConsole(args, { pool, log = console.log } = {}) {
    if (!pool) pool = require('./db').pool;
    const all = (args[0] || '').toLowerCase() === 'all';
    try {
        const [[sum]] = await pool.execute('SELECT COUNT(*) AS n, AVG(stars) AS avg FROM reviews');
        const total = Number(sum && sum.n) || 0;
        const avg = sum && sum.avg != null ? Number(sum.avg) : 0;
        log('\n⭐ [REVIEWS] ' + total + ' review(s)' + (total ? ' | average ' + avg.toFixed(2) + ' / 5 ' + stars(avg) : ''));
        if (!total) { log(''); return; }
        if (!all) {
            const [rows] = await pool.execute('SELECT ' + COLS + ' FROM reviews ORDER BY created_at DESC, id DESC LIMIT 10');
            log('  Latest ' + rows.length + ':');
            for (const r of rows) log(formatReview(r));
            if (total > rows.length) log('  Type "reviews all" to see all ' + total + '.');
            log('');
            return;
        }
        for (let offset = 0; offset < total; offset += PAGE) {
            const [rows] = await pool.execute('SELECT ' + COLS + ' FROM reviews ORDER BY created_at DESC, id DESC LIMIT ' + PAGE + ' OFFSET ' + offset);
            if (!rows.length) break;
            log('  -- ' + (offset + 1) + '-' + (offset + rows.length) + ' of ' + total + ' --');
            for (const r of rows) log(formatReview(r));
        }
        log('');
    } catch (err) {
        if (err && err.code === 'ER_NO_SUCH_TABLE') log('[REVIEWS] The reviews table does not exist yet (the website creates it with the first review).');
        else log('❌ [REVIEWS] Lookup failed: ' + (err && err.message));
    }
}

module.exports = { reviewsConsole, formatReview, stars, fmtDate };
