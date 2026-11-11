// PF Mount farm with the owner's REAL item lists file (never downloaded: the owner makes it with the builder page).
// Run with the file:  PINGWAY_COLLECT_LISTS_FILE=/path/to/ffxivcollect-lists.json node --test test/pf-mountfarm-real.test.js
// Without PINGWAY_COLLECT_LISTS_FILE (or when that file isn't there) the test is skipped.
// With the owner's current file (built 2026-11-11): 57 farmable mounts.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const FILE = process.env.PINGWAY_COLLECT_LISTS_FILE;
const have = !!(FILE && fs.existsSync(FILE));

test('the real lists file: farmable mounts = 57; Chaotic raid mounts are not farmable; names in 4 languages', { skip: have ? false : 'set PINGWAY_COLLECT_LISTS_FILE to the real ffxivcollect-lists.json' }, async () => {
    const fc = require('../utils/ffxivCollect');
    fc._setListsFile(FILE);
    const en = await fc.farmableMounts(null, 'en');
    assert.ok(!en.items.notLoaded, 'the file loads');
    const names = en.items.map(m => m.name);
    assert.equal(en.items.length, 57, names.join(', '));
    for (const n of ['Dais of Darkness', 'Shroud of Darkness']) assert.ok(!names.includes(n), n + ' (Chaotic Raid) is not farmable');
    for (const n of ['Wings of Ruin', 'Lowrider T1RANT', 'Wings of Eternity', 'Xanthos', 'Arrhidaeus']) assert.ok(names.includes(n), n);
    // every farmable mount really has an Extreme / Minstrel's Ballad trial or a Savage raid in its English sources
    for (const m of en.items) assert.ok(fc.isFarmableMount(m), m.name);
    for (const l of ['fr', 'de', 'ja']) {
        const x = await fc.farmableMounts(null, l);
        assert.equal(x.items.length, 57, l);
        assert.deepEqual(x.items.map(m => m.id).sort((a, b) => a - b), en.items.map(m => m.id).sort((a, b) => a - b), l + ': the same mounts');
    }
    // Felyne Support Team Cart is bought with certificates -> left out (owner's choice)
    assert.ok(!en.items.some(m => m.name === 'Felyne Support Team Cart'), 'Felyne Support Team Cart is not farmable');
});
