// Encrypted database line for the website.
// The website (Vercel) does not talk to the database itself: it sends each query here, the bot runs it on its own
// pool (utils/db.js) and sends the answer back. Every request and answer is encrypted and signed (AES-256-GCM) with keys
// made from DBLINK_SECRET, and old or repeated requests are refused. Started from mybot.js only when DBLINK_PORT and
// DBLINK_SECRET are set in .env. Nothing here logs request bodies, SQL, parameters or the secret.
'use strict';

const http = require('node:http');

// ===== envelope: keep this block identical in pingway/utils/dbLink.js and pingway-dashboard/lib/dbLink.js =====
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_SKEW_MS = 60 * 1000;            // a request older / newer than this is refused
const SECRET_RE = /^[A-Za-z0-9_-]{43,}$/;  // base64url, at least 32 bytes
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TO_BOT = 'site->bot';
const TO_SITE = 'bot->site';

/** DBLINK_SECRET -> one key per direction (HKDF-SHA256). Throws on a missing / too short secret. */
function deriveKeys(secret) {
    const s = String(secret || '').trim();
    if (!SECRET_RE.test(s)) throw new Error('DBLINK_SECRET must be at least 43 base64url characters.');
    const ikm = Buffer.from(s, 'base64url');
    const salt = Buffer.from('pingway-dblink-v1', 'utf8');
    const key = dir => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('aes-256-gcm ' + dir, 'utf8'), 32));
    return { [TO_BOT]: key(TO_BOT), [TO_SITE]: key(TO_SITE) };
}

function aadOf(dir, ts, nonce) {
    return Buffer.from('pingway-dblink|v' + VERSION + '|' + dir + '|' + ts + '|' + nonce, 'utf8');
}

// Values JSON can't carry are tagged: Buffer, Date, BigInt, undefined, NaN / Infinity, and mysql2's ResultSetHeader.
// A plain object that has its own "$t" key is wrapped too, so it can never be mistaken for a tag.
function encode(v) {
    if (v === null) return null;
    if (v === undefined) return { $t: 'u' };
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') return Number.isFinite(v) ? v : { $t: 'n', v: String(v) };
    if (t === 'bigint') return { $t: 'b', v: v.toString() };
    if (t !== 'object') return null;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $t: 'buf', v: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
    if (v instanceof Date) { const ms = v.getTime(); return { $t: 'd', v: Number.isNaN(ms) ? null : ms }; }
    if (Array.isArray(v)) return v.map(encode);
    const out = {};
    for (const k of Object.keys(v)) out[k] = encode(v[k]);
    if (v.constructor && v.constructor.name === 'ResultSetHeader') return { $t: 'rsh', v: out };
    return Object.prototype.hasOwnProperty.call(v, '$t') ? { $t: 'o', v: out } : out;
}

function decodeObject(o) {
    const out = {};
    for (const k of Object.keys(o)) {
        const val = decode(o[k]);
        if (k === '__proto__') Object.defineProperty(out, k, { value: val, enumerable: true, writable: true, configurable: true });
        else out[k] = val;
    }
    return out;
}

function decode(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(decode);
    if (typeof v.$t === 'string') {
        switch (v.$t) {
            case 'u': return undefined;
            case 'n': return Number(v.v);
            case 'b': return BigInt(v.v);
            case 'buf': return Buffer.from(String(v.v), 'base64');
            case 'd': return new Date(v.v === null ? NaN : Number(v.v));
            case 'o': case 'rsh': return decodeObject(v.v || {});
        }
    }
    return decodeObject(v);
}

/** Encrypts obj for one direction -> envelope {v, ts, nonce, iv, ct, tag}. A reply passes the request's nonce. */
function seal(keys, dir, obj, nonce) {
    const ts = Date.now();
    const n = nonce || crypto.randomBytes(18).toString('base64url');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', keys[dir], iv);
    c.setAAD(aadOf(dir, ts, n));
    const ct = Buffer.concat([c.update(JSON.stringify(encode(obj)), 'utf8'), c.final()]);
    return { v: VERSION, ts, nonce: n, iv: iv.toString('base64url'), ct: ct.toString('base64url'), tag: c.getAuthTag().toString('base64url') };
}

/** Envelope -> { ts, nonce, body }, or null for anything wrong (wrong key, changed bytes, too old, bad shape). */
function open(keys, dir, env, now) {
    if (!env || typeof env !== 'object' || env.v !== VERSION) return null;
    const { ts, nonce, iv, ct, tag } = env;
    if (!Number.isSafeInteger(ts) || typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
    if (typeof iv !== 'string' || typeof ct !== 'string' || typeof tag !== 'string') return null;
    if (!B64URL_RE.test(iv) || !B64URL_RE.test(tag) || (ct !== '' && !B64URL_RE.test(ct))) return null;
    if (Math.abs((now === undefined ? Date.now() : now) - ts) > MAX_SKEW_MS) return null;
    const ivBuf = Buffer.from(iv, 'base64url'), tagBuf = Buffer.from(tag, 'base64url');
    if (ivBuf.length !== 12 || tagBuf.length !== 16) return null;
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', keys[dir], ivBuf);
        d.setAAD(aadOf(dir, ts, nonce));
        d.setAuthTag(tagBuf);
        const pt = Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
        return { ts, nonce, body: decode(JSON.parse(pt.toString('utf8'))) };
    } catch (e) {
        return null;
    }
}

/** Constant-time string compare. */
function sameText(a, b) {
    const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// ===== end of envelope =====

const BODY_MAX = 4 * 1024 * 1024;
const NONCE_KEEP_MS = 3 * 60 * 1000;
const BAD_WINDOW_MS = 5 * 60 * 1000;      // bad requests counted over this time...
const BAD_LIMIT = 20;                     // ...this many from one IP -> paused
const PAUSE_MS = 5 * 60 * 1000;
const LEASE_IDLE_MS = 30 * 1000;          // a website connection left unused this long (function died mid-transaction) is rolled back and given back

const FIELD_KEYS = ['name', 'table', 'orgTable', 'orgName', 'db', 'schema', 'columnType', 'type', 'columnLength', 'characterSet', 'encoding', 'flags', 'decimals'];
function fieldsLite(fields) {
    if (!Array.isArray(fields)) return undefined;
    return fields.map(f => {
        const o = {};
        for (const k of FIELD_KEYS) {
            try { if (f && f[k] !== undefined) o[k] = f[k]; } catch (e) { /* lazy getter failed: skip */ }
        }
        return o;
    });
}

function errorOf(err) {
    const e = err || {};
    const out = { message: String(e.message || 'Database error') };
    for (const k of ['code', 'errno', 'sqlState', 'sqlMessage', 'fatal']) if (e[k] !== undefined) out[k] = e[k];
    if (e.name && e.name !== 'Error') out.name = String(e.name);
    return out;
}

/**
 * The receiver. opts: { secret, pool, log?, now? } -> http.Server (not listening yet).
 * pool: a mysql2/promise pool (execute, query, getConnection).
 */
function createServer(opts) {
    const keys = deriveKeys(opts.secret);
    const pool = opts.pool;
    const log = opts.log || (msg => console.log(msg));
    const now = opts.now || (() => Date.now());

    const seen = new Map();     // nonce -> time first seen
    const bad = new Map();      // ip -> { times: [], pausedUntil }
    const leases = new Map();   // id -> { conn, timer, busy }

    const sweep = setInterval(() => {
        const t = now();
        for (const [n, at] of seen) if (t - at > NONCE_KEEP_MS) seen.delete(n);
        for (const [ip, b] of bad) if (b.pausedUntil < t && (!b.times.length || t - b.times[b.times.length - 1] > BAD_WINDOW_MS)) bad.delete(ip);
    }, 30 * 1000);
    sweep.unref();

    function isPaused(ip) {
        const b = bad.get(ip);
        return !!b && b.pausedUntil > now();
    }
    function markBad(ip) {
        const t = now();
        const b = bad.get(ip) || { times: [], pausedUntil: 0 };
        b.times = b.times.filter(x => t - x <= BAD_WINDOW_MS);
        b.times.push(t);
        if (b.times.length >= BAD_LIMIT && b.pausedUntil <= t) {
            b.pausedUntil = t + PAUSE_MS;
            b.times = [];
            log('⚠️ [DB LINK] Paused ' + ip + ' for ' + (PAUSE_MS / 60000) + ' min after repeated bad requests.');
        }
        bad.set(ip, b);
    }

    // ---- website connections (transactions) ----
    function armLease(id) {
        const l = leases.get(id);
        if (!l) return;
        clearTimeout(l.timer);
        l.timer = setTimeout(() => {
            if (!leases.has(id) || l.busy) return;
            leases.delete(id);
            Promise.resolve().then(() => l.conn.rollback()).catch(() => {}).then(() => { try { l.conn.release(); } catch (e) { /* gone */ } });
            log('⚠️ [DB LINK] Closed a website connection that was left open (rolled back).');
        }, LEASE_IDLE_MS);
        if (l.timer.unref) l.timer.unref();
    }
    async function leaseFor(conn) {
        if (conn === 'new') {
            const c = await pool.getConnection();
            const id = crypto.randomBytes(18).toString('base64url');
            leases.set(id, { conn: c, timer: null, busy: false });
            return id;
        }
        if (typeof conn === 'string' && leases.has(conn)) return conn;
        const e = new Error('The database connection was closed.');
        e.code = 'DBLINK_NO_CONNECTION';
        throw e;
    }

    async function run(p) {
        if (!p || typeof p !== 'object') return { error: { message: 'Bad request.' } };
        const op = p.op;
        if (op === 'release') {
            const l = typeof p.conn === 'string' ? leases.get(p.conn) : null;
            if (l) { leases.delete(p.conn); clearTimeout(l.timer); try { l.conn.release(); } catch (e) { /* gone */ } }
            return { ok: true };
        }
        if (!['execute', 'query', 'begin', 'commit', 'rollback'].includes(op)) return { error: { message: 'Unknown operation.' } };
        if ((op === 'execute' || op === 'query') && typeof p.sql !== 'string') return { error: { message: 'Missing SQL.' } };

        let id = null;
        try {
            if (p.conn !== undefined && p.conn !== null) id = await leaseFor(p.conn);
        } catch (err) {
            return { error: errorOf(err) };
        }
        if (!id && op !== 'execute' && op !== 'query') return { error: { message: 'No connection.' } };
        const l = id ? leases.get(id) : null;
        const target = l ? l.conn : pool;
        if (l) { l.busy = true; clearTimeout(l.timer); }
        try {
            if (op === 'begin') { await target.beginTransaction(); return { ok: true, conn: id }; }
            if (op === 'commit') { await target.commit(); return { ok: true, conn: id }; }
            if (op === 'rollback') { await target.rollback(); return { ok: true, conn: id }; }
            const args = p.params === undefined ? [p.sql] : [p.sql, p.params];
            const [rows, fields] = await target[op](...args);
            const out = { ok: true, rows, fields: fieldsLite(fields) };
            if (rows && !Array.isArray(rows)) { out.affectedRows = rows.affectedRows; out.insertId = rows.insertId; }
            if (id) out.conn = id;
            return out;
        } catch (err) {
            const out = { error: errorOf(err) };
            if (id) out.conn = id;
            return out;
        } finally {
            if (l) { l.busy = false; armLease(id); }
        }
    }

    function notFound(req, res, close) {
        if (res.headersSent) return;
        res.writeHead(404, { 'Content-Length': '0', ...(close ? { Connection: 'close' } : {}) });
        res.end();
        if (close) req.destroy();
    }

    const server = http.createServer((req, res) => {
        const ip = req.socket.remoteAddress || '?';
        res.setTimeout(20 * 1000, () => { try { res.destroy(); } catch (e) { /* closed */ } });
        if (isPaused(ip)) return notFound(req, res, true);
        if (req.method !== 'POST' || req.url !== '/q') { markBad(ip); req.resume(); return notFound(req, res, false); }
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > BODY_MAX) { markBad(ip); return notFound(req, res, true); }

        const chunks = [];
        let size = 0, over = false;
        req.on('data', c => {
            if (over) return;
            size += c.length;
            if (size > BODY_MAX) { over = true; markBad(ip); notFound(req, res, true); return; }
            chunks.push(c);
        });
        req.on('error', () => { /* client went away */ });
        req.on('end', async () => {
            if (over) return;
            let env = null;
            try { env = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { env = null; }
            const opened = open(keys, TO_BOT, env, now());
            if (!opened || seen.has(opened.nonce)) { markBad(ip); return notFound(req, res, false); }
            seen.set(opened.nonce, now());
            let answer;
            try { answer = await run(opened.body); } catch (err) { answer = { error: { message: 'Database line error.' } }; }
            if (res.destroyed || res.writableEnded) return;
            const body = JSON.stringify(seal(keys, TO_SITE, answer, opened.nonce));
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
            res.end(body);
        });
    });
    server.requestTimeout = 15 * 1000;
    server.headersTimeout = 10 * 1000;
    server.keepAliveTimeout = 10 * 1000;
    server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) { /* closed */ } });
    server.on('close', () => {
        clearInterval(sweep);
        for (const [id, l] of leases) { clearTimeout(l.timer); leases.delete(id); Promise.resolve().then(() => l.conn.rollback()).catch(() => {}).then(() => { try { l.conn.release(); } catch (e) { /* gone */ } }); }
    });
    server.dbLink = { seen, bad, leases };
    return server;
}

/** From mybot.js: starts only when DBLINK_PORT and DBLINK_SECRET are set. */
function start() {
    const port = process.env.DBLINK_PORT, secret = process.env.DBLINK_SECRET;
    if (!port || !secret) return null;
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) { console.error('❌ [DB LINK] Not started: DBLINK_PORT is not a valid port.'); return null; }
    let server;
    try {
        deriveKeys(secret); // refuse a short secret before touching the database
        server = createServer({ secret, pool: require('./db').pool });
    } catch (err) {
        console.error('❌ [DB LINK] Not started: ' + err.message);
        return null;
    }
    server.on('error', err => console.error('❌ [DB LINK] Server error:', err.code || '', err.message || ''));
    server.listen(p, '0.0.0.0', () => console.log('🔐 [DB LINK] DB link listening on port ' + p));
    return server;
}

module.exports = { start, createServer, deriveKeys, seal, open, encode, decode, sameText, TO_BOT, TO_SITE, BODY_MAX, MAX_SKEW_MS };
