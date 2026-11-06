// Test setup for Pingway Trivia: an in-memory database that understands the SQL Trivia sends, stand-ins for
// discord.js / axios when they are not installed, a fake XIVAPI, and fake Discord interactions for /trivia.
// Use: const env = require('./fixtures/trivia-env').setup();   (before anything else requires utils/trivia.js)
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..');

// ---------- in-memory database ----------
const KEYS = {
    trivia_words: ['day', 'difficulty'], trivia_plays: ['user_id', 'day', 'difficulty'], trivia_users: ['user_id'],
    trivia_players: ['guild_id', 'user_id'], trivia_guild: ['guild_id'], user_language: ['user_id']
};
const DEFAULTS = {
    trivia_plays: { status: 'playing', wrong: 0, hints_used: null, revealed: null, bits: 0, guild_id: null, started_at: 0, finished_at: null, shared: 0, hint_round: 0, lang_progress: null },
    trivia_users: { display_name: null, avatar: null, bits_total: 0, season_key: null, season_bits: 0, streak: 0, last_solve_day: null, hidden: 0, updated_at: 0 },
    trivia_words: { category: '', hints: null, lore: null, created_at: 0, i18n: null },
    trivia_guild: { share_channel_id: null, updated_at: 0 },
    user_language: { lang: null, discord_locale: null, updated_at: 0 }
};

function fakeDb() {
    const tables = {};
    const log = [];
    const columns = new Set(['trivia_plays.hint_round']); // columns that "exist" in an old database (others get ALTER TABLE)
    const tbl = name => (tables[name] = tables[name] || []);
    const keyOf = (name, row) => (KEYS[name] || []).map(k => String(row[k])).join('|');

    // a = list of values, i = index of the next ? (shared by SET and WHERE)
    const lit = (tok, a, st) => {
        tok = tok.trim();
        if (tok === '?') return a[st.i++];
        if (/^'.*'$/.test(tok)) return tok.slice(1, -1);
        if (/^-?\d+$/.test(tok)) return Number(tok);
        if (/^NULL$/i.test(tok)) return null;
        throw new Error('fake db: value ' + tok);
    };
    function splitTop(s, sep) {
        const out = []; let depth = 0, q = false, cur = '';
        for (let k = 0; k < s.length; k++) {
            const c = s[k];
            if (c === "'") q = !q;
            if (!q && c === '(') depth++;
            if (!q && c === ')') depth--;
            if (!q && depth === 0 && s.startsWith(sep, k)) { out.push(cur); cur = ''; k += sep.length - 1; continue; }
            cur += c;
        }
        out.push(cur);
        return out.map(x => x.trim()).filter(Boolean);
    }
    function where(cond, a, st) {
        if (!cond) return () => true;
        const tests = splitTop(cond, ' AND ').map(c => {
            let m;
            if ((m = /^\(?(\w+) IS NULL\)?$/i.exec(c))) return r => r[m[1]] === null || r[m[1]] === undefined;
            if ((m = /^(\w+)\s*(=|<>|>=|<=|<|>)\s*(.+)$/.exec(c))) {
                const col = m[1], op = m[2], v = lit(m[3], a, st);
                return r => {
                    const x = r[col];
                    if (op === '=') return String(x) === String(v);
                    if (op === '<>') return String(x) !== String(v);
                    if (op === '>=') return String(x) >= String(v);
                    if (op === '<=') return String(x) <= String(v);
                    if (op === '<') return String(x) < String(v);
                    return String(x) > String(v);
                };
            }
            throw new Error('fake db: condition ' + c);
        });
        return r => tests.every(t => t(r));
    }

    async function execute(sql, a = []) {
        const q = sql.replace(/\s+/g, ' ').trim();
        log.push({ q, a });
        let m;
        if (/^CREATE TABLE/i.test(q)) return [{}];
        if ((m = /^SHOW COLUMNS FROM (\w+) LIKE '(\w+)'$/.exec(q))) return [columns.has(m[1] + '.' + m[2]) ? [{ Field: m[2] }] : []];
        if ((m = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(q))) { columns.add(m[1] + '.' + m[2]); return [{}]; }
        if ((m = /^INSERT (IGNORE )?INTO (\w+) \(([^)]+)\) VALUES \((.+?)\)( ON DUPLICATE KEY UPDATE (.+))?$/.exec(q))) {
            const [, ignore, name, cols, vals, , dup] = m;
            const st = { i: 0 };
            const row = Object.assign({}, DEFAULTS[name] || {});
            const cs = cols.split(',').map(s => s.trim());
            splitTop(vals, ',').forEach((v, k) => { row[cs[k]] = lit(v, a, st); });
            const list = tbl(name);
            const old = list.find(r => keyOf(name, r) === keyOf(name, row));
            if (old) {
                if (dup) {
                    for (const part of splitTop(dup, ',')) {
                        const mm = /^(\w+) = VALUES\((\w+)\)$/.exec(part);
                        if (!mm) throw new Error('fake db: dup ' + part);
                        old[mm[1]] = row[mm[2]];
                    }
                    return [{ affectedRows: 2 }];
                }
                if (ignore) return [{ affectedRows: 0 }];
                const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e;
            }
            list.push(row);
            return [{ affectedRows: 1 }];
        }
        if ((m = /^UPDATE (\w+) SET (.+?) WHERE (.+)$/.exec(q))) {
            const [, name, sets, cond] = m;
            const st = { i: 0 };
            const assigns = splitTop(sets, ',').map(part => {
                const mm = /^(\w+) = (.+)$/.exec(part);
                if (!mm) throw new Error('fake db: set ' + part);
                const inc = /^(\w+) \+ (\d+)$/.exec(mm[2]);
                if (inc) return r => { r[mm[1]] = (Number(r[inc[1]]) || 0) + Number(inc[2]); };
                const v = lit(mm[2], a, st);
                return r => { r[mm[1]] = v; };
            });
            const test = where(cond, a, st);
            let n = 0;
            for (const r of tbl(name)) if (test(r)) { assigns.forEach(f => f(r)); n++; }
            return [{ affectedRows: n }];
        }
        if ((m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?( FOR UPDATE)?$/.exec(q))) {
            const [, cols, name, cond] = m;
            const test = where(cond, a, { i: 0 });
            const rows = tbl(name).filter(test).map(r => {
                if (cols === '*') return Object.assign({}, r);
                const o = {};
                for (const c of cols.split(',').map(s => s.trim())) o[c] = r[c] === undefined ? null : r[c];
                return o;
            });
            return [rows];
        }
        if (/^DELETE FROM/.test(q)) return [{ affectedRows: 0 }];
        throw new Error('fake db: unknown SQL ' + q);
    }
    const conn = { execute, query: execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
    const pool = { execute, query: execute, getConnection: async () => conn };
    return { pool, tables, log, tbl, columns };
}

// ---------- module stand-ins ----------
function inject(file, exports) {
    const m = new Module(file);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
}
const canLoad = name => { try { require.resolve(name); return true; } catch (e) { return false; } };

function discordShim() {
    class Builder {
        constructor() { this.data = {}; this.components = []; }
        setCustomId(v) { this.data.custom_id = v; return this; }
        setLabel(v) { this.data.label = v; return this; }
        setStyle(v) { this.data.style = v; return this; }
        setEmoji(v) { this.data.emoji = v; return this; }
        setDisabled(v) { this.data.disabled = v; return this; }
        setTitle(v) { this.data.title = v; return this; }
        setRequired(v) { this.data.required = v; return this; }
        setMaxLength(v) { this.data.max_length = v; return this; }
        addComponents(...c) { this.components.push(...c.flat()); return this; }
    }
    class Slash {
        constructor() { this.name = ''; this.description = ''; this.description_localizations = {}; }
        setName(v) { this.name = v; return this; }
        setDescription(v) { this.description = v; return this; }
        setDescriptionLocalizations(v) { this.description_localizations = v; return this; }
        toJSON() { return { name: this.name, description: this.description, description_localizations: this.description_localizations }; }
    }
    return {
        SlashCommandBuilder: Slash, ActionRowBuilder: Builder, ButtonBuilder: Builder, ModalBuilder: Builder, TextInputBuilder: Builder,
        ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 }, TextInputStyle: { Short: 1, Paragraph: 2 }, MessageFlags: { Ephemeral: 64 },
        PermissionFlagsBits: { ManageRoles: 1n << 28n }
    };
}

let current = null;
function setup() {
    if (current) return current;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pingway-trivia-'));
    process.env.PINGWAY_TRIVIA_BANK_FILE = path.join(tmp, 'trivia_bank.json');
    process.env.PINGWAY_TRIVIA_SALT_FILE = path.join(tmp, 'trivia_salt.txt');
    fs.writeFileSync(process.env.PINGWAY_TRIVIA_SALT_FILE, 'test-salt');
    const db = fakeDb();
    inject(path.join(ROOT, 'utils', 'db.js'), { pool: db.pool });
    const { makeFakeGet } = require('./trivia-xivapi');
    const xiv = { get: makeFakeGet().get };
    const axios = { get: (...args) => xiv.get(...args) };
    const shims = {};
    if (!canLoad('discord.js')) shims['discord.js'] = discordShim();
    shims.axios = axios; // always the fake XIVAPI (no network in tests)
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (shims[request]) return 'shim:' + request;
        return orig.call(this, request, ...rest);
    };
    for (const [name, exp] of Object.entries(shims)) inject('shim:' + name, exp);
    current = { ROOT, tmp, db, xiv, usingDiscordShim: !!shims['discord.js'] };
    return current;
}

// ---------- fake Discord interactions for /trivia ----------
// Labels of all buttons in a screen
const buttonsOf = p => (p.components || []).flatMap(r => r.components || []).map(b => ({ id: b.data.custom_id, label: b.data.label, disabled: !!b.data.disabled }));

function fakeSession({ userId = '111111111111111111', locale = 'en-US', guildId = '222222222222222222', guildLocale = 'en-US', channel } = {}) {
    const screens = [];
    const followUps = [];
    const modals = [];
    const collector = new EventEmitter();
    const message = { createMessageComponentCollector: () => collector };
    const user = { id: userId, username: 'tester', globalName: 'Tester', avatar: null };
    const guild = guildId ? { id: guildId, preferredLocale: guildLocale, channels: { fetch: async id => (channel && channel.id === id ? channel : null) } } : null;
    let n = 0;
    const base = () => ({ user, locale, guildId, guild, member: { displayName: 'Tester' } });
    const interaction = Object.assign(base(), {
        replied: false, deferred: false,
        reply: async p => { screens.push(p); interaction.replied = true; },
        deferReply: async () => { interaction.deferred = true; },
        editReply: async p => { screens.push(p); },
        fetchReply: async () => message
    });
    const component = customId => {
        const i = Object.assign(base(), {
            id: 'i' + (++n), customId, replied: false, deferred: false,
            deferUpdate: async () => { i.deferred = true; },
            editReply: async p => { screens.push(p); },
            followUp: async p => { followUps.push(p); },
            reply: async p => { followUps.push(p); },
            showModal: async m => { modals.push(m); },
            awaitModalSubmit: async () => (i.nextAnswer === undefined ? null : Object.assign(base(), {
                customId: modals[modals.length - 1].data.custom_id, deferUpdate: async () => {}, editReply: async p => { screens.push(p); },
                fields: { getTextInputValue: () => i.nextAnswer }
            }))
        });
        return i;
    };
    // Presses a button (and, for Guess, types `answer` in the modal); resolves when the screen is updated
    async function press(customId, answer) {
        const i = component(customId);
        if (answer !== undefined) i.nextAnswer = answer;
        const fn = collector.listeners('collect')[0];
        if (!fn) throw new Error('no collector');
        await fn(i);
        return screens[screens.length - 1];
    }
    const last = () => screens[screens.length - 1];
    return { interaction, press, screens, followUps, modals, last, collector };
}

module.exports = { setup, fakeDb, fakeSession, buttonsOf, discordShim };
