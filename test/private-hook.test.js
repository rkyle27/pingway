// The optional private/ folder (not in the public repository): utils/privateHook.js and how the public code behaves
// with and without it. Plain node, no Discord / database:  node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { loadPrivate } = require(path.join(ROOT, 'utils', 'privateHook.js'));
const Q = require(path.join(ROOT, 'utils', 'commandQueue.js'));

function withEnv(value, fn) {
    const old = process.env.PINGWAY_NO_PRIVATE;
    if (value === undefined) delete process.env.PINGWAY_NO_PRIVATE; else process.env.PINGWAY_NO_PRIVATE = value;
    try { return fn(); } finally { if (old === undefined) delete process.env.PINGWAY_NO_PRIVATE; else process.env.PINGWAY_NO_PRIVATE = old; }
}

test('loadPrivate: missing module -> null; PINGWAY_NO_PRIVATE=1 -> null', () => {
    withEnv(undefined, () => assert.equal(loadPrivate('no-such-module-' + process.pid), null));
    withEnv('1', () => assert.equal(loadPrivate('console'), null));
});

test('loadPrivate: an error inside a module that IS there is not hidden', () => {
    const dir = path.join(ROOT, 'private');
    const made = !fs.existsSync(dir);
    if (made) fs.mkdirSync(dir);
    const name = '__hook_test_' + process.pid;
    const file = path.join(dir, name + '.js');
    fs.writeFileSync(file, "require('./__really_missing_" + process.pid + "');\n");
    try {
        withEnv(undefined, () => assert.throws(() => loadPrivate(name), e => e.code === 'MODULE_NOT_FOUND'));
    } finally {
        fs.rmSync(file, { force: true });
        if (made) fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('command queue without the private handler: unknown jobs are marked as not available', async () => {
    const pool = { execute: async () => { throw new Error('no database needed'); } };
    const out = await Q.runOne({ id: 1, action: 'anything', args: '{}' }, {}, pool);
    assert.deepEqual(out, { state: 'error', result: 'This command is not available.' });
    const out2 = await Q.runOne({ id: 2, action: 'anything', args: '{"a":1}' }, { runPrivate: async () => null }, pool);
    assert.equal(out2.state, 'error');
});

test('command queue hands other jobs to runPrivate (row, parsed args, pool)', async () => {
    const pool = {};
    let seen = null;
    const out = await Q.runOne({ id: 3, action: 'x', args: '{"n":5}' }, { runPrivate: async (row, args, p) => { seen = { row, args, p }; return { state: 'done', result: 'ok' }; } }, pool);
    assert.deepEqual(out, { state: 'done', result: 'ok' });
    assert.equal(seen.row.id, 3);
    assert.deepEqual(seen.args, { n: 5 });
    assert.equal(seen.p, pool);
});

test('giveaway: without the private module every reward is a manual one', () => {
    const GW = (() => { try { return require(path.join(ROOT, 'utils', 'giveaway.js')); } catch (e) { return null; } })();
    if (!GW) return; // discord.js stand-ins live in giveaway.test.js
    withEnv('1', () => {
        assert.equal(GW.grantCommand({ reward_kind: 'points', reward_amount: 25, winner_id: '100000000000000003' }), null);
        assert.equal(GW.grantCommand({ reward_kind: 'manual', reward_amount: 0, winner_id: '100000000000000003' }), null);
    });
});

test('mybot.js only has the neutral hook (the private code is loaded through utils/privateHook.js)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'mybot.js'), 'utf8');
    assert.match(src, /const privateConsole = loadPrivate\('console'\);/);
    assert.match(src, /privateConsole \? privateConsole\.start\(\{ client, ensurePointsMigration \}\) : null/);
    assert.doesNotMatch(src, /readline|process\.stdin/);
});

test('PINGWAY_NO_PRIVATE=1 in a fresh process: every private module is skipped', () => {
    // Simulated with PINGWAY_NO_PRIVATE=1 in a child process: only the hook itself is exercised (no Discord login).
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, ['-e',
        "const h=require(" + JSON.stringify(path.join(ROOT, 'utils', 'privateHook.js')) + ");" +
        "process.stdout.write(String(h.loadPrivate('console')===null && h.loadPrivate('giveawayGrant')===null && h.loadPrivate('commandQueueDev')===null))"
    ], { env: { ...process.env, PINGWAY_NO_PRIVATE: '1' }, cwd: os.tmpdir() }).toString();
    assert.equal(out, 'true');
});
