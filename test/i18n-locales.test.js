// Locale coverage: every text in locales/en/* exists in fr, de and ja with the same {placeholders}, no extra keys, valid JSON.
// Run: node --test test/i18n-locales.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'locales');
const OTHERS = ['fr', 'de', 'ja'];

function flatten(obj, prefix, out) {
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? prefix + '.' + k : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
}
const placeholders = s => (typeof s === 'string' ? (s.match(/\{\w+\}/g) || []).sort() : Array.isArray(s) ? s.flatMap(x => (typeof x === 'string' ? x.match(/\{\w+\}/g) || [] : [])).sort() : []);
const read = (lang, file) => JSON.parse(fs.readFileSync(path.join(DIR, lang, file), 'utf8'));

const enFiles = fs.readdirSync(path.join(DIR, 'en')).filter(f => f.endsWith('.json'));

test('every locale file is valid JSON', () => {
    for (const lang of ['en', ...OTHERS]) {
        for (const f of fs.readdirSync(path.join(DIR, lang)).filter(f => f.endsWith('.json'))) {
            assert.doesNotThrow(() => read(lang, f), lang + '/' + f);
        }
    }
});

test('no locale file exists only in fr/de/ja', () => {
    for (const lang of OTHERS) {
        for (const f of fs.readdirSync(path.join(DIR, lang)).filter(f => f.endsWith('.json'))) {
            assert.ok(enFiles.includes(f), lang + '/' + f + ' has no English file');
        }
    }
});

for (const file of enFiles) {
    test('locales ' + file + ': same keys and placeholders in fr/de/ja', () => {
        const en = flatten(read('en', file), '', {});
        for (const lang of OTHERS) {
            assert.ok(fs.existsSync(path.join(DIR, lang, file)), lang + '/' + file + ' is missing');
            const other = flatten(read(lang, file), '', {});
            for (const key of Object.keys(en)) {
                assert.ok(key in other, lang + '/' + file + ': missing ' + key);
                assert.equal(typeof other[key], typeof en[key], lang + '/' + file + ': ' + key + ' has another type');
                if (Array.isArray(en[key])) assert.equal(other[key].length, en[key].length, lang + '/' + file + ': ' + key + ' list length');
                assert.deepEqual(placeholders(other[key]), placeholders(en[key]), lang + '/' + file + ': ' + key + ' placeholders');
                if (typeof en[key] === 'string' && en[key].trim()) assert.ok(other[key].trim(), lang + '/' + file + ': ' + key + ' is empty');
            }
            for (const key of Object.keys(other)) assert.ok(key in en, lang + '/' + file + ': extra key ' + key);
        }
    });
}

test('Discord limits: command/option descriptions <= 100 characters, choice names <= 100', () => {
    for (const file of enFiles) {
        for (const lang of ['en', ...OTHERS]) {
            const flat = flatten(read(lang, file), '', {});
            for (const [key, v] of Object.entries(flat)) {
                if (/(^|\.)cmd\./.test(key)) assert.ok(typeof v === 'string' && v.length >= 1 && v.length <= 100, lang + '/' + file + ': ' + key + ' is ' + (v && v.length) + ' characters');
            }
        }
    }
});
