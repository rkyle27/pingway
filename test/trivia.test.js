// Tests for Pingway Trivia in 4 languages (utils/trivia.js, utils/triviaWords.js, utils/triviaRewards.js, commands/trivia.js,
// locales/*/trivia.json). Plain node, no Discord / database / network: fake XIVAPI (test/fixtures/trivia-xivapi.js),
// in-memory database and fake interactions (test/fixtures/trivia-env.js).   node --test test/
'use strict';

const env = require('./fixtures/trivia-env').setup();
const { fakeSession, buttonsOf } = require('./fixtures/trivia-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = env.ROOT;
const fx = require('./fixtures/trivia-xivapi');
const W = require(path.join(ROOT, 'utils', 'triviaWords'));
const T = require(path.join(ROOT, 'utils', 'trivia'));
const R = require(path.join(ROOT, 'utils', 'triviaRewards'));
const i18n = require(path.join(ROOT, 'utils', 'i18n'));
const cmd = require(path.join(ROOT, 'commands', 'trivia'));
T._setPause(0, 0);

const LANGS = ['en', 'fr', 'de', 'ja'];
const GUILD = '222222222222222222';
const CHANNEL = '333333333333333333';
const ZW = W.ZWSP;
const BAD_IDS = ['mount:900', 'mount:901', 'minion:902', 'item:903'];
const toHiragana = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const resetBank = () => { try { fs.unlinkSync(T.BANK_FILE); } catch (e) { /* none */ } T._reset(); };
let bankReady = null;
const ensureBank = () => (bankReady = bankReady || (resetBank(), T.buildBank()));

// ------------------------------------------------------------------ locales
function flatten(o, pre = '', out = {}) {
    for (const [k, v] of Object.entries(o)) {
        const key = pre ? pre + '.' + k : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
}
const placeholders = v => [...new Set((Array.isArray(v) ? v.join('\n') : String(v)).match(/\{\w+\}/g) || [])].sort();
const locale = lang => JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lang, 'trivia.json'), 'utf8'));

test('locales: fr/de/ja trivia.json have the same keys and {placeholders} as English', () => {
    const en = flatten(locale('en'));
    for (const lang of ['fr', 'de', 'ja']) {
        const l = flatten(locale(lang));
        assert.deepEqual(Object.keys(l).sort(), Object.keys(en).sort(), lang + ': same keys');
        for (const k of Object.keys(en)) {
            assert.equal(Array.isArray(l[k]), Array.isArray(en[k]), lang + ' ' + k + ': same type');
            assert.deepEqual(placeholders(l[k]), placeholders(en[k]), lang + ' ' + k + ': same placeholders');
            if (typeof l[k] === 'string' && k !== 'hints.expertRecipe') assert.ok(l[k].length > 0, lang + ' ' + k + ': not empty');
        }
        assert.equal(l['reward.months'].length, 12);
    }
    // every _one has an _other
    for (const k of Object.keys(en)) if (k.endsWith('_one')) assert.ok(k.replace(/_one$/, '_other') in en, k);
});

test('locales: Discord limits (modal title 45, labels 45/80, command description 100)', () => {
    for (const lang of LANGS) {
        const t = (k, v) => i18n.t(lang, 'trivia.' + k, v);
        for (const d of W.DIFFICULTIES) assert.ok(t('modal.title', { name: t('diff.' + d.key) }).length <= 45, lang + ' modal title');
        assert.ok(t('modal.label').length <= 45, lang + ' modal label');
        for (const [k, v] of Object.entries(flatten(locale(lang).buttons))) assert.ok(v.length <= 80, lang + ' button ' + k);
        assert.ok(t('command.description').length <= 100, lang + ' description');
    }
    assert.deepEqual(Object.keys(cmd.data.toJSON().description_localizations || {}).sort(), ['de', 'fr', 'ja']);
});

// ------------------------------------------------------------------ matching / normalisation
test('matching: fr accents, apostrophes and hyphens', () => {
    assert.ok(W.sameAnswer('elementaliste', 'Élémentaliste', 'fr'));
    assert.ok(W.sameAnswer('ÉLÉMENTALISTE', 'Élémentaliste', 'fr'));
    assert.ok(W.sameAnswer('maitre d’hast', 'Maître d\'hast', 'fr'));
    assert.ok(W.sameAnswer('maîtredhast', 'Maître d\'hast', 'fr'));
    assert.ok(W.sameAnswer('chevalier-dragon', 'Chevalier dragon', 'fr'));
    assert.ok(W.sameAnswer('phenix', 'Phénix', 'fr'));
    assert.ok(W.sameAnswer('coeur', 'Cœur', 'fr'));
    assert.ok(!W.sameAnswer('chevalier noire', 'Chevalier noir', 'fr'));
    assert.ok(!W.sameAnswer('', 'Chevalier noir', 'fr'));
});

test('matching: de umlauts (ü = u = ue) and ß (= ss)', () => {
    assert.ok(W.sameAnswer('Mönch', 'Mönch', 'de'));
    assert.ok(W.sameAnswer('monch', 'Mönch', 'de'));
    assert.ok(W.sameAnswer('MOENCH', 'Mönch', 'de'));
    assert.ok(W.sameAnswer('schildkroete', 'Schildkröte', 'de'));
    assert.ok(W.sameAnswer('weissmagier', 'Weißmagier', 'de'));
    assert.ok(W.sameAnswer('WEISSMAGIER', 'Weißmagier', 'de'));
    assert.ok(!W.sameAnswer('weismagier', 'Weißmagier', 'de'));
    assert.ok(W.sameAnswer('taenzer', 'Tänzer', 'de') && W.sameAnswer('tanzer', 'Tänzer', 'de'));
    assert.ok(!W.sameAnswer('tänzerin', 'Tänzer', 'de'));
});

test('matching: ja katakana = hiragana, full/half width, ・ spaces and ー ignored, kanji exact', () => {
    assert.ok(W.sameAnswer('ないと', 'ナイト', 'ja'));
    assert.ok(W.sameAnswer('ﾅｲﾄ', 'ナイト', 'ja'), 'half-width katakana');
    assert.ok(W.sameAnswer('ナ イ ト', 'ナイト', 'ja'));
    assert.ok(W.sameAnswer('りむさろみんさ', 'リムサ・ロミンサ', 'ja'));
    assert.ok(W.sameAnswer('リムサ　ロミンサ', 'リムサ・ロミンサ', 'ja'), 'ideographic space');
    assert.ok(W.sameAnswer('リムサ･ロミンサ', 'リムサ・ロミンサ', 'ja'), 'half-width ・');
    assert.ok(W.sameAnswer('がんぶれいかー', 'ガンブレイカー', 'ja'));
    assert.ok(W.sameAnswer('がんぶれいか', 'ガンブレイカー', 'ja'), 'ー left out');
    assert.ok(W.sameAnswer('ｶﾞﾝﾌﾞﾚｲｶｰ', 'ガンブレイカー', 'ja'), 'half-width with dakuten');
    assert.ok(W.sameAnswer('黒魔道士', '黒魔道士', 'ja'));
    assert.ok(!W.sameAnswer('くろまどうし', '黒魔道士', 'ja'), 'kanji cannot be typed as kana');
    assert.ok(!W.sameAnswer('黒魔導士', '黒魔道士', 'ja'));
    assert.ok(!W.sameAnswer('かんぶれいかー', 'ガンブレイカー', 'ja'), 'dakuten matters');
    assert.ok(W.sameAnswer('ｍｋ２ チョコボ', 'MKチョコボ', 'ja'), 'full-width Latin, digits dropped like in English');
    assert.ok(!W.sameAnswer('・・', 'ナイト', 'ja'));
});

test('matching: English rules are unchanged', () => {
    assert.ok(W.sameAnswer('whitemage', 'White Mage'));
    assert.ok(W.sameAnswer("ul dah", 'Ul\'dah'));
    assert.ok(!W.sameAnswer('white', 'White Mage'));
    assert.deepEqual(W.matchingLetters('White Mage', 'whxte'), [0, 1, 3, 4]);
});

test('matching: letters in the right place per language', () => {
    assert.deepEqual(W.matchingLetters('ナイト', 'ないふ', 'ja'), [0, 1]);
    assert.deepEqual(W.matchingLetters('リムサ・ロミンサ', 'りむさろ', 'ja'), [0, 1, 2, 4], '・ skipped');
    assert.deepEqual(W.matchingLetters('ガンブレイカー', 'ガンブレイカ', 'ja'), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(W.matchingLetters('Élémentaliste', 'elxxxxxxxxxxx', 'fr'), [0, 1]);
    assert.deepEqual(W.matchingLetters('Mönch', 'monxx', 'de'), [0, 1, 2]);
});

// ------------------------------------------------------------------ reveal patterns
test('boxes: patterns and letter counts use the name of the language', () => {
    assert.equal(W.renderBoxes('Élan', [0, 1], false, 'fr'), 'É' + ZW + '🇱' + ZW + '⬜' + ZW + '⬜', 'real accented letter');
    assert.equal(W.renderBoxes('Mönch', [], true, 'de'), '🇲' + ZW + 'Ö' + ZW + '🇳' + ZW + '🇨' + ZW + '🇭');
    assert.equal(W.renderBoxes('Weißmagier', [3], false, 'de'), ['⬜', '⬜', '⬜', 'ß', '⬜', '⬜', '⬜', '⬜', '⬜', '⬜'].join(ZW));
    assert.equal(W.renderBoxes('Maître d\'hast', [], false, 'fr'), ['⬜', '⬜', '⬜', '⬜', '⬜', '⬜'].join(ZW) + '   ⬜\'' + ['⬜', '⬜', '⬜', '⬜'].join(ZW));
    assert.equal(W.renderBoxes('リムサ・ロミンサ', [0], false, 'ja'), 'リ⬜⬜・⬜⬜⬜⬜');
    assert.equal(W.renderBoxes('リムサ・ロミンサ', [], true, 'ja'), 'リムサ・ロミンサ');
    assert.equal(W.renderBoxes('黒衣森 中央', [1], false, 'ja'), '⬜衣⬜　⬜⬜');
    assert.equal(W.letterPositions('リムサ・ロミンサ', 'ja').length, 7);
    assert.equal(W.letterPositions('ガンブレイカー', 'ja').length, 7, 'ー is a letter box');
    assert.equal(W.letterPositions('Paladin').length, 7);
    assert.equal(W.letterPositions('ナイト', 'ja').length, 3);
    // English is unchanged
    assert.equal(W.renderBoxes('White Mage', [0], false), '🇼' + ZW + '⬜' + ZW + '⬜' + ZW + '⬜' + ZW + '⬜   ' + ['⬜', '⬜', '⬜', '⬜'].join(ZW));
    assert.equal(W.renderBoxes('Élan', [0], false), '🇪' + ZW + '⬜' + ZW + '⬜' + ZW + '⬜', 'English keeps 🇦 boxes');
});

test('hints: "first letter" clue opens the right box in each language', () => {
    const ja = W.makeHints('ナイト', ['カテゴリー: ジョブ'], 'ja');
    assert.deepEqual(ja[ja.length - 1], { text: '最初の文字: ナ', letter: 0 });
    assert.equal(W.hintLetter('ナイト', ja[ja.length - 1], 'ja'), 0);
    const fr = W.makeHints('Élémentaliste', ['Catégorie : Classe'], 'fr');
    assert.deepEqual(fr[fr.length - 1], { text: 'Première lettre : É', letter: 0 });
    assert.equal(W.hintLetter('Élémentaliste', fr[fr.length - 1], 'fr'), 0);
    const en = W.makeHints('Paladin', ['Category: Job']);
    assert.deepEqual(en[en.length - 1], { text: 'First letter: P', letter: 0 });
    assert.equal(W.hintLetter('Paladin', 'First letter: P'), 0, 'old plain-string clue');
    // a clue that gives the answer away is dropped (ja names have no spaces)
    assert.deepEqual(W.makeHints('ナイト', ['同じ地方: ナイト', 'ロール: タンク'], 'ja').map(W.hintText), ['ロール: タンク', '最初の文字: ナ']);
    assert.deepEqual(W.makeHints('リムサ・ロミンサ', ['都市: リムサ', 'ロール: タンク'], 'ja').map(W.hintText), ['ロール: タンク', '最初の文字: リ']);
});

test('names: what can be an answer in each language', () => {
    assert.ok(W.goodName('ナイト', 'ja') && W.goodName('忍者', 'ja') && W.goodName('リムサ・ロミンサ', 'ja'));
    assert.ok(!W.goodName('剣', 'ja'), 'one character');
    assert.ok(!W.goodName('', 'ja'));
    assert.ok(!W.goodName(fx.BAD.mount900.ja, 'ja'), 'too long');
    assert.ok(!W.goodName('【強化薬】グレード7', 'ja'));
    assert.ok(!W.goodName('黒衣森：中央森林', 'ja'));
    assert.ok(!W.goodName('chef <mécanique>', 'fr'));
    assert.ok(W.goodName('Maître d\'hast', 'fr') && W.goodName('Weißmagier', 'de'));
    assert.ok(!W.goodName('ナイト', 'fr'), 'no Japanese in a French name');
    assert.equal(W.cleanGameName('Schwarz<SoftHyphen/>magier[a]'), 'Schwarzmagier');
});

// ------------------------------------------------------------------ bank builder
test('bank: English pools are exactly what the old code made (snapshot)', () => {
    const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trivia-en-pools.json'), 'utf8'));
    const pools = W.buildPools(fx.rawFor('en'));
    const strip = p => Object.fromEntries(Object.entries(p).map(([k, l]) => [k, l.map(({ id, ...e }) => e)]));
    assert.deepEqual(strip(pools), snap);
    for (const l of Object.values(pools)) for (const e of l) assert.match(e.id, /^(job|place|region|duty|mount|minion|action|item):\w+$/);
});

test('bank: built from XIVAPI in 4 languages (mocked), names/clues/lore per language', async () => {
    resetBank();
    const calls = [];
    const real = env.xiv.get;
    env.xiv.get = url => { calls.push(url); return real(url); };
    let b;
    try { b = await T.buildBank(); } finally { env.xiv.get = real; }
    bankReady = Promise.resolve(b);
    assert.equal(b.format, T.BANK_FORMAT);
    assert.deepEqual(b.langs, ['en', 'fr', 'de', 'ja']);
    assert.ok(!b.incomplete);
    // every sheet was asked for in every language (Recipe only in English)
    for (const lang of ['fr', 'de', 'ja']) {
        for (const sheet of ['ClassJob', 'TerritoryType', 'ContentFinderCondition', 'Mount', 'Companion', 'Item', 'ActionTransient', 'MountTransient']) {
            assert.ok(calls.some(u => u.includes('/sheet/' + sheet + '?') && u.includes('language=' + lang)), sheet + ' ' + lang);
        }
        assert.ok(calls.some(u => u.includes('/search?') && u.includes('language=' + lang)), 'search ' + lang);
        assert.ok(!calls.some(u => u.includes('/sheet/Recipe?') && u.includes('language=' + lang)), 'no Recipe in ' + lang);
    }
    assert.ok(calls.some(u => u.includes('/sheet/Recipe?') && !u.includes('language=')));
    // English part is the same as an English-only build
    // (XIVAPI pages come sorted by row id)
    const sorted = Object.fromEntries(Object.entries(fx.rawFor('en')).map(([k, rows]) => [k, rows.slice().sort((a, c) => a.row_id - c.row_id)]));
    const enOnly = W.buildPools(sorted);
    for (const d of W.DIFFICULTIES) assert.deepEqual(b.pools[d.key].map(({ i18n: x, ...e }) => e), enOnly[d.key]);
    // translations
    const pld = b.pools.easy.find(e => e.id === 'job:19');
    assert.equal(pld.word, 'Paladin');
    assert.equal(pld.i18n.ja.word, 'ナイト');
    assert.equal(pld.i18n.fr.word, 'Paladin');
    assert.ok(pld.i18n.ja.hints.map(W.hintText).includes('ロール: タンク'));
    assert.ok(pld.i18n.ja.hints.map(W.hintText).includes('元のクラス: 剣術士'));
    assert.ok(pld.i18n.fr.hints.map(W.hintText).includes('Commence en tant que : Gladiateur'));
    assert.ok(pld.i18n.de.hints.map(W.hintText).includes('Rolle: Verteidiger'));
    assert.equal(pld.i18n.ja.lore, 'ナイト（ナ） — タンクのジョブ、元のクラスは剣術士。');
    const blm = b.pools.easy.find(e => e.id === 'job:25');
    assert.equal(blm.i18n.ja.word, '黒魔道士');
    assert.equal(blm.i18n.de.word, 'Schwarzmagier');
    assert.equal(blm.i18n.fr.word, 'Mage noir', 'French: only the first letter capitalised');
    const ring = b.pools.ultimate.find(e => e.id === 'item:7003');
    assert.ok(ring.i18n.ja.hints.map(W.hintText).includes('製作: 鍛冶師（エキスパートレシピ）'), 'crafter in Japanese from ClassJob');
    assert.ok(ring.i18n.fr.hints.map(W.hintText).some(h => /^Description : /.test(h)));
    const sas = b.pools.hard.find(e => e.id === 'duty:4');
    assert.equal(sas.i18n.ja.word, 'サスタシャ浸食洞');
    assert.ok(sas.i18n.ja.hints.map(W.hintText).includes('説明: 魔物と古い秘密に満ちた危険な場所。'), 'Japanese sentence cut at 。');
    assert.ok(sas.i18n.ja.lore.startsWith('ダンジョン · レベル15 · 新生エオルゼア\n'));
    // tiers decided by the English name: a long English mount is Ultimate in every language
    assert.ok(b.pools.ultimate.find(e => e.id === 'mount:101').i18n.ja, 'Magitek mount is Ultimate in ja too');
    // names that don't work in a language
    assert.ok(!b.pools.normal.find(e => e.id === 'mount:900').i18n.ja, 'too long in ja');
    assert.ok(!b.pools.normal.find(e => e.id === 'mount:901').i18n.ja, 'empty in ja');
    assert.ok(!b.pools.extreme.find(e => e.id === 'minion:902').i18n.fr, 'odd characters in fr');
    assert.ok(!b.pools.ultimate.find(e => e.id === 'item:903').i18n.ja);
    assert.ok(!b.pools.normal.some(e => e.id === 'place:54' && e.i18n.ja), '黒衣森：中央森林 has a full-width colon');
    // the saved file is the same bank
    assert.deepEqual(JSON.parse(fs.readFileSync(T.BANK_FILE, 'utf8')), JSON.parse(JSON.stringify(b)));
});

test('bank: a language that fails keeps the old bank, or saves an English bank marked incomplete', async () => {
    await ensureBank();
    const before = fs.readFileSync(T.BANK_FILE, 'utf8');
    const { makeFakeGet } = fx;
    const real = env.xiv.get;
    const quiet = console.error;
    console.error = () => {};
    try {
        env.xiv.get = makeFakeGet({ failLang: 'de' }).get;
        await assert.rejects(() => T.buildBank(), /languages missing: de/);
        assert.equal(fs.readFileSync(T.BANK_FILE, 'utf8'), before, 'old bank kept');
        resetBank();
        const b = await T.buildBank();
        assert.equal(b.incomplete, true);
        assert.deepEqual(b.langs, ['en', 'fr', 'ja']);
        assert.ok(T.bankIsOld(b), 'rebuilt on the next check');
        assert.ok(!b.pools.easy.some(W.isComplete), 'nothing is complete without de');
        assert.ok(T.dayPool(b, 'easy').length > 0, 'still playable (English for de players)');
    } finally {
        env.xiv.get = real;
        console.error = quiet;
        fs.writeFileSync(T.BANK_FILE, before);
        T._reset();
        bankReady = Promise.resolve(T.getBank());
    }
});

test('bank: the old bank file (format 3, English only) still works until the new one is built', async () => {
    const before = fs.readFileSync(T.BANK_FILE, 'utf8');
    const old = { builtAt: Date.now(), format: 3, pools: JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trivia-en-pools.json'), 'utf8')) };
    try {
        fs.writeFileSync(T.BANK_FILE, JSON.stringify(old));
        T._reset();
        const b = T.getBank();
        assert.ok(b && T.bankIsOld(b), 'loaded, and marked for a rebuild');
        const day = '2030-01-05';
        const words = await T.wordsOf(day);
        assert.ok(words && words.easy);
        assert.equal(words.easy.i18n, null);
        const v = W.viewOf(words.easy, 'ja');
        assert.equal(v.lang, 'en', 'shown in English to a Japanese player');
        assert.equal(v.word, words.easy.word);
        // the new bank arrives: the day's words get their other languages (English stays the same)
        fs.writeFileSync(T.BANK_FILE, before);
        T._reset();
        const again = await T.wordsOf(day);
        for (const d of W.DIFFICULTIES) {
            assert.equal(again[d.key].word, words[d.key].word);
            assert.deepEqual(again[d.key].hints, words[d.key].hints);
        }
        const upgraded = W.DIFFICULTIES.filter(d => again[d.key].i18n);
        assert.ok(upgraded.length > 0);
        for (const d of upgraded) assert.ok(['fr', 'de', 'ja'].every(l => again[d.key].i18n[l].word));
    } finally {
        fs.writeFileSync(T.BANK_FILE, before);
        T._reset();
    }
});

// ------------------------------------------------------------------ daily pick
test('daily pick: always a word whose name works in all 4 languages', async () => {
    const b = await ensureBank();
    for (const d of W.DIFFICULTIES) {
        const list = T.dayPool(b, d.key);
        assert.ok(list.length && list.every(W.isComplete), d.key);
        for (let k = 0; k < 400; k++) {
            const day = W.addDays('2027-01-01', k);
            const e = W.pickWord(list, day, d.key);
            assert.ok(!BAD_IDS.includes(e.id), d.key + ' ' + day + ' picked ' + e.id);
            for (const lang of LANGS) assert.ok(W.goodName(W.viewOf(e, lang).word, lang), lang + ' ' + e.id);
        }
    }
    // saved with all languages, the same id for everyone
    const words = await T.wordsOf('2027-03-03');
    for (const d of W.DIFFICULTIES) {
        const w = words[d.key];
        assert.ok(w.i18n && w.i18n.id, d.key);
        const e = b.pools[d.key].find(x => x.id === w.i18n.id);
        assert.equal(e.word, w.word);
        for (const lang of ['fr', 'de', 'ja']) assert.equal(w.i18n[lang].word, e.i18n[lang].word);
    }
});

// ------------------------------------------------------------------ game flows (commands/trivia.js)
async function openGame(opts, diffKey) {
    await ensureBank();
    const s = fakeSession(opts);
    await cmd.execute(s.interaction);
    await s.press('tv_play');
    await s.press('tv_d_' + diffKey);
    return s;
}
const playRow = (userId, diffKey) => env.db.tbl('trivia_plays').find(r => r.user_id === userId && r.day === W.dayOf() && r.difficulty === diffKey);
const userRow = userId => env.db.tbl('trivia_users').find(r => r.user_id === userId);

test('game in Japanese: wrong guess, hint, solve (typed in hiragana), rewards as in English', async () => {
    const userId = '500000000000000001';
    const s = await openGame({ userId, locale: 'ja' }, 'easy');
    const words = await T.wordsOf(W.dayOf());
    const v = W.viewOf(words.easy, 'ja');
    assert.equal(v.lang, 'ja');
    let screen = s.last();
    assert.match(screen.content, /ワード当てクイズ/);
    assert.match(screen.content, /🟢 \*\*イージー\*\* · 残りミス20回 · 💡 ヒント 3\/3/);
    assert.ok(screen.content.includes(W.renderBoxes(v.word, [], false, 'ja')), 'boxes of the Japanese name');
    assert.deepEqual(buttonsOf(screen).map(b => b.label), ['回答する', 'ヒント', 'ギブアップ', '戻る']);
    // hint
    screen = await s.press('tv_hint');
    const hint = playRow(userId, 'easy');
    const prog = JSON.parse(hint.lang_progress).ja;
    assert.equal(prog.hintsUsed.length, 1);
    assert.ok(screen.content.includes('💡 ' + W.hintText(v.hints[prog.hintsUsed[0]])));
    assert.equal(hint.hints_used, '[]', 'English progress untouched');
    // wrong guess
    screen = await s.press('tv_guess', 'まちがいです');
    assert.match(s.modals[0].data.title, /^あなたの答え（イージー）$/);
    assert.match(screen.content, /❌ 不正解 — \d+文字開きました。残りミス19回。/);
    const row = playRow(userId, 'easy');
    assert.equal(row.wrong, 1);
    assert.equal(row.hint_round, 0);
    const before = JSON.parse(row.lang_progress).ja.revealed;
    assert.ok(before.length >= 1);
    // solve, typed in hiragana
    const lp = W.letterPositions(v.word, 'ja');
    const expectBits = W.bitsFor('easy', lp.filter(i => !before.includes(i)).length, lp.length);
    screen = await s.press('tv_guess', toHiragana(v.word));
    assert.match(screen.content, /✅ \*\*正解！\*\* 🟢 イージー · \+(\d+)ビット/);
    assert.equal(Number(/\+(\d+)ビット/.exec(screen.content)[1]), expectBits);
    assert.ok(screen.content.includes('📖 **' + v.word + ' について**'));
    assert.ok(screen.content.includes(v.lore.split('\n')[0]));
    assert.match(screen.content, /🔥 連続 1日/);
    const u = userRow(userId);
    assert.equal(u.bits_total, expectBits);
    assert.equal(u.season_bits, expectBits);
    assert.equal(u.streak, 1);
    assert.equal(u.last_solve_day, W.dayOf());
    assert.equal(playRow(userId, 'easy').status, 'solved');
    // one solve a day, whatever the language
    const st = await T.startPlay(userId, W.dayOf(), 'hard', GUILD, 'en', words.hard);
    assert.equal(st.reason, 'solved');
    // home screen in Japanese with yesterday's answers etc.
    screen = await s.press('tv_home');
    assert.match(screen.content, /✅ 今日の \*\*イージー\*\* に正解しました（\+\d+ビット）/);
});

test('game in French: accents left out when typing, solve, rewards unchanged', async () => {
    const userId = '500000000000000002';
    const s = await openGame({ userId, locale: 'fr' }, 'normal');
    const words = await T.wordsOf(W.dayOf());
    const v = W.viewOf(words.normal, 'fr');
    assert.equal(v.lang, 'fr');
    let screen = s.last();
    assert.match(screen.content, /🔵 \*\*Normal\*\* · 15 erreurs restantes · 💡 3\/3 indices/);
    screen = await s.press('tv_hint');
    assert.ok(/💡 .+/.test(screen.content.split('\n').slice(4).join('\n')));
    screen = await s.press('tv_guess', 'pas du tout ça');
    assert.equal(s.modals[0].data.title, 'Votre réponse (Normal)');
    assert.equal(s.modals[0].components[0].components[0].data.label, 'Tapez la réponse entière');
    assert.match(screen.content, /❌ Raté — \d+ lettres? dévoilées?\. 14 erreurs restantes\./);
    const revealed = JSON.parse(playRow(userId, 'normal').lang_progress).fr.revealed;
    const lp = W.letterPositions(v.word, 'fr');
    const expectBits = W.bitsFor('normal', lp.filter(i => !revealed.includes(i)).length, lp.length);
    const typed = v.word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[-'’]/g, ' ');
    screen = await s.press('tv_guess', typed);
    assert.match(screen.content, /✅ \*\*Trouvé !\*\* 🔵 Normal · \+(\d+) bits \(base 2, bonus \d+\)/);
    assert.equal(userRow(userId).bits_total, expectBits);
    assert.match(screen.content, /🔥 Série de 1 jour/);
    assert.ok(screen.content.includes('C\'est tout pour aujourd\'hui'));
});

test('switching language mid-day: same game, letters carried over, bits never higher, one lock', async () => {
    const userId = '500000000000000003';
    const day = W.dayOf();
    const words = await (await ensureBank(), T.wordsOf(day));
    const word = words.savage;
    // English: two wrong guesses
    let r = await T.startPlay(userId, day, 'savage', GUILD, 'en', word);
    assert.ok(r.ok);
    await T.guess(userId, day, 'savage', word, 'nothing at all', 'en');
    await T.guess(userId, day, 'savage', word, 'still nothing', 'en');
    await T.useHint(userId, day, 'savage', word, 'en');
    const enRow = Object.assign({}, playRow(userId, 'savage'));
    const enRevealed = JSON.parse(enRow.revealed);
    const enLetters = W.letterPositions(word.word).length;
    assert.equal(enRow.lang_progress, null, 'English-only game: no lang_progress');
    // Japanese: same game (same wrong count, same hint count), letters opened with the same share
    r = await T.startPlay(userId, day, 'savage', GUILD, 'ja', word);
    assert.ok(r.ok);
    assert.equal(r.play.lang, 'ja');
    assert.equal(r.play.wrong, 2);
    assert.equal(r.play.hintsLeft, enRow.hint_round ? W.HINTS_PER_GUESS - enRow.hint_round : W.HINTS_PER_GUESS);
    const jaLetters = W.letterPositions(W.viewOf(word, 'ja').word, 'ja').length;
    assert.equal(r.play.revealed.length, Math.min(jaLetters - 1, Math.round(enRevealed.length / enLetters * jaLetters)));
    assert.deepEqual(r.play.started.sort(), ['en', 'ja']);
    assert.equal(playRow(userId, 'savage').revealed, enRow.revealed, 'English progress kept');
    // back to English: nothing lost
    const back = await T.startPlay(userId, day, 'savage', GUILD, 'en', word);
    assert.deepEqual(back.play.revealed, enRevealed);
    // solve in Japanese: bits from the language with the most letters shown
    const jaRev = r.play.revealed.length / jaLetters;
    const enRev = enRevealed.length / enLetters;
    const basis = jaRev >= enRev ? [jaLetters - r.play.revealed.length, jaLetters] : [enLetters - enRevealed.length, enLetters];
    const res = await T.guess(userId, day, 'savage', word, W.viewOf(word, 'ja').word, 'ja');
    assert.equal(res.result, 'solved');
    assert.equal(res.award.bits, W.bitsFor('savage', basis[0], basis[1]));
    assert.ok(res.award.bits <= W.bitsFor('savage', enLetters - enRevealed.length, enLetters));
    // the daily lock is shared
    const fr = await T.startPlay(userId, day, 'easy', GUILD, 'fr', words.easy);
    assert.equal(fr.reason, 'solved');
    const again = await T.guess(userId, day, 'savage', word, word.word, 'en');
    assert.equal(again.result, 'locked');
});

test('share: the public post uses the server language, the reply the player language', async () => {
    const userId = '500000000000000004';
    env.db.tbl('trivia_guild').push({ guild_id: GUILD, share_channel_id: CHANNEL, updated_at: 0 });
    const posts = [];
    const channel = { id: CHANNEL, send: async p => { posts.push(p); } };
    const s = await openGame({ userId, locale: 'ja', guildLocale: 'de', channel }, 'extreme');
    const words = await T.wordsOf(W.dayOf());
    let screen = await s.press('tv_hint');
    screen = await s.press('tv_guess', W.viewOf(words.extreme, 'ja').word);
    assert.ok(buttonsOf(screen).some(b => b.id === 'tv_share' && b.label === '結果をシェア'));
    screen = await s.press('tv_share');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].content, '🧩 **Tester** hat das heutige Pingway-Trivia-Wort in **Extrem** in 1 Versuch mit 1 Tipp gelöst!\n' +
        '-# Kannst du das schlagen? Nutze **/trivia**, um das FFXIV-Wort des Tages zu erraten, Bits zu sammeln und deine Serie aufzubauen!');
    assert.deepEqual(posts[0].allowedMentions, { parse: [] });
    assert.ok(screen.content.endsWith('📣 <#' + CHANNEL + '> にシェアしました！'));
    assert.ok(!posts[0].content.includes(W.viewOf(words.extreme, 'de').word), 'no spoiler');
    // English server: exactly the old English line
    assert.equal(T.shareLine('Tester', 'extreme', { wrong: 1, hintsUsed: [3, 4], hintsAll: 2 }, 3, 'en'),
        '🧩 **Tester** solved today\'s **Extreme** Pingway Trivia in 2 guesses with 2 hints! 🔥 Streak 3\n' +
        '-# Think you can beat that? Use **/trivia** to guess today\'s FFXIV word, earn bits and build your streak!');
    assert.equal(T.shareLine('A*B', 'easy', { wrong: 0, hintsUsed: [] }, 1), '🧩 **A\\*B** solved today\'s **Easy** Pingway Trivia in 1 guess with no hints!\n' +
        '-# Think you can beat that? Use **/trivia** to guess today\'s FFXIV word, earn bits and build your streak!');
    assert.match(T.shareLine('X', 'savage', { wrong: 2, hintsUsed: [] }, 2, 'fr'), /^🧩 \*\*X\*\* a trouvé le mot \*\*Sadique\*\* du jour de Pingway Trivia en 3 essais sans indice ! 🔥 Série 2\n/);
    assert.match(T.shareLine('X', 'ultimate', { wrong: 0, hintsUsed: [] }, 0, 'ja'), /^🧩 \*\*X\*\* さんが今日の Pingway Trivia \*\*絶\*\* に1回で正解しました（ヒントなし）！\n/);
});

test('English screens are unchanged (start, menu, how to play)', async () => {
    const userId = '500000000000000005';
    await ensureBank();
    const s = fakeSession({ userId, locale: 'en-GB', guildId: null });
    await cmd.execute(s.interaction);
    const home = s.last().content.split('\n');
    assert.equal(home[0], '🧩 **Pingway Trivia — Guess the word**');
    assert.equal(home[1], 'Guess the FFXIV word of the day. 6 difficulties, each with its own word. One solve a day, in every server.');
    assert.equal(home[3], '**You:** 🔥 Streak 0 · 💎 0 bits this month · 0 all time');
    assert.match(home[4], /^⏳ New words in (\d+ h )?\d+ min \(0:00 JST\)\.$/);
    assert.deepEqual(buttonsOf(s.last()).map(b => b.label), ['Play', 'How to play']);
    const how = (await s.press('tv_howto')).content;
    assert.ok(how.includes('🟢 Easy: 1 bit, 20 wrong guesses · 🔵 Normal: 2 bits, 15 wrong guesses · 🟡 Hard: 4 bits, 12 wrong guesses'));
    assert.ok(how.includes('• **Hint:** up to 3 per guess (resets after each wrong guess).'));
    const menu = (await s.press('tv_play')).content;
    assert.ok(menu.includes('🟢 **Easy** · 1 bit · 20 guesses — new\n🔵 **Normal** · 2 bits · 15 guesses — new'));
    const game = (await s.press('tv_d_ultimate')).content;
    assert.match(game, /🟣 \*\*Ultimate\*\* · 5 wrong guesses left · 💡 3\/3 hints/);
    const words = await T.wordsOf(W.dayOf());
    assert.ok(game.includes(W.renderBoxes(words.ultimate.word, [])), 'English name, 🇦 boxes');
    assert.equal(playRow(userId, 'ultimate').lang_progress, null, 'English game saved as before');
    const wrong = (await s.press('tv_guess', 'zzzz')).content;
    assert.match(wrong, /❌ Not it — revealed \d+ letters?\. 4 wrong guesses left\./);
    assert.equal(s.modals[0].data.title, 'Your guess (Ultimate)');
});

test('reward DM: player language; English text unchanged', () => {
    assert.equal(R.rewardMessage(1234, 10, '2026-11'), '🎉 Congratulations! You earned **1,234 bits** in Pingway Trivia in November 2026 — here are **10 points** as a thank-you. ' +
        'Use them for extra retainers or Supporter Perks at https://pingway.app/me.html');
    assert.equal(R.rewardMessage(1234, 10, '2026-11', 'en'), R.rewardMessage(1234, 10, '2026-11'));
    assert.match(R.rewardMessage(1234, 5, '2026-11', 'fr'), /^🎉 Félicitations ! Vous avez gagné \*\*1 234 bits\*\* dans Pingway Trivia en novembre 2026 — voici \*\*5 points\*\*/);
    assert.match(R.rewardMessage(1234, 5, '2026-12', 'de'), /im Dezember 2026 \*\*1\.234 Bits\*\*/);
    assert.match(R.rewardMessage(1234, 5, '2027-01', 'ja'), /^🎉 おめでとうございます！2027年1月の Pingway Trivia で \*\*1,234ビット\*\*/);
    assert.equal(R.seasonName('2026-11'), 'November 2026');
});
