// Slash command shapes (owner rule: a command is ONE word, everything after a space is an option):
// - NO command in commands/ has sub-commands or sub-command groups (checked on the built command JSON)
// - /pingway: one required "language" option with 5 choices; /honeypot: action / channel / on options; /pf: no options
// Uses the real discord.js builders when they are installed, else small stand-ins that build the same JSON shape
// (option types: 1 = SUB_COMMAND, 2 = SUB_COMMAND_GROUP, 3 = STRING, 5 = BOOLEAN, 7 = CHANNEL).
// Plain node, no Discord / database:  node --test test/command-shapes.test.js
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
function canLoad(name) { try { require.resolve(name); return true; } catch (e) { return false; } }

// A do-nothing stand-in for packages that are not installed here (axios, canvas, mysql2 ...): any property, call or new works
function stub() {
    const fn = function () {};
    return new Proxy(fn, {
        get(_t, k) {
            if (k === 'then') return undefined;
            if (k === Symbol.toPrimitive) return () => '';
            if (k === '__esModule') return false;
            return stub();
        },
        apply() { return stub(); },
        construct() { return stub(); }
    });
}

// ---------- discord.js stand-in: builders that produce the command JSON ----------
const TYPES = { Subcommand: 1, SubcommandGroup: 2, String: 3, Integer: 4, Boolean: 5, User: 6, Channel: 7, Role: 8, Mentionable: 9, Number: 10, Attachment: 11 };
function optionBuilder(type) {
    const o = { type };
    const self = {
        setName(v) { o.name = v; return self; }, setNameLocalizations(v) { o.name_localizations = v; return self; },
        setDescription(v) { o.description = v; return self; }, setDescriptionLocalizations(v) { o.description_localizations = v; return self; },
        setRequired(v) { o.required = v; return self; }, setAutocomplete(v) { o.autocomplete = v; return self; },
        setMinValue(v) { o.min_value = v; return self; }, setMaxValue(v) { o.max_value = v; return self; },
        setMinLength(v) { o.min_length = v; return self; }, setMaxLength(v) { o.max_length = v; return self; },
        addChoices(...c) { o.choices = (o.choices || []).concat(c.flat()); return self; },
        setChoices(...c) { o.choices = c.flat(); return self; },
        addChannelTypes(...c) { o.channel_types = (o.channel_types || []).concat(c.flat()); return self; },
        toJSON() { return { ...o, options: o.options ? o.options.map(x => x.toJSON()) : undefined }; }
    };
    for (const [k, t] of Object.entries(TYPES)) {
        self['add' + k + 'Option'] = fn => { const b = optionBuilder(t); fn(b); (o.options = o.options || []).push(b); return self; };
    }
    self.addSubcommand = fn => { const b = optionBuilder(1); fn(b); (o.options = o.options || []).push(b); return self; };
    self.addSubcommandGroup = fn => { const b = optionBuilder(2); fn(b); (o.options = o.options || []).push(b); return self; };
    return self;
}
function SlashCommandBuilder() {
    const b = optionBuilder(undefined);
    const extra = {};
    b.setDefaultMemberPermissions = v => { extra.default_member_permissions = String(v); return b; };
    b.setDMPermission = v => { extra.dm_permission = v; return b; };
    b.setContexts = (...v) => { extra.contexts = v.flat(); return b; };
    b.setIntegrationTypes = (...v) => { extra.integration_types = v.flat(); return b; };
    b.setNSFW = v => { extra.nsfw = v; return b; };
    const toJSON = b.toJSON;
    b.toJSON = () => { const j = toJSON(); delete j.type; return { ...j, ...extra }; };
    return b;
}

const realDiscord = canLoad('discord.js');
if (!realDiscord) {
    const djs = new Proxy({ SlashCommandBuilder, ChannelType: { GuildText: 0, GuildVoice: 2, GuildAnnouncement: 5 } }, {
        get(o, k) { return k in o ? o[k] : stub(); }
    });
    inject('shim:discord.js', djs);
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'discord.js' && !realDiscord) return 'shim:discord.js';
    try { return origResolve.call(this, request, parent, ...rest); } catch (e) {
        if (request.startsWith('.') || request.startsWith('/')) throw e;
        const id = 'shim:' + request;
        if (!require.cache[id]) inject(id, stub());
        return id;
    }
};
// no database / network while loading the commands
inject(path.join(ROOT, 'utils', 'db.js'), { pool: { execute: async () => [[]], query: async () => [[]], getConnection: async () => ({ release() {}, execute: async () => [[]] }) } });

const json = cmd => (cmd.data && typeof cmd.data.toJSON === 'function' ? cmd.data.toJSON() : cmd.data);
const commandFiles = fs.readdirSync(path.join(ROOT, 'commands')).filter(f => f.endsWith('.js'));

function walk(options, where, out) {
    for (const o of options || []) {
        if (o.type === 1 || o.type === 2) out.push(where + ' -> ' + o.name + ' (type ' + o.type + ')');
        walk(o.options, where + ' ' + o.name, out);
    }
    return out;
}

test('no command in commands/ has sub-commands or sub-command groups (built JSON)', () => {
    const bad = [];
    let checked = 0;
    for (const f of commandFiles) {
        const cmd = require(path.join(ROOT, 'commands', f));
        const data = json(cmd);
        if (!data || !data.name) continue;
        checked++;
        assert.match(data.name, /^[a-z0-9_-]{1,32}$/, f + ': the command name is one word');
        walk(data.options, '/' + data.name, bad);
    }
    assert.ok(checked >= 20, 'all commands were checked (' + checked + ')');
    assert.deepEqual(bad, []);
});

test('the check itself finds sub-commands (a made-up command with one)', () => {
    const b = new (require('discord.js').SlashCommandBuilder)().setName('x').setDescription('x')
        .addSubcommand(s => s.setName('y').setDescription('y'));
    assert.equal(walk(b.toJSON().options, '/x', []).length, 1);
});

test('/pingway: one required "language" option, choices English/Français/Deutsch/日本語/Auto = en/fr/de/jp/auto', () => {
    const data = json(require('../commands/pingway'));
    assert.equal(data.options.length, 1);
    const [o] = data.options;
    assert.equal(o.type, 3);
    assert.equal(o.name, 'language');
    assert.equal(o.required, true);
    assert.deepEqual(Object.keys(o.name_localizations).sort(), ['de', 'fr', 'ja']);
    assert.deepEqual(o.choices.map(c => c.value), ['en', 'fr', 'de', 'jp', 'auto']);
    assert.deepEqual(o.choices.map(c => c.name), ['English', 'Français', 'Deutsch', '日本語', 'Auto']);
    for (const c of o.choices) assert.deepEqual(Object.keys(c.name_localizations).sort(), ['de', 'fr', 'ja'], c.value);
});

test('/honeypot: required "action" (5 choices), optional "channel" (text channels) and "on" (boolean)', () => {
    const data = json(require('../commands/honeypot'));
    assert.deepEqual(data.options.map(o => [o.name, o.type, !!o.required]), [['action', 3, true], ['channel', 7, false], ['on', 5, false]]);
    assert.deepEqual(data.options[0].choices.map(c => c.value), ['set', 'off', 'dm', 'warning', 'status']);
    assert.deepEqual(data.options[0].choices.map(c => c.name), ['Set channel', 'Turn off', 'DM alerts', 'Warning message', 'Status']);
    for (const o of data.options) assert.deepEqual(Object.keys(o.name_localizations).sort(), ['de', 'fr', 'ja'], o.name);
});

test('/pf: no options any more (the mount option moved to the "Toggle Mount Farm" button), no autocomplete', () => {
    const cmd = require('../commands/pf');
    const data = json(cmd);
    assert.equal(data.name, 'pf');
    assert.deepEqual(data.options || [], []);
    assert.equal(typeof cmd.autocomplete, 'undefined');
});

test('/clean keeps its single "target" option', () => {
    const data = json(require('../commands/clean'));
    assert.deepEqual(data.options.map(o => [o.name, o.type, o.required]), [['target', 3, true]]);
});
