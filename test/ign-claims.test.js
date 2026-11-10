// Pingway v2.2 Part 5.6 (bot side): IGN Card claims (utils/ignClaims.js, same rules as the website's lib/ign.js),
// /ignconfig "Link Lodestone" -> claim code -> "✅ Verify", /ign shows the Main with the website switches (cardConfig);
// and 5.7: the Firmament DM scheduler picks up timers changed on the website (it reads the database every tick).
// Saved Lodestone pages (test/fixtures/lodestone-*.html), an in-memory database (test/fixtures/ign-fakedb.js), no Discord / network.
// Run: node --test test/ign-claims.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FX = path.join(__dirname, 'fixtures');
const page = (name, bio) => fs.readFileSync(path.join(FX, name), 'utf8').replace('{{BIO}}', bio === undefined ? '' : bio);
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
let lodestone = { status: 200, data: '' };
const shims = {
    axios: { get: async url => { lodestone.url = url; if (lodestone.throw) throw new Error('offline'); return { status: lodestone.status, data: lodestone.data }; } },
    'discord.js': {
        EmbedBuilder: FakeEmbed, ButtonBuilder: FakeButton, ActionRowBuilder: FakeRow,
        SlashCommandBuilder: function () { return builder(); }, ModalBuilder: function () { return builder(); }, TextInputBuilder: function () { return builder(); },
        StringSelectMenuBuilder: function () { return builder(); }, StringSelectMenuOptionBuilder: function () { return builder(); },
        TextInputStyle: { Short: 1 }, ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 }, MessageFlags: { Ephemeral: 64 }
    },
    cheerio: {}, sharp: function () {}, qrcode: {}
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (shims[request]) return 'shim:' + request;
    return origResolve.call(this, request, ...rest);
};
for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);

const { makeDb } = require('./fixtures/ign-fakedb');
let { db, pool } = makeDb();
// the modules keep the pool object they got: hand them one that always uses the current fake database
const livePool = { execute: (...a) => pool.execute(...a), getConnection: () => pool.getConnection() };
const perks = new Set();
inject(path.join(ROOT, 'utils', 'db.js'), { pool: livePool });
inject(path.join(ROOT, 'utils', 'membership.js'), { ownerHasMembership: async id => perks.has(String(id)), sponsorHasPerks: async () => false, findPerksAdmin: async () => null });
inject(path.join(ROOT, 'utils', 'userLanguage.js'), { forInteraction: async () => 'en', forUser: async () => 'en', forGuild: async () => 'en' });
inject(path.join(ROOT, 'maintenance.js'), { isMaintenance: () => false });

const C = require('../utils/ignClaims');
const ignconfig = require('../commands/ignconfig');
const { t } = require('../utils/i18n');

const U = '200000000000000001';
const OTHER = '200000000000000009';
const reset = () => { ({ db, pool } = makeDb()); C._reset(); perks.clear(); global.ignSessions = {}; lodestone = { status: 200, data: '' }; };

function interaction(kind, customId, extra = {}) {
    const out = { replies: [], updates: [], edits: [], followUps: [], deferred: false, replied: false };
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

// ================= utils/ignClaims.js =================
test('same claim code and Lodestone rules as the website', async () => {
    for (let i = 0; i < 200; i++) assert.match(C.newCode(), /^pingway-[23456789abcdefghjkmnpqrstuvwxyz]{12}$/);
    const code = 'pingway-abcdefghjkmn';
    assert.equal(C.checkBio(C.parseCharacterPage(page('lodestone-character.html', 'hi<br />' + code), 200), code), 'verified');
    assert.equal(C.checkBio(C.parseCharacterPage(page('lodestone-character.html', 'hi'), 200), code), 'missing');
    assert.equal(C.checkBio(C.parseCharacterPage(page('lodestone-character.html', 'pingway-zzzzzzzzzzzz'), 200), code), 'wrong');
    assert.equal(C.checkBio(C.parseCharacterPage(page('lodestone-private.html'), 200), code), 'private');
    assert.equal(C.checkBio(C.parseCharacterPage(page('lodestone-notfound.html'), 404), code), 'notfound');
    assert.deepEqual([C.LIMITS.free, C.LIMITS.perks, C.CODE_TTL_MS], [2, 20, 86400000]);
    // the bot reads the page with axios (any status comes back, 404 = not found)
    lodestone = { status: 404, data: page('lodestone-notfound.html') };
    assert.equal((await C.fetchCharacterPage('42')).state, 'notfound');
    assert.equal(lodestone.url, 'https://na.finalfantasyxiv.com/lodestone/character/42/');
    lodestone = { throw: true };
    assert.equal((await C.fetchCharacterPage('42')).state, 'error');
});

test('cardConfig: /ign leaves out what the website switched off (NULL = on, like older rows)', () => {
    const row = { lodestone_id: '1', tomestone_url: 'https://tomestone.gg/a', fflogs_url: 'https://www.fflogs.com/b', full_photo_url: 'https://x.test/p.png', portrait_toggle: 0 };
    assert.deepEqual(C.cardConfig(row), row, 'older row: unchanged');
    const off = C.cardConfig(Object.assign({}, row, { show_tomestone: 0, show_fflogs: 0, show_photo: 1 }));
    assert.deepEqual([off.tomestone_url, off.fflogs_url, off.full_photo_url, off.portrait_toggle], [null, null, 'https://x.test/p.png', 0]);
    const noImg = C.cardConfig(Object.assign({}, row, { show_photo: 0 }));
    assert.deepEqual([noImg.full_photo_url, noImg.portrait_toggle], [null, 1], 'no custom image and no portrait -> the portrait comes back');
    assert.equal(C.cardConfig(Object.assign({}, row, { show_tomestone: 1 })).tomestone_url, 'https://tomestone.gg/a');
});

// ================= /ignconfig =================
test('/ignconfig Link Lodestone: shows the claim code + ✅ Verify instead of saving the link', async () => {
    reset();
    const i = interaction('modal', 'ign_modal_link', { input: 'https://na.finalfantasyxiv.com/lodestone/character/31313131/' });
    await ignconfig.handleModal(i);
    const shown = i.out.edits[0];
    assert.ok(shown, JSON.stringify(i.out));
    const code = db.codes[0].code;
    assert.equal(db.codes[0].lodestone_id, '31313131');
    assert.ok(shown.embeds[0].data.description.includes('```' + code + '```'));
    assert.ok(shown.embeds[0].data.description.includes('https://na.finalfantasyxiv.com/lodestone/character/31313131/'));
    assert.deepEqual(shown.components[0].components.map(b => b.data.custom_id), ['ign_btn_verify', 'ign_btn_back_dashboard']);
    assert.equal(db.config.has(U), false, 'nothing linked before the check');
    // bad link
    const bad = interaction('modal', 'ign_modal_link', { input: 'hello' });
    await ignconfig.handleModal(bad);
    assert.equal(bad.out.followUps[0].content, t('en', 'ignconfig.invalidLodestone'));
});

test('/ignconfig ✅ Verify: not there yet -> reason; there -> claimed, Main, dashboard reloaded; single use', async () => {
    reset();
    await ignconfig.handleModal(interaction('modal', 'ign_modal_link', { input: '31313131' }));
    const code = db.codes[0].code;
    lodestone = { status: 200, data: page('lodestone-character.html', 'nothing') };
    let i = interaction('button', 'ign_btn_verify');
    await ignconfig.handleButton(i);
    assert.equal(i.out.followUps[0].content, t('en', 'ignconfig.claim.reason.missing'));
    i = interaction('button', 'ign_btn_verify');
    await ignconfig.handleButton(i);
    assert.equal(i.out.followUps[0].content, t('en', 'ignconfig.claim.reason.wait', { n: 15 }).replace('15', i.out.followUps[0].content.match(/\d+/)[0]));
    db.codes[0].last_check_at -= 20000;
    lodestone = { status: 200, data: page('lodestone-character.html', 'Hello ' + code) };
    i = interaction('button', 'ign_btn_verify');
    await ignconfig.handleButton(i);
    assert.equal(i.out.followUps[0].content, t('en', 'ignconfig.claim.verified', { name: 'Mira Starfall' }));
    assert.equal(db.config.get(U).lodestone_id, '31313131');
    assert.equal(global.ignSessions[U].lodestone_id, '31313131');
    assert.equal(i.out.edits[0].embeds[0].data.title, t('en', 'ignconfig.dashTitle'));
    i = interaction('button', 'ign_btn_verify');
    await ignconfig.handleButton(i);
    assert.equal(i.out.followUps[0].content, t('en', 'ignconfig.claim.reason.noCode'));
    // the same character again = it just becomes the Main
    await ignconfig.handleModal(interaction('modal', 'ign_modal_link', { input: '31313131' }));
    assert.equal(db.codes.length, 1, 'no new code for an already claimed character');
});

test('/ignconfig: a new claim in Discord becomes the Main; 3rd character needs Supporter Perks; Link on a claimed one = make it Main', async () => {
    reset();
    const claimIn = async id => {
        await ignconfig.handleModal(interaction('modal', 'ign_modal_link', { input: id }));
        const c = db.codes[db.codes.length - 1];
        lodestone = { status: 200, data: page('lodestone-character.html', c.code) };
        const i = interaction('button', 'ign_btn_verify');
        await ignconfig.handleButton(i);
        return i;
    };
    await claimIn('1001');
    await claimIn('1002');
    assert.equal(db.config.get(U).lodestone_id, '1002', 'the Discord claim is the Main');
    assert.deepEqual(db.chars.map(r => [r.lodestone_id, r.is_main]), [['1001', 0], ['1002', 1]]);
    const i = interaction('modal', 'ign_modal_link', { input: '1003' });
    await ignconfig.handleModal(i);
    assert.equal(i.out.followUps[0].content, t('en', 'ignconfig.claim.limitFree', { free: 2, max: 20 }));
    perks.add(U);
    await claimIn('1003');
    assert.equal(db.chars.length, 3);
    const m = interaction('modal', 'ign_modal_link', { input: '1001' });
    await ignconfig.handleModal(m);
    assert.equal(m.out.followUps[0].content, t('en', 'ignconfig.claim.madeMain'));
    assert.equal(db.config.get(U).lodestone_id, '1001');
    assert.equal(db.chars.filter(r => r.is_main).length, 1);
});

test('/ignconfig edits (job, links) go to the Main character too; an older card is migrated first', async () => {
    reset();
    db.config.set(U, { user_id: U, lodestone_id: '4242', main_job: 'Paladin', portrait_url: null, full_photo_url: null, portrait_toggle: 1, tomestone_url: null, fflogs_url: null });
    global.ignSessions[U] = { lodestone_id: '4242', main_job: 'Paladin', portrait_url: '', full_photo_url: '', portrait_toggle: true, tomestone_url: '', fflogs_url: '' };
    const i = interaction('modal', 'ign_modal_tomestone', { input: 'https://tomestone.gg/character/4242/x' });
    await ignconfig.handleModal(i);
    const rows = await C.listCharacters(livePool, U);
    assert.deepEqual(rows.map(r => [r.lodestone_id, r.is_main, r.tomestone_url, r.main_job, r.claim_key]), [['4242', 1, 'https://tomestone.gg/character/4242/x', 'Paladin', null]]);
    // the edited character was unclaimed on the website meanwhile: the card is set back from the real Main
    reset();
    db.chars.push({ id: 50, user_id: U, lodestone_id: '7', claim_key: '7', is_main: 1, position: 0, character_name: 'A', world: 'B', main_job: 'Sage', portrait_url: null, full_photo_url: null,
        portrait_toggle: 1, tomestone_url: null, fflogs_url: null, show_tomestone: 1, show_fflogs: 0, show_photo: 1, verified_at: 1 });
    global.ignSessions[U] = { lodestone_id: '4242', main_job: 'Bard', portrait_url: '', full_photo_url: '', portrait_toggle: true, tomestone_url: '', fflogs_url: '' };
    await ignconfig.handleModal(interaction('modal', 'ign_modal_fflogs', { input: '' }));
    assert.deepEqual([db.config.get(U).lodestone_id, db.config.get(U).main_job, db.config.get(U).show_fflogs], ['7', 'Sage', 0]);
});

test('a verified claim moves the character away from the other Discord user', async () => {
    reset();
    db.config.set(OTHER, { user_id: OTHER, lodestone_id: '9090', main_job: 'Bard', portrait_toggle: 1 });
    await ignconfig.handleModal(interaction('modal', 'ign_modal_link', { input: '9090' }));
    lodestone = { status: 200, data: page('lodestone-character.html', db.codes[0].code) };
    const i = interaction('button', 'ign_btn_verify');
    await ignconfig.handleButton(i);
    assert.equal(i.out.followUps[0].content, t('en', 'ignconfig.claim.verifiedMoved', { name: 'Mira Starfall' }));
    assert.equal(db.config.has(OTHER), false);
    assert.equal(db.config.get(U).lodestone_id, '9090');
});

test('claim texts exist in all 4 languages (Discord)', () => {
    for (const lang of ['en', 'fr', 'de', 'ja']) {
        for (const k of ['title', 'steps', 'btnVerify', 'verified', 'verifiedMoved', 'madeMain', 'limitFree', 'limitMax']) assert.notEqual(t(lang, 'ignconfig.claim.' + k), 'ignconfig.claim.' + k);
        for (const r of ['badId', 'tooManyCodes', 'noCode', 'used', 'expired', 'wait', 'tooManyChecks', 'notfound', 'private', 'missing', 'wrong', 'error']) {
            assert.notEqual(t(lang, 'ignconfig.claim.reason.' + r), 'ignconfig.claim.reason.' + r, lang + ' ' + r);
        }
    }
    assert.ok(t('fr', 'ignconfig.claim.steps').includes('Copie'), 'FR uses tu');
    assert.ok(t('de', 'ignconfig.claim.steps').includes('Kopier '), 'DE uses du');
});

// ================= 5.7 Firmament: the scheduler reads the database every tick =================
test('firmament scheduler: a timer saved on the website is picked up on the next tick (no restart needed)', async () => {
    const rows = new Map();
    const sent = [];
    const fpool = {
        async execute(sql, params) {
            const s = sql.replace(/\s+/g, ' ').trim();
            if (/^SELECT user_id, next_celebration_timestamp, cycle_length, guild_id FROM firmament_personal_data WHERE notify_dm = 1 AND next_celebration_timestamp <= \?$/.test(s)) {
                return [[...rows.values()].filter(r => r.notify_dm === 1 && r.next_celebration_timestamp <= params[0]).map(r => ({ ...r }))];
            }
            if (s === 'UPDATE firmament_personal_data SET next_celebration_timestamp = ? WHERE user_id = ?') { rows.get(params[1]).next_celebration_timestamp = params[0]; return [{}]; }
            throw new Error('Unexpected SQL ' + s);
        }
    };
    const file = path.join(ROOT, 'utils', 'firmamentScheduler.js');
    delete require.cache[file];
    inject(path.join(ROOT, 'utils', 'db.js'), { pool: fpool });
    const realSetInterval = global.setInterval;
    let tick = null;
    global.setInterval = fn => { tick = fn; return 0; };
    try {
        require(file).startFirmamentScheduler({ guilds: { fetch: async () => null }, users: { fetch: async id => ({ send: async m => sent.push([id, m]) }) } });
    } finally {
        global.setInterval = realSetInterval;
        inject(path.join(ROOT, 'utils', 'db.js'), { pool: livePool });
    }
    await tick();
    assert.equal(sent.length, 0);
    // the website sets a timer that is due (as /api/settings part 'firmament' writes it) and turns the DM on
    rows.set(U, { user_id: U, guild_id: null, next_celebration_timestamp: Date.now() - 1000, cycle_length: 259200000, notify_dm: 1 });
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], U);
    assert.ok(sent[0][1].includes(t('en', 'firmament.thisServer')), 'a timer made on the website has no server');
    assert.ok(rows.get(U).next_celebration_timestamp > Date.now(), 'moved to the next cycle');
    // removed on the website -> nothing more
    rows.delete(U);
    await tick();
    assert.equal(sent.length, 1);
});
