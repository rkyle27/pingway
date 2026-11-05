// Tests for the "kofi ..." console commands (Google voice credits, console memberships). Plain node, fake database:
//   node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const K = require(path.join(ROOT, 'utils', 'voice', 'kofiAdmin.js'));
const DDL = require(path.join(ROOT, 'utils', 'voice', 'ddl.js'));

const NOW = Date.parse('2027-03-01T00:00:00Z');
const DAY = 864e5;
const U = '123456789012345678';

// ------------------------------------------------------------------ fake database (in memory)
function fakeDb({ dupColumn = false } = {}) {
    const db = { lots: [], vset: new Map(), kofi: [], log: [], tx: [], ddl: [] };
    let nextId = 1;
    const live = (uid, now) => db.lots.filter(l => l.user_id === uid && l.chars_left > 0 && (l.expires_at === 0 || l.expires_at > now))
        .sort((a, b) => ((a.expires_at === 0) - (b.expires_at === 0)) || a.expires_at - b.expires_at || a.id - b.id);
    async function execute(sql, a = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        db.log.push(q);
        if (/^CREATE TABLE/.test(q)) { db.ddl.push(sql); return [{}]; }
        if (/^ALTER TABLE/.test(q)) {
            db.ddl.push(sql);
            if (dupColumn) { const e = new Error("Duplicate column name 'member_until'"); e.code = 'ER_DUP_FIELDNAME'; e.errno = 1060; throw e; }
            return [{}];
        }
        if (/SUM\(chars_left\)/.test(q)) return [[{ left_: live(a[0], a[1]).reduce((s, l) => s + l.chars_left, 0) }]];
        if (/^SELECT (id, )?chars_left.* FROM tts_char_lots WHERE user_id = \?/.test(q)) {
            assert.match(q, /ORDER BY \(expires_at = 0\), expires_at, id/, 'oldest-expiring first');
            if (/^SELECT id, chars_left/.test(q)) assert.match(q, /FOR UPDATE$/, 'row locks');
            return [live(a[0], a[1]).map(l => ({ ...l }))];
        }
        if (/^UPDATE tts_char_lots SET chars_left = chars_left - \? WHERE id = \? AND chars_left >= \?/.test(q)) {
            const l = db.lots.find(x => x.id === a[1]);
            if (!l || l.chars_left < a[2]) return [{ affectedRows: 0 }];
            l.chars_left -= a[0];
            return [{ affectedRows: 1 }];
        }
        if (/^INSERT INTO tts_char_lots/.test(q)) {
            if (db.lots.some(l => l.kofi_tx === a[3])) { const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e; }
            db.lots.push({ id: nextId++, user_id: a[0], chars_total: a[1], chars_left: a[2], kofi_tx: a[3], created_at: a[4], expires_at: a[5] });
            return [{ affectedRows: 1 }];
        }
        if (/FROM voice_user_settings WHERE user_id = \?/.test(q)) return [[db.vset.get(a[0])].filter(Boolean)];
        if (/^UPDATE voice_user_settings SET member_until = NULL WHERE user_id = \?/.test(q)) {
            const r = db.vset.get(a[0]);
            if (r) r.member_until = null;
            return [{ affectedRows: r ? 1 : 0 }];
        }
        if (/^INSERT INTO voice_user_settings .* ON DUPLICATE KEY UPDATE member_until = VALUES\(member_until\)$/.test(q)) {
            const r = db.vset.get(a[0]);
            if (r) r.member_until = a[2];
            else db.vset.set(a[0], { google_on: 1, nickname: null, max_chars: null, updated_at: a[1], member_until: a[2] });
            return [{ affectedRows: r ? 2 : 1 }];
        }
        if (/FROM kofi_payments WHERE user_id = \?/.test(q)) {
            return [db.kofi.filter(k => k.user_id === a[0] && k.status === 'credited' && k.type.toLowerCase() === 'subscription' && k.created_at > a[1])
                .sort((x, y) => y.created_at - x.created_at).slice(0, 1)];
        }
        throw new Error('unexpected query: ' + q);
    }
    db.pool = {
        execute,
        getConnection: async () => ({
            execute,
            beginTransaction: async () => db.tx.push('begin'),
            commit: async () => db.tx.push('commit'),
            rollback: async () => db.tx.push('rollback'),
            release: () => db.tx.push('release')
        })
    };
    return db;
}

const client = { users: { fetch: async id => (id === U ? { username: 'riverzola' } : Promise.reject(new Error('Unknown User'))) } };

async function run(db, line, extra = {}) {
    K._reset();
    const logs = [];
    const errors = [];
    const out = await K.kofiConsole(line.split(/\s+/).slice(1), {
        getPool: () => db.pool, client, now: NOW, randomHex: () => 'a1b2c3d4',
        log: l => logs.push(l), error: l => errors.push(l), ...extra
    });
    return { out, logs, errors, text: out.join('\n') };
}

test.beforeEach(() => { delete process.env.CREDIT_VALIDITY_DAYS; });

// ------------------------------------------------------------------ input
test('bad input prints the usage line and touches nothing', async () => {
    const db = fakeDb();
    for (const line of ['kofi', 'kofi 123', 'kofi abc', 'kofi give ' + U, 'kofi give ' + U + ' 0', 'kofi give ' + U + ' -5',
        'kofi give ' + U + ' 1.5', 'kofi give ' + U + ' 1000001', 'kofi remove 12 5', 'kofi member ' + U, 'kofi member ' + U + ' 0',
        'kofi member ' + U + ' 3651', 'kofi member ' + U + ' on', 'kofi take ' + U + ' 5', 'kofi give ' + U + ' 5 extra', 'kofi ' + U + ' x']) {
        const r = await run(db, line);
        assert.deepEqual(r.out, [K.USAGE], line);
        assert.deepEqual(r.logs, [K.USAGE], line);
    }
    assert.match(K.USAGE, /kofi <id> \| kofi give <id> <credits> \| kofi remove <id> <credits> \| kofi member <id> <days\|off>/);
    assert.equal(db.log.length, 0, 'no queries for bad input');
    assert.deepEqual(K.parseArgs(['give', U, '1000000']), { cmd: 'give', id: U, credits: 1000000 });
    assert.deepEqual(K.parseArgs(['member', U, '3650']), { cmd: 'member', id: U, days: 3650 });
    assert.deepEqual(K.parseArgs(['member', U, 'OFF']), { cmd: 'member', id: U, off: true });
});

// ------------------------------------------------------------------ give
test('give: credits*2000 characters, console tx id, 180 days, prints new balance and the username', async () => {
    const db = fakeDb();
    const r = await run(db, 'kofi give ' + U + ' 5');
    assert.equal(db.lots.length, 1);
    const lot = db.lots[0];
    assert.deepEqual([lot.user_id, lot.chars_total, lot.chars_left, lot.created_at, lot.expires_at], [U, 10000, 10000, NOW, NOW + 180 * DAY]);
    assert.equal(lot.kofi_tx, 'console-' + NOW + '-a1b2c3d4');
    assert.match(lot.kofi_tx, /^console-\d{13}-[0-9a-f]{8}$/);
    assert.ok(lot.kofi_tx.length <= 80, 'fits kofi_tx VARCHAR(80)');
    assert.equal(r.logs.length, 1, 'one clear console line');
    assert.match(r.text, /Gave 5 credits \(10,000 characters\) to 123456789012345678 \(riverzola\)/);
    assert.match(r.text, /Balance now: 5 credits \(10,000 characters\)/);
    // second give: a different (unique) tx id, balance adds up
    const r2 = await run(db, 'kofi give ' + U + ' 500', { randomHex: () => 'ffff0000' });
    assert.notEqual(db.lots[1].kofi_tx, db.lots[0].kofi_tx);
    assert.match(r2.text, /Balance now: 505 credits \(1,010,000 characters\)/);
});

test('give: real random tx ids differ; CREDIT_VALIDITY_DAYS is used, 0 = never expire (expires_at 0)', async () => {
    const db = fakeDb();
    K._reset();
    const logs = [];
    await K.kofiConsole(['give', U, '1'], { getPool: () => db.pool, now: NOW, log: l => logs.push(l) });
    await K.kofiConsole(['give', U, '1'], { getPool: () => db.pool, now: NOW, log: l => logs.push(l) });
    assert.notEqual(db.lots[0].kofi_tx, db.lots[1].kofi_tx, 'never collides');
    assert.ok(db.lots.every(l => K.isConsoleTx(l.kofi_tx)));
    assert.match(logs[0], /to 123456789012345678,/, 'no client -> just the id');
    process.env.CREDIT_VALIDITY_DAYS = '30';
    await run(db, 'kofi give ' + U + ' 1');
    assert.equal(db.lots[2].expires_at, NOW + 30 * DAY);
    process.env.CREDIT_VALIDITY_DAYS = '0';
    const r = await run(db, 'kofi give ' + U + ' 1', { randomHex: () => '0000beef' });
    assert.equal(db.lots[3].expires_at, 0);
    assert.match(r.text, /never expires/);
    process.env.CREDIT_VALIDITY_DAYS = 'junk';
    assert.equal(K.validityDays(), 180);
});

// ------------------------------------------------------------------ remove
test('remove: oldest-expiring first, expired skipped, never-expiring last, transaction with locks', async () => {
    const db = fakeDb();
    db.lots.push(
        { id: 1, user_id: U, chars_left: 99999, expires_at: NOW - 1, kofi_tx: 'old' },          // expired: untouched
        { id: 2, user_id: U, chars_left: 6000, expires_at: 0, kofi_tx: 'never' },               // never expires: last
        { id: 3, user_id: U, chars_left: 3000, expires_at: NOW + 50 * DAY, kofi_tx: 'b' },
        { id: 4, user_id: U, chars_left: 2500, expires_at: NOW + 10 * DAY, kofi_tx: 'a' },      // first
        { id: 5, user_id: 'other', chars_left: 9000, expires_at: NOW + DAY, kofi_tx: 'x' }
    );
    const r = await run(db, 'kofi remove ' + U + ' 3'); // 6,000 characters
    const left = Object.fromEntries(db.lots.map(l => [l.id, l.chars_left]));
    assert.deepEqual(left, { 1: 99999, 2: 5500, 3: 0, 4: 0, 5: 9000 });
    assert.deepEqual(db.tx, ['begin', 'commit', 'release']);
    assert.equal(r.logs.length, 1);
    assert.match(r.text, /Removed 3 credits \(6,000 characters\) from 123456789012345678 \(riverzola\)\. Balance now: 2 credits \(5,500 characters\)\./);
});

test('remove: never below 0, says how much was really left', async () => {
    const db = fakeDb();
    db.lots.push({ id: 1, user_id: U, chars_left: 3500, expires_at: NOW + DAY, kofi_tx: 'a' });
    const r = await run(db, 'kofi remove ' + U + ' 5');
    assert.equal(db.lots[0].chars_left, 0);
    assert.match(r.text, /Removed 1 credit \(3,500 characters\).*asked for 5 credits, only 3,500 characters were left.*Balance now: 0 credits \(0 characters\)/);
    const again = await run(db, 'kofi remove ' + U + ' 1');
    assert.match(again.text, /Removed 0 credits \(0 characters\)/);
    assert.ok(db.lots.every(l => l.chars_left >= 0));
});

test('remove: a database error rolls back and prints one error line', async () => {
    const db = fakeDb();
    db.lots.push({ id: 1, user_id: U, chars_left: 4000, expires_at: 0, kofi_tx: 'a' });
    const pool = db.pool;
    const broken = {
        execute: pool.execute,
        getConnection: async () => {
            const c = await pool.getConnection();
            return { ...c, execute: async (q, a) => { if (/^UPDATE/.test(q)) throw new Error('lock wait timeout'); return c.execute(q, a); } };
        }
    };
    const r = await run(db, 'kofi remove ' + U + ' 1', { getPool: () => broken });
    assert.deepEqual(db.tx, ['begin', 'rollback', 'release']);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /\[KOFI\] Failed: lock wait timeout/);
    assert.equal(db.lots[0].chars_left, 4000);
});

// ------------------------------------------------------------------ member
test('member <days>: member_until = now + days (new row or existing row, other settings kept); off = NULL', async () => {
    const db = fakeDb();
    const r = await run(db, 'kofi member ' + U + ' 30');
    assert.equal(db.vset.get(U).member_until, NOW + 30 * DAY);
    assert.equal(db.vset.get(U).google_on, 1);
    assert.equal(r.logs.length, 1);
    assert.match(r.text, /Console membership ON for 123456789012345678 \(riverzola\): 30 days, until 2027-03-31 09:00 JST/);

    db.vset.set('234567890123456789', { google_on: 0, nickname: 'Riv', max_chars: 80, updated_at: 1, member_until: null });
    await run(db, 'kofi member 234567890123456789 1');
    assert.deepEqual(db.vset.get('234567890123456789'), { google_on: 0, nickname: 'Riv', max_chars: 80, updated_at: 1, member_until: NOW + DAY });

    const off = await run(db, 'kofi member ' + U + ' off');
    assert.equal(db.vset.get(U).member_until, null);
    assert.match(off.text, /Console membership OFF for 123456789012345678 \(riverzola\) \(it was until 2027-03-31 09:00 JST\)\./);
    const none = await run(db, 'kofi member 345678901234567890 off');
    assert.match(none.text, /OFF for 345678901234567890 \(they had none\)\./);
    // Ko-fi membership still counts -> said in the same line
    db.kofi.push({ user_id: U, type: 'Subscription', status: 'credited', created_at: NOW - 5 * DAY });
    const still = await run(db, 'kofi member ' + U + ' off');
    assert.equal(still.logs.length, 1);
    assert.match(still.text, /still count as a member through their Ko-fi membership payment until 2027-03-31 09:00 JST/);
});

// ------------------------------------------------------------------ read
test('kofi <id>: credits, batches with source and expiry, member status, switch, nickname, max chars', async () => {
    const db = fakeDb();
    let r = await run(db, 'kofi ' + U);
    assert.match(r.text, /Google voice credits left: 0 credits \(0 characters\)/);
    assert.match(r.text, /Batches: none/);
    assert.match(r.text, /Member: no$/m);
    assert.match(r.text, /Google switch \(My Settings\): ON \(default, nothing saved\)/);
    assert.match(r.text, /Nickname: not set/);
    assert.match(r.text, /Max characters per message: 200 \(default\)/);

    db.lots.push(
        { id: 1, user_id: U, chars_left: 5000, expires_at: NOW - 1, kofi_tx: 'gone' },
        { id: 2, user_id: U, chars_left: 4000, expires_at: 0, kofi_tx: 'console-1-abcd' },
        { id: 3, user_id: U, chars_left: 10999, expires_at: NOW + 20 * DAY, kofi_tx: 'kofi-tx-1' }
    );
    db.vset.set(U, { google_on: 0, nickname: 'Riv', max_chars: 80, updated_at: 1, member_until: NOW + 10 * DAY });
    db.kofi.push({ user_id: U, type: 'Subscription', status: 'credited', created_at: NOW - 2 * DAY });
    r = await run(db, 'kofi ' + U);
    assert.equal(r.out[0], '🔊 [KOFI] 123456789012345678 (riverzola)');
    assert.match(r.text, /credits left: 7 credits \(14,999 characters\)/, 'floor(14,999 / 2,000)');
    assert.match(r.text, /1\. 5 credits \(10,999 characters\) \| Ko-fi payment \| expires 2027-03-21 09:00 JST/);
    assert.match(r.text, /2\. 2 credits \(4,000 characters\) \| console \| never expires/);
    assert.doesNotMatch(r.text, /5,000 characters/, 'expired batch not shown');
    assert.match(r.text, /Member: YES - Ko-fi membership payment on 2027-02-27 09:00 JST \(counts until 2027-04-03 09:00 JST\) \+ console member until 2027-03-11 09:00 JST/);
    assert.match(r.text, /Google switch \(My Settings\): OFF/);
    assert.match(r.text, /Nickname: Riv/);
    assert.match(r.text, /Max characters per message: 80/);

    db.vset.get(U).member_until = NOW - DAY;
    db.kofi.length = 0;
    r = await run(db, 'kofi ' + U);
    assert.match(r.text, /Member: no \(console membership ended 2027-02-28 09:00 JST\)/);
    assert.equal(db.log.filter(q => /^(INSERT|UPDATE)/.test(q)).length, 0, 'read only');
});

test('kofi <id>: missing kofi_payments table is fine; unknown Discord user prints just the id', async () => {
    const db = fakeDb();
    const pool = { ...db.pool, execute: async (q, a) => { if (/kofi_payments/.test(q)) { const e = new Error("Table 'x.kofi_payments' doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; } return db.pool.execute(q, a); } };
    const r = await run(db, 'kofi 999999999999999999', { getPool: () => pool });
    assert.equal(r.out[0], '🔊 [KOFI] 999999999999999999');
    assert.match(r.text, /Member: no/);
    assert.equal(r.errors.length, 0);
});

// ------------------------------------------------------------------ tables
test('tables: same DDL as the website, member_until added, duplicate column tolerated, other errors shown', async () => {
    const db = fakeDb({ dupColumn: true });
    const r = await run(db, 'kofi ' + U);
    assert.equal(r.errors.length, 0, 'duplicate column (website added it at the same time) is fine');
    assert.deepEqual(db.ddl, [DDL.TTS_CHAR_LOTS_DDL, DDL.VOICE_USER_SETTINGS_DDL, DDL.MEMBER_UNTIL_ALTER]);
    assert.match(DDL.TTS_CHAR_LOTS_DDL, /CREATE TABLE IF NOT EXISTS tts_char_lots \(/);
    assert.match(DDL.TTS_CHAR_LOTS_DDL, /kofi_tx VARCHAR\(80\) DEFAULT NULL/);
    assert.match(DDL.TTS_CHAR_LOTS_DDL, /UNIQUE KEY uniq_tx \(kofi_tx\)/);
    assert.match(DDL.VOICE_USER_SETTINGS_DDL, /CREATE TABLE IF NOT EXISTS voice_user_settings \(/);
    assert.equal(DDL.MEMBER_UNTIL_ALTER, 'ALTER TABLE voice_user_settings ADD COLUMN member_until BIGINT NULL');
    // only once per process
    const before = db.ddl.length;
    await K.kofiConsole([U], { getPool: () => db.pool, now: NOW, log: () => {} });
    assert.equal(db.ddl.length, before);
    // a real ALTER failure is reported
    const bad = { execute: async q => { if (/^ALTER/.test(q)) { const e = new Error('ALTER command denied'); e.code = 'ER_TABLEACCESS_DENIED_ERROR'; throw e; } return [{}]; } };
    const r2 = await run(db, 'kofi ' + U, { getPool: () => bad });
    assert.match(r2.errors[0], /\[KOFI\] Failed: ER_TABLEACCESS_DENIED_ERROR ALTER command denied/);
    assert.equal(DDL.isDuplicateColumn({ errno: 1060 }), true);
    assert.equal(DDL.isDuplicateColumn({ code: 'ER_PARSE_ERROR' }), false);
});

test('ddl.js is identical to the website lib/voiceDdl.js (when the website repo is next to this one)', t => {
    const site = path.join(ROOT, '..', 'pingway-dashboard', 'lib', 'voiceDdl.js');
    if (!fs.existsSync(site)) { t.skip('website repo not found next to the bot'); return; }
    assert.equal(fs.readFileSync(path.join(ROOT, 'utils', 'voice', 'ddl.js'), 'utf8'), fs.readFileSync(site, 'utf8'));
});

test('mybot.js: one kofi branch next to tts, and the startup help line lists the kofi commands', () => {
    const src = fs.readFileSync(path.join(ROOT, 'mybot.js'), 'utf8');
    assert.equal((src.match(/input === 'kofi' \|\| input\.startsWith\('kofi '\)/g) || []).length, 1);
    assert.match(src, /require\('\.\/utils\/voice\/kofiAdmin'\)\.kofiConsole\(input\.split\(\/\\s\+\/\)\.slice\(1\), \{ client \}\)/);
    assert.ok(src.indexOf("input.startsWith('kofi ')") > src.indexOf("input.startsWith('tts ')"));
    assert.match(src, /"tts" \/ "tts google on\|off", "kofi <id>" \/ "kofi give\|remove <id> <credits>" \/ "kofi member <id> <days\|off>"\\n`\);/);
    const doc = fs.readFileSync(path.join(ROOT, 'CONSOLE_COMMANDS.txt'), 'utf8');
    for (const s of ['kofi <id>', 'kofi give <id> <credits>', 'kofi remove <id> <credits>', 'kofi member <id> <days>', 'kofi member <id> off', '$1 = 100 credits', '1 credit = 2,000 characters']) {
        assert.ok(doc.includes(s), s);
    }
});
