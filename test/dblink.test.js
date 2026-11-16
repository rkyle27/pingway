// Website database line (utils/dbLink.js): envelope crypto, replay / age checks, body limit, only POST /q,
// value types, SQL errors, transactions. Plain node with a fake pool (no database):  node --test test/dblink.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('path');

const L = require(path.join(__dirname, '..', 'utils', 'dbLink.js'));

const SECRET = crypto.randomBytes(64).toString('base64url');
const OTHER = crypto.randomBytes(64).toString('base64url');
const KEYS = L.deriveKeys(SECRET);

class ResultSetHeader { constructor(o) { Object.assign(this, { fieldCount: 0, affectedRows: 0, insertId: 0, info: '', serverStatus: 2, warningStatus: 0, changedRows: 0 }, o); } }

function fakePool() {
    const log = [];
    const sqlErr = () => Object.assign(new Error("Unknown column 'nope' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR', errno: 1054, sqlState: '42S22', sqlMessage: "Unknown column 'nope' in 'field list'" });
    async function run(who, kind, sql, params) {
        log.push({ who, kind, sql, params });
        if (sql === 'SELECT types') {
            return [[{ id: 1, pic: Buffer.from([0, 1, 2, 255]), at: new Date('2026-11-16T01:02:03.456Z'), big: 12345678901234567890n, dec: '12.50', none: null, json: { a: [1, 'x'], $t: 'tricky' }, flag: true }],
                [{ name: 'id', columnType: 3, table: 't' }]];
        }
        if (sql === 'ECHO') return [[{ params }], []];
        if (sql.startsWith('INSERT')) return [new ResultSetHeader({ affectedRows: 1, insertId: 42 }), undefined];
        if (sql === 'BAD') throw sqlErr();
        if (sql === 'UNDEF') throw new TypeError('Bind parameters must not contain undefined. To pass SQL NULL specify JS null');
        return [[], []];
    }
    let n = 0;
    const pool = {
        log, released: 0,
        execute: (sql, p) => run('pool', 'execute', sql, p),
        query: (sql, p) => run('pool', 'query', sql, p),
        getConnection: async () => {
            const name = 'conn' + (++n);
            return {
                execute: (sql, p) => run(name, 'execute', sql, p),
                query: (sql, p) => run(name, 'query', sql, p),
                beginTransaction: async () => { log.push({ who: name, kind: 'begin' }); },
                commit: async () => { log.push({ who: name, kind: 'commit' }); },
                rollback: async () => { log.push({ who: name, kind: 'rollback' }); },
                release: () => { pool.released++; log.push({ who: name, kind: 'release' }); }
            };
        }
    };
    return pool;
}

async function withServer(fn, opts) {
    const pool = fakePool();
    const logs = [];
    const server = L.createServer({ secret: SECRET, pool, log: m => logs.push(m), ...(opts || {}) });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try { await fn({ port, pool, server, logs }); } finally { await new Promise(r => server.close(r)); }
}

function raw(port, method, urlPath, body, headers) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { 'Content-Type': 'application/json', ...(headers || {}) } }, res => {
            const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }));
        });
        req.on('error', e => resolve({ status: 0, error: e.code }));
        if (body !== undefined) req.write(body);
        req.end();
    });
}

async function ask(port, payload, keys) {
    const env = L.seal(keys || KEYS, L.TO_BOT, payload);
    const r = await raw(port, 'POST', '/q', JSON.stringify(env));
    if (r.status !== 200) return { status: r.status };
    const opened = L.open(KEYS, L.TO_SITE, JSON.parse(r.text));
    assert.ok(opened, 'reply opens with the bot->site key');
    assert.equal(opened.nonce, env.nonce, 'reply echoes the request nonce');
    return { status: 200, body: opened.body, env };
}

// ---------- envelope ----------
test('secret must be at least 43 base64url characters', () => {
    assert.throws(() => L.deriveKeys(''), /43 base64url/);
    assert.throws(() => L.deriveKeys('a'.repeat(42)), /43 base64url/);
    assert.throws(() => L.deriveKeys('a'.repeat(50) + '+/'), /43 base64url/);
    assert.doesNotThrow(() => L.deriveKeys('a'.repeat(43)));
    assert.throws(() => L.createServer({ secret: 'short', pool: fakePool() }), /43 base64url/);
});

test('each direction has its own key', () => {
    assert.notDeepEqual(KEYS[L.TO_BOT], KEYS[L.TO_SITE]);
    const env = L.seal(KEYS, L.TO_BOT, { op: 'execute', sql: 'SELECT 1' });
    assert.equal(L.open(KEYS, L.TO_SITE, env), null, 'a request cannot be read as a reply');
    assert.deepEqual(L.open(KEYS, L.TO_BOT, env).body, { op: 'execute', sql: 'SELECT 1' });
});

test('round trip, and the ciphertext does not show the SQL', () => {
    const env = L.seal(KEYS, L.TO_BOT, { op: 'execute', sql: 'SELECT secret_column FROM users', params: ['x'] });
    assert.deepEqual(Object.keys(env).sort(), ['ct', 'iv', 'nonce', 'tag', 'ts', 'v']);
    assert.ok(!JSON.stringify(env).includes('secret_column'));
    assert.deepEqual(L.open(KEYS, L.TO_BOT, env).body, { op: 'execute', sql: 'SELECT secret_column FROM users', params: ['x'] });
});

test('tampering is rejected (ct, tag, iv, ts, nonce, v)', () => {
    const env = L.seal(KEYS, L.TO_BOT, { op: 'execute', sql: 'SELECT 1' });
    const flip = s => { const b = Buffer.from(s, 'base64url'); b[0] ^= 1; return b.toString('base64url'); };
    assert.equal(L.open(KEYS, L.TO_BOT, { ...env, ct: flip(env.ct) }), null);
    assert.equal(L.open(KEYS, L.TO_BOT, { ...env, tag: flip(env.tag) }), null);
    assert.equal(L.open(KEYS, L.TO_BOT, { ...env, iv: flip(env.iv) }), null);
    assert.equal(L.open(KEYS, L.TO_BOT, { ...env, ts: env.ts + 1 }), null);
    assert.equal(L.open(KEYS, L.TO_BOT, { ...env, nonce: crypto.randomBytes(18).toString('base64url') }), null);
    assert.equal(L.open(KEYS, L.TO_BOT, { ...env, v: 2 }), null);
    assert.equal(L.open(KEYS, L.TO_BOT, null), null);
    assert.equal(L.open(KEYS, L.TO_BOT, { v: 1 }), null);
});

test('wrong key is rejected', () => {
    const env = L.seal(L.deriveKeys(OTHER), L.TO_BOT, { op: 'execute', sql: 'SELECT 1' });
    assert.equal(L.open(KEYS, L.TO_BOT, env), null);
});

test('old or future ts is rejected (60 s)', () => {
    const env = L.seal(KEYS, L.TO_BOT, { op: 'execute', sql: 'SELECT 1' });
    assert.ok(L.open(KEYS, L.TO_BOT, env, env.ts + 59000));
    assert.equal(L.open(KEYS, L.TO_BOT, env, env.ts + 61000), null);
    assert.equal(L.open(KEYS, L.TO_BOT, env, env.ts - 61000), null);
});

test('types round trip: Buffer, Date, BigInt, null, undefined, NaN, $t objects', () => {
    const v = { buf: Buffer.from('hi'), d: new Date(1700000000123), bad: new Date(NaN), big: 2n ** 70n, n: null, u: undefined, nan: NaN, inf: -Infinity, arr: [1, null, Buffer.alloc(0)], o: { $t: 'd', v: 5 }, s: 'x', z: 0 };
    const back = L.decode(JSON.parse(JSON.stringify(L.encode(v))));
    assert.ok(Buffer.isBuffer(back.buf)); assert.equal(back.buf.toString(), 'hi');
    assert.ok(back.d instanceof Date); assert.equal(back.d.getTime(), 1700000000123);
    assert.ok(back.bad instanceof Date); assert.ok(Number.isNaN(back.bad.getTime()));
    assert.equal(back.big, 2n ** 70n);
    assert.equal(back.n, null);
    assert.ok('u' in back); assert.equal(back.u, undefined);
    assert.ok(Number.isNaN(back.nan)); assert.equal(back.inf, -Infinity);
    assert.ok(Buffer.isBuffer(back.arr[2])); assert.equal(back.arr[1], null);
    assert.deepEqual(back.o, { $t: 'd', v: 5 });
    const p = L.decode(JSON.parse('{"__proto__":{"polluted":1}}'));
    assert.equal(({}).polluted, undefined); assert.equal(Object.getPrototypeOf(p), Object.prototype);
});

// ---------- server ----------
test('only POST /q is accepted: everything else is a bare 404', () => withServer(async ({ port }) => {
    for (const [m, p] of [['GET', '/q'], ['GET', '/'], ['POST', '/'], ['POST', '/q/'], ['PUT', '/q'], ['POST', '/Q']]) {
        const r = await raw(port, m, p, m === 'GET' ? undefined : '{}');
        assert.equal(r.status, 404, m + ' ' + p); assert.equal(r.text, '');
    }
    const ok = await ask(port, { op: 'execute', sql: 'SELECT 1' });
    assert.equal(ok.status, 200);
}));

test('bad envelopes, wrong key and tampering get a bare 404', () => withServer(async ({ port, pool }) => {
    assert.equal((await raw(port, 'POST', '/q', 'not json')).status, 404);
    assert.equal((await ask(port, { op: 'execute', sql: 'SELECT 1' }, L.deriveKeys(OTHER))).status, 404);
    const env = L.seal(KEYS, L.TO_BOT, { op: 'execute', sql: 'SELECT 1' });
    const r = await raw(port, 'POST', '/q', JSON.stringify({ ...env, ts: env.ts - 1 }));
    assert.equal(r.status, 404); assert.equal(r.text, '');
    assert.equal(pool.log.length, 0, 'nothing ran');
}));

test('replayed nonce is rejected', () => withServer(async ({ port, pool }) => {
    const env = JSON.stringify(L.seal(KEYS, L.TO_BOT, { op: 'execute', sql: 'INSERT x' }));
    assert.equal((await raw(port, 'POST', '/q', env)).status, 200);
    assert.equal((await raw(port, 'POST', '/q', env)).status, 404);
    assert.equal(pool.log.length, 1, 'the write ran once');
}));

test('old ts is rejected by the server', () => withServer(async ({ port, pool }) => {
    const real = Date.now;
    let env;
    try { Date.now = () => real() - 120000; env = L.seal(KEYS, L.TO_BOT, { op: 'execute', sql: 'SELECT 1' }); } finally { Date.now = real; }
    assert.equal((await raw(port, 'POST', '/q', JSON.stringify(env))).status, 404);
    assert.equal(pool.log.length, 0);
}));

test('body limit is 4 MB', () => withServer(async ({ port, pool }) => {
    const big = Buffer.alloc(1024 * 1024, 7);
    const ok = await ask(port, { op: 'execute', sql: 'ECHO', params: [big, big] }); // ~2 MB -> ~3.6 MB envelope
    assert.equal(ok.status, 200);
    assert.ok(Buffer.isBuffer(ok.body.rows[0].params[0]) && ok.body.rows[0].params[0].equals(big));
    const tooBig = 'x'.repeat(L.BODY_MAX + 10);
    const r = await raw(port, 'POST', '/q', tooBig);
    assert.ok(r.status === 404 || r.status === 0, 'refused (' + (r.status || r.error) + ')');
    // a lying Content-Length is also cut off while reading
    const r2 = await new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/q', agent: false, headers: { 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', () => resolve(0));
        const chunk = Buffer.alloc(512 * 1024, 120);
        for (let i = 0; i < 10; i++) req.write(chunk);
        req.end();
    });
    assert.ok(r2 === 404 || r2 === 0);
    assert.equal(pool.log.length, 1);
}));

test('types survive the whole trip (rows and params)', () => withServer(async ({ port, pool }) => {
    const r = await ask(port, { op: 'execute', sql: 'SELECT types' });
    const row = r.body.rows[0];
    assert.ok(Buffer.isBuffer(row.pic)); assert.deepEqual([...row.pic], [0, 1, 2, 255]);
    assert.ok(row.at instanceof Date); assert.equal(row.at.toISOString(), '2026-11-16T01:02:03.456Z');
    assert.equal(row.big, 12345678901234567890n);
    assert.equal(row.dec, '12.50');
    assert.equal(row.none, null);
    assert.deepEqual(row.json, { a: [1, 'x'], $t: 'tricky' });
    assert.equal(row.flag, true);
    assert.deepEqual(r.body.fields, [{ name: 'id', columnType: 3, table: 't' }]);

    const at = new Date('2027-01-01T00:00:00Z');
    await ask(port, { op: 'execute', sql: 'ECHO', params: [Buffer.from('ab'), at, 9n, null, 'x'] });
    const p = pool.log[pool.log.length - 1].params;
    assert.ok(Buffer.isBuffer(p[0])); assert.ok(p[1] instanceof Date); assert.equal(p[1].getTime(), at.getTime());
    assert.equal(p[2], 9n); assert.equal(p[3], null); assert.equal(p[4], 'x');

    const w = await ask(port, { op: 'execute', sql: 'INSERT INTO t VALUES (?)', params: [1] });
    assert.equal(w.body.rows.affectedRows, 1); assert.equal(w.body.rows.insertId, 42);
    assert.equal(w.body.affectedRows, 1); assert.equal(w.body.insertId, 42);
    assert.equal(w.body.fields, undefined);

    await ask(port, { op: 'query', sql: 'SELECT 1' });
    assert.equal(pool.log[pool.log.length - 1].kind, 'query');
    await ask(port, { op: 'execute', sql: 'SELECT 1' });
    assert.equal(pool.log[pool.log.length - 1].params, undefined, 'no params -> called with the SQL only');
}));

test('SQL errors pass through with code / errno / message', () => withServer(async ({ port }) => {
    const r = await ask(port, { op: 'execute', sql: 'BAD', params: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.error.code, 'ER_BAD_FIELD_ERROR');
    assert.equal(r.body.error.errno, 1054);
    assert.equal(r.body.error.sqlState, '42S22');
    assert.match(r.body.error.message, /Unknown column/);
    const u = await ask(port, { op: 'execute', sql: 'UNDEF', params: [undefined] });
    assert.equal(u.body.error.name, 'TypeError');
    const x = await ask(port, { op: 'drop everything', sql: 'X' });
    assert.ok(x.body.error);
}));

test('transactions: begin / execute / commit / release on one connection', () => withServer(async ({ port, pool, server }) => {
    const b = await ask(port, { op: 'begin', conn: 'new' });
    const id = b.body.conn;
    assert.ok(typeof id === 'string' && id.length >= 20);
    await ask(port, { op: 'execute', sql: 'INSERT a', params: [1], conn: id });
    const bad = await ask(port, { op: 'execute', sql: 'BAD', conn: id });
    assert.equal(bad.body.error.code, 'ER_BAD_FIELD_ERROR'); assert.equal(bad.body.conn, id);
    await ask(port, { op: 'rollback', conn: id });
    await ask(port, { op: 'commit', conn: id });
    await ask(port, { op: 'release', conn: id });
    assert.deepEqual(pool.log.map(l => l.who + ':' + l.kind), ['conn1:begin', 'conn1:execute', 'conn1:execute', 'conn1:rollback', 'conn1:commit', 'conn1:release']);
    assert.equal(server.dbLink.leases.size, 0);
    const gone = await ask(port, { op: 'execute', sql: 'SELECT 1', conn: id });
    assert.equal(gone.body.error.code, 'DBLINK_NO_CONNECTION');
    await ask(port, { op: 'release', conn: 'nonexistent' });
}));

test('a connection left open is rolled back and given back', async () => {
    const real = setTimeout;
    const timers = [];
    global.setTimeout = (fn, ms) => { if (ms === 30000) { const t = { fn, unref() {} }; timers.push(t); return t; } return real(fn, ms); };
    try {
        await withServer(async ({ port, pool, server, logs }) => {
            await ask(port, { op: 'begin', conn: 'new' });
            assert.equal(server.dbLink.leases.size, 1);
            timers[timers.length - 1].fn();
            await new Promise(r => real(r, 20));
            assert.equal(server.dbLink.leases.size, 0);
            assert.deepEqual(pool.log.map(l => l.kind), ['begin', 'rollback', 'release']);
            assert.ok(logs.some(l => /left open/.test(l)));
        });
    } finally { global.setTimeout = real; }
});

test('an IP is paused after repeated bad requests', () => withServer(async ({ port, logs }) => {
    for (let i = 0; i < 20; i++) await raw(port, 'GET', '/');
    assert.ok(logs.some(l => /Paused/.test(l)));
    const r = await ask(port, { op: 'execute', sql: 'SELECT 1' });
    assert.notEqual(r.status, 200, 'paused: even a good request is refused');
}));

test('start() does nothing without DBLINK_PORT + DBLINK_SECRET, refuses a short secret', () => {
    const saved = { p: process.env.DBLINK_PORT, s: process.env.DBLINK_SECRET };
    const errs = [], realErr = console.error;
    console.error = m => errs.push(String(m));
    try {
        delete process.env.DBLINK_PORT; delete process.env.DBLINK_SECRET;
        assert.equal(L.start(), null);
        process.env.DBLINK_PORT = '25999'; process.env.DBLINK_SECRET = 'tooshort';
        assert.equal(L.start(), null);
        assert.ok(errs.some(e => /Not started: DBLINK_SECRET must be at least 43/.test(e) && !e.includes('tooshort')), 'error does not show the secret');
        process.env.DBLINK_PORT = 'abc'; process.env.DBLINK_SECRET = SECRET;
        assert.equal(L.start(), null);
        assert.ok(errs.some(e => /not a valid port/.test(e)));
    } finally {
        console.error = realErr;
        if (saved.p === undefined) delete process.env.DBLINK_PORT; else process.env.DBLINK_PORT = saved.p;
        if (saved.s === undefined) delete process.env.DBLINK_SECRET; else process.env.DBLINK_SECRET = saved.s;
    }
});

test('nothing is logged about bodies, SQL or params', () => withServer(async ({ port, logs }) => {
    const realLog = console.log, realErr = console.error, out = [];
    console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => out.push(a.join(' '));
    try {
        await ask(port, { op: 'execute', sql: 'BAD', params: ['very-private-value'] });
        await raw(port, 'POST', '/q', '{"very-private-body":1}');
    } finally { console.log = realLog; console.error = realErr; }
    const all = out.concat(logs).join('\n');
    assert.ok(!all.includes('very-private'));
    assert.ok(!all.includes(SECRET));
}));
