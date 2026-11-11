// Website jobs that must run inside the bot (table command_queue, written by the website).
// Every ~5 seconds the bot takes the waiting rows, runs them and writes the result back.
//
// Public job here: 'trivia_share' (website Trivia Share box, any logged-in player: utils/triviaShare.js).
// Every other job is handed to deps.runPrivate(row, args, pool) when the bot has one; without it the row is marked as an
// error ("not available"), so nothing ever runs that the bot does not know.
// Rows the bot did not pick up within 10 minutes (e.g. the bot was offline) are marked "expired" and never run later.

const { createDevTables } = require('./devDdl');

const POLL_MS = 5000;
const EXPIRE_MS = 10 * 60 * 1000;
const RESULT_MAX = 60000;

const parseArgs = s => { try { const a = JSON.parse(s || '{}'); return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; } catch (e) { return {}; } };
const clip = s => (s.length > RESULT_MAX ? s.slice(0, RESULT_MAX - 20) + '\n… (cut)' : s);

/**
 * Runs one claimed row. deps: { triviaShare(userId, args), runPrivate(row, args, pool) }
 * -> { state: 'done'|'error', result, before?, after? }
 */
async function runOne(row, deps, pool) {
    const args = parseArgs(row.args);
    // Website Trivia "Share" box (a normal user): posts the asker's own solve (utils/triviaShare.js).
    // The person is always the row's requested_by (written by the website from the login), never a value from args.
    if (row.action === 'trivia_share') {
        if (!deps.triviaShare) return { state: 'error', result: 'Trivia sharing is not available.' };
        const [[who]] = await pool.execute('SELECT requested_by FROM command_queue WHERE id = ?', [row.id]);
        return deps.triviaShare(who ? String(who.requested_by) : '', args);
    }
    if (typeof deps.runPrivate === 'function') {
        const out = await deps.runPrivate(row, args, pool);
        if (out) return out;
    }
    return { state: 'error', result: 'This command is not available.' };
}

/** Marks old waiting rows as expired, then claims and runs the waiting ones (oldest first). */
async function tick(pool, deps, now = Date.now()) {
    await pool.execute("UPDATE command_queue SET state = 'expired', finished_at = ? WHERE state = 'pending' AND created_at < ?", [now, now - EXPIRE_MS]);
    const [rows] = await pool.execute("SELECT id, action, args, audit_id FROM command_queue WHERE state = 'pending' ORDER BY id LIMIT 5");
    let ran = 0;
    for (const row of rows) {
        const [claim] = await pool.execute("UPDATE command_queue SET state = 'running', started_at = ? WHERE id = ? AND state = 'pending'", [Date.now(), row.id]);
        if (!claim || claim.affectedRows !== 1) continue; // someone else took it
        let out;
        try {
            out = await runOne(row, deps, pool);
        } catch (err) {
            out = { state: 'error', result: 'Failed: ' + String(err && err.message || err).slice(0, 300) };
        }
        await pool.execute('UPDATE command_queue SET state = ?, result = ?, finished_at = ? WHERE id = ?', [out.state, clip(String(out.result || '')), Date.now(), row.id]);
        if (row.audit_id && (out.before || out.after)) {
            await pool.execute('UPDATE dev_audit SET before_val = ?, after_val = ? WHERE id = ?', [out.before ? clip(out.before) : null, out.after ? clip(out.after) : null, row.audit_id]);
        }
        console.log('🛠️ [DEV PAGE] Command #' + row.id + ' (' + row.action + '): ' + out.state);
        ran++;
    }
    return ran;
}

let timer = null;
/** Starts the poller (mybot.js, after the client is ready). */
function start(pool, deps) {
    if (timer) return;
    let busy = false;
    let ready = false;
    timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
            if (!ready) { await createDevTables(pool); ready = true; }
            await tick(pool, deps);
        } catch (err) {
            if (!/ECONNRESET|ETIMEDOUT|PROTOCOL_CONNECTION_LOST/.test(String(err && err.code))) console.error('⚠️ [DEV PAGE] Command queue check failed:', err.message);
        } finally {
            busy = false;
        }
    }, POLL_MS);
    if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { POLL_MS, EXPIRE_MS, RESULT_MAX, parseArgs, clip, runOne, tick, start, stop };
