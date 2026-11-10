// Dev page commands (website: pingway.app/dev.html -> api/dev.js -> command_queue table).
// Every ~5 seconds the bot takes the waiting rows and runs the SAME console command code as the Cybrancee console
// (mybot.js handleConsoleLine), so nothing is copied: the console output of that one command is captured and written back
// as the result. For commands that change something, a read-only "before" and "after" view is captured too and saved in the
// audit row (dev_audit) the website wrote when the command was asked for.
//
// Only the commands in COMMANDS can run (the website checks them too; here they are checked again).
// "dev add / remove" and "staff add / remove" are NOT possible from here: they stay console-only.
// Rows the bot did not pick up within 10 minutes (e.g. the bot was offline) are marked "expired" and never run later.

const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');
const { createDevTables } = require('./devDdl');

const POLL_MS = 5000;
const EXPIRE_MS = 10 * 60 * 1000;
const RESULT_MAX = 60000;
const ID_RE = /^\d{15,22}$/;
const ANSI = /\x1b\[[0-9;]*m/g;

// ---------- capture the console output of one command (only its own async chain) ----------
const als = new AsyncLocalStorage();
// Wraps console.log / info / warn / error once (wrapped again if something replaced them later); everything still prints as before
function installCapture() {
    for (const m of ['log', 'info', 'warn', 'error']) {
        if (console[m] && console[m].__pwCapture) continue;
        const original = console[m].bind(console);
        const wrapped = (...args) => {
            const buf = als.getStore();
            if (buf) {
                try { buf.push(util.format(...args)); } catch (e) { /* ignore */ }
            }
            original(...args);
        };
        wrapped.__pwCapture = true;
        console[m] = wrapped;
    }
}
async function capture(fn) {
    installCapture();
    const buf = [];
    await als.run(buf, fn);
    return buf.join('\n').replace(ANSI, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- allowed commands -> the console line they run ----------
const posInt = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;
const COMMANDS = {
    points_view: a => ID_RE.test(a.id) ? 'points ' + a.id : null,
    points_add: a => ID_RE.test(a.id) && posInt(a.amount, 100000) ? 'points add ' + a.id + ' ' + a.amount : null,
    points_remove: a => ID_RE.test(a.id) && posInt(a.amount, 1000000) ? 'points remove ' + a.id + ' ' + a.amount : null,
    kofi_view: a => ID_RE.test(a.id) ? 'kofi ' + a.id : null,
    kofi_give: a => ID_RE.test(a.id) && posInt(a.credits, 1000000) ? 'kofi give ' + a.id + ' ' + a.credits : null,
    kofi_remove: a => ID_RE.test(a.id) && posInt(a.credits, 1000000) ? 'kofi remove ' + a.id + ' ' + a.credits : null,
    kofi_member: a => !ID_RE.test(a.id) ? null : a.off === true ? 'kofi member ' + a.id + ' off' : posInt(a.days, 3650) ? 'kofi member ' + a.id + ' ' + a.days : null,
    tts_view: () => 'tts',
    tts_google: a => typeof a.on === 'boolean' ? 'tts google ' + (a.on ? 'on' : 'off') : null,
    maintenance: a => typeof a.on === 'boolean' ? 'maintenance' : null, // a switch: only run when the state is different (see runOne)
    status: () => 'status',
    whois: a => ID_RE.test(a.id) ? 'whois ' + a.id : null,
    server_list: () => 'server list',
    retainers: a => ID_RE.test(a.id) ? 'retainers ' + a.id : null,
    trivia_view: a => ID_RE.test(a.id) ? 'trivia ' + a.id : null,
    trivia_reset: a => ID_RE.test(a.id) && (a.mode === 'today' || a.mode === 'purge') ? 'trivia reset ' + a.id + ' ' + a.mode : null,
    trivia_confirm: () => 'trivia reset confirm',
    reviews: a => (a.all === true ? 'reviews all' : 'reviews')
};
// Read-only views captured before and after a change (audit log)
const SNAPSHOT = {
    points_add: a => 'points ' + a.id, points_remove: a => 'points ' + a.id,
    kofi_give: a => 'kofi ' + a.id, kofi_remove: a => 'kofi ' + a.id, kofi_member: a => 'kofi ' + a.id,
    tts_google: () => 'tts', maintenance: () => 'status'
};

/** action + args -> console line, or null if not allowed / bad args */
function toConsoleLine(action, args) {
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, action)) return null;
    try { return COMMANDS[action](args && typeof args === 'object' ? args : {}); } catch (e) { return null; }
}

const parseArgs = s => { try { const a = JSON.parse(s || '{}'); return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; } catch (e) { return {}; } };
const clip = s => (s.length > RESULT_MAX ? s.slice(0, RESULT_MAX - 20) + '\n… (cut)' : s);

/**
 * Runs one claimed row. deps: { runLine(line), isMaintenanceOn(), exportAuditSheet(pool, sheetId) }
 * -> { state: 'done'|'error', result, before?, after? }
 */
async function runOne(row, deps, pool) {
    const args = parseArgs(row.args);
    if (row.action === 'audit_sheet') {
        if (!/^[a-zA-Z0-9-_]{20,100}$/.test(String(args.sheetId || ''))) return { state: 'error', result: 'Invalid Google Sheet id.' };
        try {
            const n = await deps.exportAuditSheet(pool, args.sheetId);
            return { state: 'done', result: 'Exported ' + n + ' audit row(s) to the Google Sheet (tab "Pingway audit log").' };
        } catch (err) {
            return { state: 'error', result: 'Google Sheet export failed: ' + String(err && err.message || err).slice(0, 300) +
                '\nShare the sheet with Pingway\'s Google robot (editor) and try again.' };
        }
    }
    const line = toConsoleLine(row.action, args);
    if (!line) return { state: 'error', result: 'This command is not allowed or its values are invalid.' };
    const snap = SNAPSHOT[row.action] ? SNAPSHOT[row.action](args) : null;
    const before = snap ? await capture(() => deps.runLine(snap)) : null;
    let result;
    if (row.action === 'maintenance' && deps.isMaintenanceOn() === args.on) {
        result = 'Maintenance mode is already ' + (args.on ? 'ON' : 'OFF') + '. Nothing changed.';
    } else {
        result = await capture(() => deps.runLine(line));
    }
    const after = snap ? await capture(() => deps.runLine(snap)) : null;
    return { state: 'done', result: clip(result || '(no output)'), before, after };
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

module.exports = { POLL_MS, EXPIRE_MS, COMMANDS, SNAPSHOT, toConsoleLine, capture, installCapture, runOne, tick, start, stop };
