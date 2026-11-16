// IGN Card: Tomestone / FFLogs links must belong to the claimed character (utils/ignLinks.js, the same file as the website's
// lib/ignLinks.js). The checker, /ignconfig's Tomestone / FFLogs modals + dashboard note, the /ign card and Boards sign-up DMs
// (older links that don't match are kept in the database but never shown or sent).
// In-memory database (test/fixtures/ign-fakedb.js), no Discord / network.
// Run: node --test test/ign-links.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}

// ---------- stand-ins ----------
class FakeEmbed {
    constructor() { this.data = {}; }
    setTitle(v) { this.data.title = v; return this; }
    setColor(v) { this.data.color = v; return this; }
    setDescription(v) { this.data.description = v; return this; }
    addFields(...f) { this.data.fields = f.flat(); return this; }
}
class FakeButton {
    constructor() { this.data = {}; }
    setCustomId(v) { this.data.custom_id = v; return this; }
    setLabel(v) { this.data.label = v; return this; }
    setStyle(v) { this.data.style = v; return this; }
}
class FakeRow { constructor() { this.components = []; } addComponents(...c) { this.components.push(...c.flat()); return this; } }
const builder = () => new Proxy({}, { get: (o, k) => (k === 'then' ? undefined : () => builder()) });
const qrCalls = [];
// sharp stand-in: every step chains, toBuffer() gives a tiny buffer (the card itself isn't checked here)
const fakeSharp = () => new Proxy({}, { get: (o, k) => (k === 'then' ? undefined : k === 'toBuffer' ? async () => Buffer.from('x') : k === 'metadata' ? async () => ({ width: 10, height: 10 }) : () => fakeSharp()) });
const shims = {
    axios: { get: async () => { throw new Error('offline'); } },
    'discord.js': {
        EmbedBuilder: FakeEmbed, ButtonBuilder: FakeButton, ActionRowBuilder: FakeRow, AttachmentBuilder: function () {},
        SlashCommandBuilder: function () { return builder(); }, ModalBuilder: function () { return builder(); }, TextInputBuilder: function () { return builder(); },
        StringSelectMenuBuilder: function () { return builder(); }, StringSelectMenuOptionBuilder: function () { return builder(); },
        TextInputStyle: { Short: 1 }, ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 }, MessageFlags: { Ephemeral: 64 }
    },
    cheerio: {}, sharp: function () { return fakeSharp(); },
    qrcode: { toBuffer: async url => { qrCalls.push(url); throw new Error('no QR in tests'); } }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (shims[request]) return 'shim:' + request;
    return origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);

const { makeDb } = require('./fixtures/ign-fakedb');
let { db, pool } = makeDb();
const livePool = { execute: (...a) => pool.execute(...a), getConnection: () => pool.getConnection() };
inject(path.join(ROOT, 'utils', 'db.js'), { pool: livePool });
inject(path.join(ROOT, 'utils', 'membership.js'), { ownerHasMembership: async () => false, sponsorHasPerks: async () => false, findPerksAdmin: async () => null });
let userLang = 'en';
inject(path.join(ROOT, 'utils', 'userLanguage.js'), { forInteraction: async () => userLang, forUser: async () => userLang, forGuild: async () => 'en' });
inject(path.join(ROOT, 'maintenance.js'), { isMaintenance: () => false });

const L = require('../utils/ignLinks');
const C = require('../utils/ignClaims');
const ignconfig = require('../commands/ignconfig');
const ign = require('../commands/ign');
const BD = require('../utils/boards');
const { t } = require('../utils/i18n');

const U = '200000000000000001';
const KRO = { lodestoneId: '1612443', name: 'Kro Lex', world: 'Gilgamesh [Aether]' };
const ok = (url, kind, ch) => { const r = L.check(url, kind, ch || KRO); assert.equal(r.ok, true, url + ' -> ' + JSON.stringify(r)); return r.normalizedUrl; };
const bad = (url, kind, ch) => { const r = L.check(url, kind, ch || KRO); assert.equal(r.ok, false, url + ' should fail'); return r; };

// ================= the checker =================
test('Tomestone: /character/<LodestoneID>/<anything>, normalized to tomestone.gg/character/<id>/<slug>', () => {
    assert.equal(ok('https://tomestone.gg/character/1612443/kro-lex', 'tomestone'), 'https://tomestone.gg/character/1612443/kro-lex');
    assert.equal(ok('https://tomestone.gg/character/1612443/x', 'tomestone'), 'https://tomestone.gg/character/1612443/x');
    assert.equal(ok('https://tomestone.gg/character/1612443/x/progress/raids?tab=1#top', 'tomestone'), 'https://tomestone.gg/character/1612443/x', 'more path + query / fragment dropped');
    assert.equal(ok('https://tomestone.gg/character/1612443', 'tomestone'), 'https://tomestone.gg/character/1612443/kro-lex', 'no slug -> made from the name');
    assert.equal(ok('https://tomestone.gg/character/1612443/', 'tomestone', { lodestoneId: '1612443' }), 'https://tomestone.gg/character/1612443/x', 'no name known');
    assert.equal(ok('  https://www.tomestone.gg/character/1612443/kro-lex  ', 'tomestone'), 'https://tomestone.gg/character/1612443/kro-lex');
    assert.equal(bad('https://tomestone.gg/character/1612444/kro-lex', 'tomestone').code, 'wrong_character', 'a wrong id');
    assert.equal(bad('https://tomestone.gg/character/1612443/x', 'tomestone', {}).code, 'wrong_character', 'no character linked');
    assert.equal(bad('http://tomestone.gg/character/1612443/kro-lex', 'tomestone').code, 'not_https');
    assert.equal(bad('https://tomestone.gg.evil.test/character/1612443/x', 'tomestone').code, 'wrong_site');
    assert.equal(bad('https://evil.test/character/1612443/x', 'tomestone').code, 'wrong_site');
    assert.equal(bad('https://www.fflogs.com/character/lodestone-id/1612443', 'tomestone').code, 'wrong_site');
    assert.equal(bad('https://tomestone.gg/c/1612443', 'tomestone').code, 'bad_format');
    assert.equal(bad('https://tomestone.gg/character/kro-lex', 'tomestone').code, 'bad_format');
    assert.equal(bad('tomestone.gg/character/1612443/x', 'tomestone').code, 'bad_format');
    assert.equal(bad('', 'tomestone').code, 'bad_format');
});

test('FFLogs (a): /character/lodestone-id/<id>, every FFLogs host, the host given is kept', () => {
    for (const h of ['www.fflogs.com', 'fflogs.com', 'de.fflogs.com', 'fr.fflogs.com', 'ja.fflogs.com', 'ko.fflogs.com', 'cn.fflogs.com']) {
        assert.equal(ok('https://' + h + '/character/lodestone-id/1612443', 'fflogs'), 'https://' + h + '/character/lodestone-id/1612443');
    }
    assert.equal(ok('https://www.fflogs.com/character/lodestone-id/1612443/?zone=1#x', 'fflogs'), 'https://www.fflogs.com/character/lodestone-id/1612443');
    const w = bad('https://www.fflogs.com/character/lodestone-id/999', 'fflogs');
    assert.deepEqual(w, { ok: false, code: 'wrong_character', suggest: 'https://www.fflogs.com/character/lodestone-id/1612443' });
    assert.equal(bad('http://www.fflogs.com/character/lodestone-id/1612443', 'fflogs').code, 'not_https');
    assert.equal(bad('https://en.fflogs.com/character/lodestone-id/1612443', 'fflogs').code, 'wrong_site', 'not one of the language hosts');
    assert.equal(bad('https://fflogs.com.evil.test/character/lodestone-id/1612443', 'fflogs').code, 'wrong_site');
    assert.equal(bad('https://www.warcraftlogs.com/character/lodestone-id/1612443', 'fflogs').code, 'wrong_site');
    assert.equal(bad('https://tomestone.gg/character/1612443/x', 'fflogs').code, 'wrong_site');
    assert.equal(bad('https://www.fflogs.com/character/lodestone-id/abc', 'fflogs').code, 'bad_format');
    assert.equal(bad('https://www.fflogs.com/reports/abc', 'fflogs').code, 'bad_format');
});

test('FFLogs (b): /character/<region>/<world>/<name> by world + name (case, %20, +, spaces) and the world\'s region', () => {
    assert.equal(ok('https://www.fflogs.com/character/na/gilgamesh/kro%20lex', 'fflogs'), 'https://www.fflogs.com/character/na/gilgamesh/kro%20lex');
    assert.equal(ok('https://www.fflogs.com/character/na/Gilgamesh/Kro+Lex', 'fflogs'), 'https://www.fflogs.com/character/na/Gilgamesh/Kro+Lex');
    assert.equal(ok('https://fr.fflogs.com/character/NA/GILGAMESH/KRO%20LEX/', 'fflogs'), 'https://fr.fflogs.com/character/NA/GILGAMESH/KRO%20LEX');
    assert.equal(ok('https://www.fflogs.com/character/na/gilgamesh/kro lex', 'fflogs'), 'https://www.fflogs.com/character/na/gilgamesh/kro%20lex', 'a typed space');
    assert.equal(ok('https://www.fflogs.com/character/na/gilgamesh/%20kro%20%20lex%20', 'fflogs'), 'https://www.fflogs.com/character/na/gilgamesh/%20kro%20%20lex%20', 'trimmed');
    ok('https://www.fflogs.com/character/na/gilgamesh/kro%20lex', 'fflogs', { lodestoneId: '1', name: 'Kro Lex', world: 'Gilgamesh (Aether)' });
    ok('https://www.fflogs.com/character/na/gilgamesh/kro%20lex', 'fflogs', { lodestoneId: '1', name: 'Kro Lex', world: 'Gilgamesh' });
    // the other regions
    ok('https://www.fflogs.com/character/eu/cerberus/a%20b', 'fflogs', { lodestoneId: '1', name: 'A B', world: 'Cerberus [Chaos]' });
    ok('https://ja.fflogs.com/character/jp/titan/a%20b', 'fflogs', { lodestoneId: '1', name: 'A B', world: 'Titan [Mana]' });
    ok('https://www.fflogs.com/character/oc/ravana/a%20b', 'fflogs', { lodestoneId: '1', name: 'A B', world: 'Ravana [Materia]' });
    // wrong world / name / region
    const s = { suggest: 'https://www.fflogs.com/character/lodestone-id/1612443' };
    assert.deepEqual(bad('https://www.fflogs.com/character/na/sargatanas/kro%20lex', 'fflogs'), { ok: false, code: 'wrong_world', ...s }, 'the wrong world');
    assert.deepEqual(bad('https://www.fflogs.com/character/na/gilgamesh/kro%20lexx', 'fflogs'), { ok: false, code: 'wrong_world', ...s }, 'the wrong name');
    assert.deepEqual(bad('https://www.fflogs.com/character/eu/gilgamesh/kro%20lex', 'fflogs'), { ok: false, code: 'wrong_world', ...s }, 'the wrong region for the world');
    assert.equal(bad('https://www.fflogs.com/character/jp/gilgamesh/kro%20lex', 'fflogs').code, 'wrong_world');
    assert.equal(bad('https://www.fflogs.com/character/xx/gilgamesh/kro%20lex', 'fflogs').code, 'bad_format', 'not a region');
    assert.equal(bad('https://www.fflogs.com/character/na/gilgamesh/kro%E0%A4%A', 'fflogs').code, 'bad_format', 'broken %');
    // a character with no name / world saved yet (older card, not verified): only lodestone-id links can be checked
    assert.equal(bad('https://www.fflogs.com/character/na/gilgamesh/kro%20lex', 'fflogs', { lodestoneId: '1612443' }).code, 'wrong_world');
    ok('https://www.fflogs.com/character/lodestone-id/1612443', 'fflogs', { lodestoneId: '1612443' });
    // a world that isn't in the list yet (a new one): world + name are enough
    ok('https://www.fflogs.com/character/na/newworld/kro%20lex', 'fflogs', { lodestoneId: '1', name: 'Kro Lex', world: 'Newworld [Next]' });
});

test('FFLogs (c): /character/id/<FFLogs id> can\'t be checked -> refused with the lodestone-id link of this character', () => {
    assert.deepEqual(bad('https://www.fflogs.com/character/id/12345678', 'fflogs'), { ok: false, code: 'unverifiable_id', suggest: 'https://www.fflogs.com/character/lodestone-id/1612443' });
    assert.equal(bad('https://de.fflogs.com/character/id/1', 'fflogs').code, 'unverifiable_id');
});

test('always: https, no user / password / port, 300 characters at most', () => {
    assert.equal(bad('https://user:pw@www.fflogs.com/character/lodestone-id/1612443', 'fflogs').code, 'bad_format');
    assert.equal(bad('https://user@tomestone.gg/character/1612443/x', 'tomestone').code, 'bad_format');
    assert.equal(bad('https://tomestone.gg:8443/character/1612443/x', 'tomestone').code, 'bad_format');
    assert.equal(bad('javascript:alert(1)', 'tomestone').code, 'not_https');
    assert.equal(bad('ftp://tomestone.gg/character/1612443/x', 'tomestone').code, 'not_https');
    const long = 'https://tomestone.gg/character/1612443/' + 'x'.repeat(300);
    assert.equal(bad(long, 'tomestone').code, 'bad_format');
    assert.equal(ok('https://tomestone.gg/character/1612443/' + 'x'.repeat(300 - 39), 'tomestone').length, 300);
    assert.equal(bad('https://tomestone.gg//character/1612443/x', 'tomestone').code, 'bad_format');
    assert.equal(bad('https://tomestone.gg/character/1612443/x', 'other').code, 'wrong_site');
    assert.equal(L.usable('', 'tomestone', KRO), '');
    assert.equal(L.usable(null, 'fflogs', KRO), '');
    assert.equal(L.usable('https://tomestone.gg/character/1/x', 'tomestone', KRO), '');
});

test('the world list is the same as data/datacenter.json; the file is the same as the website\'s lib/ignLinks.js', () => {
    const dc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'datacenter.json'), 'utf8')).regions;
    const map = { 'North America (NA)': 'na', 'Europe (EU)': 'eu', 'Oceania (OCE)': 'oc', 'Japan (JP)': 'jp' };
    assert.deepEqual(Object.keys(dc).map(r => map[r]).sort(), Object.keys(L.REGION_WORLDS).sort());
    for (const [region, dcs] of Object.entries(dc)) {
        assert.deepEqual(Object.values(dcs).flat().sort(), L.REGION_WORLDS[map[region]].slice().sort(), region);
    }
    const site = path.join(ROOT, '..', 'pingway-dashboard', 'lib', 'ignLinks.js');
    if (fs.existsSync(site)) assert.equal(fs.readFileSync(path.join(ROOT, 'utils', 'ignLinks.js'), 'utf8'), fs.readFileSync(site, 'utf8'));
});

// ================= /ignconfig =================
const reset = () => { ({ db, pool } = makeDb()); C._reset(); global.ignSessions = {}; userLang = 'en'; qrCalls.length = 0; };
function interaction(kind, customId, extra = {}) {
    const out = { replies: [], updates: [], edits: [], followUps: [] };
    const i = Object.assign({
        user: { id: U }, customId, guildId: null, locale: 'en-US',
        isModalSubmit: () => kind === 'modal', isStringSelectMenu: () => false, isButton: () => kind === 'button',
        fields: { getTextInputValue: () => extra.input || '' },
        async reply(x) { out.replies.push(x); this.replied = true; }, async update(x) { out.updates.push(x); },
        async editReply(x) { out.edits.push(x); }, async followUp(x) { out.followUps.push(x); },
        async deferUpdate() { this.deferred = true; }, async showModal() {}, async deleteReply() {}
    }, extra);
    i.out = out;
    return i;
}
// a verified Main (Kro Lex @ Gilgamesh) with an older Tomestone link for another character
function seedKro(extra) {
    const row = Object.assign({ id: 1, user_id: U, lodestone_id: '1612443', claim_key: '1612443', is_main: 1, position: 0, character_name: 'Kro Lex', world: 'Gilgamesh [Aether]',
        main_job: 'Sage', portrait_url: null, full_photo_url: null, portrait_toggle: 1, tomestone_url: 'https://tomestone.gg/character/1/someone-else', fflogs_url: null,
        show_tomestone: 1, show_fflogs: 1, show_photo: 1, verified_at: 1 }, extra);
    db.chars.push(row);
    db.config.set(U, { user_id: U, lodestone_id: row.lodestone_id, main_job: row.main_job, portrait_url: null, full_photo_url: null, portrait_toggle: 1, tomestone_url: row.tomestone_url, fflogs_url: row.fflogs_url });
    global.ignSessions[U] = { lodestone_id: row.lodestone_id, main_job: row.main_job, portrait_url: '', full_photo_url: '', portrait_toggle: true, tomestone_url: row.tomestone_url || '', fflogs_url: row.fflogs_url || '' };
    return row;
}
const field = (i, key) => i.out.edits[0].embeds[0].data.fields.find(f => f.name === t(userLang, 'ignconfig.fields.' + key)).value;

test('/ignconfig Tomestone / FFLogs modals: only this character\'s links are saved (normalized); a bad one = ephemeral error, old value kept', async () => {
    reset();
    seedKro({ tomestone_url: 'https://tomestone.gg/character/1612443/kro-lex' });
    // wrong character: refused, nothing saved
    let i = interaction('modal', 'ign_modal_tomestone', { input: 'https://tomestone.gg/character/999/x' });
    await ignconfig.handleModal(i);
    assert.deepEqual(i.out.followUps, [{ content: t('en', 'ignconfig.links.wrongCharacter.tomestone'), flags: [64] }]);
    assert.equal(global.ignSessions[U].tomestone_url, 'https://tomestone.gg/character/1612443/kro-lex');
    assert.equal(db.config.get(U).tomestone_url, 'https://tomestone.gg/character/1612443/kro-lex');
    // every error, in the user's language
    const cases = [
        ['ign_modal_tomestone', 'http://tomestone.gg/character/1612443/x', 'ignconfig.links.notHttps'],
        ['ign_modal_tomestone', 'https://evil.test/character/1612443/x', 'ignconfig.links.wrongSite.tomestone'],
        ['ign_modal_tomestone', 'https://tomestone.gg/profile', 'ignconfig.links.badFormat.tomestone'],
        ['ign_modal_fflogs', 'https://www.warcraftlogs.com/character/id/1', 'ignconfig.links.wrongSite.fflogs'],
        ['ign_modal_fflogs', 'https://www.fflogs.com/character/lodestone-id/5', 'ignconfig.links.wrongCharacter.fflogs'],
        ['ign_modal_fflogs', 'https://www.fflogs.com/character/na/sargatanas/kro%20lex', 'ignconfig.links.wrongWorld'],
        ['ign_modal_fflogs', 'https://www.fflogs.com/character/eu/gilgamesh/kro%20lex', 'ignconfig.links.wrongWorld'],
        ['ign_modal_fflogs', 'https://www.fflogs.com/foo', 'ignconfig.links.badFormat.fflogs']
    ];
    for (const lang of ['en', 'fr', 'de', 'ja']) {
        userLang = lang;
        for (const [id, input, key] of cases) {
            i = interaction('modal', id, { input });
            await ignconfig.handleModal(i);
            assert.equal(i.out.followUps[0].content, t(lang, key), lang + ' ' + input);
            assert.equal(i.out.followUps[0].flags[0], 64);
        }
        i = interaction('modal', 'ign_modal_fflogs', { input: 'https://www.fflogs.com/character/id/777' });
        await ignconfig.handleModal(i);
        assert.equal(i.out.followUps[0].content, t(lang, 'ignconfig.links.unverifiableId', { link: 'https://www.fflogs.com/character/lodestone-id/1612443' }));
        assert.ok(i.out.followUps[0].content.includes('https://www.fflogs.com/character/lodestone-id/1612443'));
    }
    userLang = 'en';
    assert.equal(db.chars[0].fflogs_url, null, 'nothing saved by the refused links');
    // good links: saved normalized, on the character too
    i = interaction('modal', 'ign_modal_fflogs', { input: 'https://fr.fflogs.com/character/na/Gilgamesh/Kro+Lex?zone=62' });
    await ignconfig.handleModal(i);
    assert.equal(i.out.followUps.length, 0);
    assert.equal(db.config.get(U).fflogs_url, 'https://fr.fflogs.com/character/na/Gilgamesh/Kro+Lex');
    assert.equal(db.chars[0].fflogs_url, 'https://fr.fflogs.com/character/na/Gilgamesh/Kro+Lex');
    i = interaction('modal', 'ign_modal_tomestone', { input: 'https://tomestone.gg/character/1612443' });
    await ignconfig.handleModal(i);
    assert.equal(db.chars[0].tomestone_url, 'https://tomestone.gg/character/1612443/kro-lex');
    // blank = cleared
    await ignconfig.handleModal(interaction('modal', 'ign_modal_fflogs', { input: '' }));
    assert.equal(db.chars[0].fflogs_url, null);
});

test('/ignconfig dashboard: a saved link of another character is kept but has the ⚠ note (4 languages)', async () => {
    for (const lang of ['en', 'fr', 'de', 'ja']) {
        reset();
        userLang = lang;
        seedKro({ fflogs_url: 'https://www.fflogs.com/character/id/42' });
        const i = interaction('button', 'ign_btn_back_dashboard');
        i.deferred = true;
        await ignconfig.handleButton(i);
        assert.equal(field(i, 'tomestone'), 'https://tomestone.gg/character/1/someone-else\n' + t(lang, 'ignconfig.links.mismatch.tomestone'));
        assert.equal(field(i, 'fflogs'), 'https://www.fflogs.com/character/id/42\n' + t(lang, 'ignconfig.links.mismatch.fflogs'));
        assert.equal(db.chars[0].tomestone_url, 'https://tomestone.gg/character/1/someone-else', 'not deleted');
    }
    assert.ok(t('fr', 'ignconfig.links.mismatch.tomestone').includes('corrige-le'), 'FR uses tu');
    assert.ok(t('de', 'ignconfig.links.mismatch.tomestone').includes('korrigiere'), 'DE uses du');
    assert.equal(t('en', 'ignconfig.links.mismatch.tomestone'), "⚠ Your Tomestone link doesn't match this character; fix it to show it again.");
    // a matching one: no note
    reset();
    seedKro({ tomestone_url: 'https://tomestone.gg/character/1612443/kro-lex' });
    const i = interaction('button', 'ign_btn_back_dashboard');
    i.deferred = true;
    await ignconfig.handleButton(i);
    assert.equal(field(i, 'tomestone'), 'https://tomestone.gg/character/1612443/kro-lex');
    assert.equal(field(i, 'fflogs'), t('en', 'ignconfig.noneSet'));
});

// ================= /ign card + Boards sign-up DMs =================
test('the IGN card (/ign, Boards) only draws links that belong to the character', async () => {
    reset();
    const data = { name: 'Kro Lex', world: 'Gilgamesh', datacenter: 'Aether', jobLevels: [] };
    await ign.generateCard({ lodestone_id: '1612443', tomestone_url: 'https://tomestone.gg/character/1/someone-else', fflogs_url: 'https://www.fflogs.com/character/id/9', portrait_toggle: 1 }, data).catch(() => {});
    const linkQrs = () => qrCalls.filter(u => /tomestone|fflogs/.test(u));
    assert.ok(qrCalls.length > 0, 'the card was drawn (Lodestone QR)');
    assert.deepEqual(linkQrs(), [], 'no QR code for links of another character');
    await ign.generateCard({ lodestone_id: '1612443', tomestone_url: 'https://tomestone.gg/character/1612443/kro-lex', fflogs_url: 'https://www.fflogs.com/character/na/gilgamesh/kro%20lex', portrait_toggle: 1 }, data).catch(() => {});
    assert.deepEqual(linkQrs(), ['https://tomestone.gg/character/1612443/kro-lex', 'https://www.fflogs.com/character/na/gilgamesh/kro%20lex']);
});

test('Boards sign-up DM: FFLogs / Tomestone only when they belong to the sign-up\'s character', async () => {
    const p = { id: 1, kind: 'lfm', owner_id: '100000000000000001', title: 'Static' };
    const s = o => Object.assign({ id: 7, poster_id: 1, user_id: U, user_name: 'Kro', lodestone_id: '1612443', char_name: 'Kro Lex', char_world: 'Gilgamesh [Aether]', send_card: 0 }, o);
    let m = await BD.signupMessage({}, 'en', p, s({ fflogs_url: 'https://www.fflogs.com/character/id/9', tomestone_url: 'https://tomestone.gg/character/1/x' }), null, false);
    let d = m.embeds[0].description;
    assert.ok(!d.includes('fflogs.com') && !d.includes('tomestone.gg'), d);
    m = await BD.signupMessage({}, 'en', p, s({ fflogs_url: 'https://www.fflogs.com/character/na/gilgamesh/kro%20lex', tomestone_url: 'https://tomestone.gg/character/1612443/kro-lex' }), null, false);
    d = m.embeds[0].description;
    assert.ok(d.includes('https://www.fflogs.com/character/na/gilgamesh/kro%20lex') && d.includes('https://tomestone.gg/character/1612443/kro-lex'), d);
    m = await BD.signupMessage({}, 'en', p, s({ fflogs_url: 'https://www.fflogs.com/character/eu/gilgamesh/kro%20lex' }), null, true);
    assert.ok(!m.embeds[0].description.includes('fflogs.com'), 'the channel post too');
});
