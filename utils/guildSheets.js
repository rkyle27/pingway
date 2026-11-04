// Raid & Logger sheets: several named Google Sheets per server (table guild_sheets).
// - kind 'raid' (copied from the Raid Planner template, read by /raid) or 'log' (blank, filled by the command logger).
// - role_id: only members with that role see the sheet in /raid (admins see every sheet). NULL = everyone.
// - enabled: ON = shown in /raid and editable; OFF = hidden and view-only. Never deleted by Pingway on its own.
// - Limits: 5 sheets ON per server for free; up to 100 when the admin switching one on has Supporter Perks
//   (perk_owner). When that admin's perks end: 48-hour grace, then the sheet moves to another admin of the server
//   with perks, or Pingway switches the extra sheets OFF, newest first.
// - Pingway makes and deletes sheets through the "Pingway Sheets helper" Apps Script in Pingway's own Gmail
//   (data/sheets_helper.json holds its link and the secret Pingway claimed; never shown or logged).
// The website can't reach the helper: it writes rows with state 'create' / 'delete' and this module does the work.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('./db');
const { sponsorHasPerks, findPerksAdmin, ownerHasMembership } = require('./membership');

const RAID_TEMPLATE_ID = '13DR7gF3Nx_pRDKYZRfhp7SbzAzy8UXzc6tV4bZhpJKg';
const LOG_HEADER = ['Time (JST)', 'User', 'User ID', 'Server', 'Server ID', 'Channel', 'Command', 'Options'];
const FREE_ON = 5;
const MAX_SHEETS = 100;
const COOLDOWN_MS = 12 * 60 * 60 * 1000;
const WORK_MS = 60 * 1000;
const HELPER_FILE = path.join(__dirname, '..', 'data', 'sheets_helper.json');
const LAYOUT_WARNING = '⚠️ Please don\'t change the layout of the raid sheet (columns, rows, headers), or Pingway can\'t read the schedule.';

let tableReady = false;
let started = false;
let working = false;
let warned = 0;

async function ensureTable() {
    if (tableReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS guild_sheets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        kind VARCHAR(4) NOT NULL,
        name VARCHAR(100) NOT NULL,
        sheet_id VARCHAR(128) DEFAULT NULL,
        role_id VARCHAR(32) DEFAULT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        made_by_pingway TINYINT(1) NOT NULL DEFAULT 0,
        shared_mode VARCHAR(4) DEFAULT NULL,
        perk_owner VARCHAR(32) DEFAULT NULL,
        state VARCHAR(8) NOT NULL DEFAULT 'ok',
        status VARCHAR(160) DEFAULT NULL,
        created_by VARCHAR(32) DEFAULT NULL,
        toggled_at BIGINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL DEFAULT 0,
        KEY idx_guild (guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // robot_ok: Pingway's Google robot account (google-credentials.json) was added as an editor of the sheet
    const [col] = await pool.execute("SHOW COLUMNS FROM guild_sheets LIKE 'robot_ok'");
    if (col.length === 0) await pool.execute('ALTER TABLE guild_sheets ADD COLUMN robot_ok TINYINT(1) NOT NULL DEFAULT 0');
    // One-time move of the old single raid / logger sheet (server_settings) into named sheets
    const [old] = await pool.execute("SELECT guild_id, raid_sheet_id, logger_sheet_id FROM server_settings WHERE (raid_sheet_id IS NOT NULL AND raid_sheet_id <> '') OR (logger_sheet_id IS NOT NULL AND logger_sheet_id <> '')");
    for (const r of old) {
        const [have] = await pool.execute('SELECT kind FROM guild_sheets WHERE guild_id = ?', [r.guild_id]);
        const kinds = new Set(have.map(h => h.kind));
        const now = Date.now();
        if (r.raid_sheet_id && !kinds.has('raid')) {
            await pool.execute("INSERT INTO guild_sheets (guild_id, kind, name, sheet_id, enabled, made_by_pingway, state, created_at) VALUES (?, 'raid', 'Main Raid', ?, 1, 0, 'ok', ?)", [r.guild_id, r.raid_sheet_id, now]);
        }
        if (r.logger_sheet_id && !kinds.has('log')) {
            await pool.execute("INSERT INTO guild_sheets (guild_id, kind, name, sheet_id, enabled, made_by_pingway, state, created_at) VALUES (?, 'log', 'Main Log', ?, 1, 0, 'ok', ?)", [r.guild_id, r.logger_sheet_id, now + 1]);
        }
    }
    tableReady = true;
}

// Pingway's Google robot account reads schedules and writes logs, so it must be an editor of every sheet
// Pingway makes. Only its email address is read from google-credentials.json (never the key).
let robot = null;
function robotEmails() {
    if (robot === null) {
        try { robot = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'google-credentials.json'), 'utf8')).client_email || ''; } catch (e) { robot = ''; }
    }
    return robot ? [robot] : [];
}

// ---------- the Apps Script helper ----------
function readHelper() {
    try { return JSON.parse(fs.readFileSync(HELPER_FILE, 'utf8')); } catch (e) { return null; }
}
function helperReady() {
    const h = readHelper();
    return !!(h && h.url && h.secret);
}
async function post(url, body) {
    const r = await axios.post(url, body, { timeout: 30000, headers: { 'Content-Type': 'application/json' }, maxRedirects: 5 });
    return r.data;
}
// First run after the helper link is added: claim it with a random secret (kept only in data/sheets_helper.json)
async function claimHelper() {
    const h = readHelper();
    if (!h || !h.url || h.secret) return;
    const secret = crypto.randomBytes(48).toString('base64url');
    const r = await post(h.url, { action: 'claim', secret });
    if (r && r.ok) {
        fs.writeFileSync(HELPER_FILE, JSON.stringify({ url: h.url, secret }, null, 2));
        console.log('🔐 [SHEETS] Pingway Sheets helper connected.');
    } else {
        console.log('⚠️ [SHEETS] Could not connect the Sheets helper: ' + ((r && r.error) || 'no answer') + '. (If it says "already claimed", reset SECRET in the script\'s properties.)');
    }
}
async function helper(action, body) {
    const h = readHelper();
    if (!h || !h.url || !h.secret) throw new Error('Pingway can\'t create sheets yet (helper not connected).');
    const r = await post(h.url, { ...body, action, secret: h.secret });
    if (!r || !r.ok) throw new Error((r && r.error) || 'no answer from the Sheets helper');
    return r;
}

// ---------- reading ----------
async function listSheets(guildId, kind) {
    await ensureTable();
    const [rows] = await pool.execute("SELECT * FROM guild_sheets WHERE guild_id = ? AND kind = ? AND state <> 'delete' ORDER BY created_at, id", [guildId, kind]);
    return rows;
}
// Sheets a member may see in /raid or /logger: ON, ready, and their role (admins: all ON sheets)
function visibleTo(rows, member, isAdmin) {
    return rows.filter(r => Number(r.enabled) === 1 && r.state === 'ok' && r.sheet_id &&
        (isAdmin || !r.role_id || (member && member.roles && member.roles.cache && member.roles.cache.has(String(r.role_id)))));
}
const sheetUrl = id => 'https://docs.google.com/spreadsheets/d/' + id + '/edit';

// ---------- creating (from Discord; the website uses state 'create') ----------
// Returns { ok, row } or { ok: false, error }
async function createSheet(guild, { kind, name, roleId, userId }) {
    await ensureTable();
    const [all] = await pool.execute("SELECT id, enabled FROM guild_sheets WHERE guild_id = ? AND state <> 'delete'", [guild.id]);
    if (all.length >= MAX_SHEETS) return { ok: false, error: 'This server already has ' + MAX_SHEETS + ' sheets. Remove one first.' };
    const onCount = all.filter(r => Number(r.enabled) === 1).length;
    let perkOwner = null;
    if (onCount >= FREE_ON) {
        if (!(await ownerHasMembership(userId))) {
            return { ok: false, error: 'This server already has ' + FREE_ON + ' sheets switched on (the free limit). Switch one off on the website, or turn on Supporter Perks for up to ' + MAX_SHEETS + '.' };
        }
        perkOwner = String(userId);
    }
    const res = await helper('create', kind === 'raid' ? { name, templateId: RAID_TEMPLATE_ID, mode: 'edit', editors: robotEmails() } : { name, header: LOG_HEADER, mode: 'edit', editors: robotEmails() });
    const now = Date.now();
    const [ins] = await pool.execute(
        "INSERT INTO guild_sheets (guild_id, kind, name, sheet_id, role_id, enabled, made_by_pingway, shared_mode, perk_owner, state, created_by, created_at, robot_ok) VALUES (?, ?, ?, ?, ?, 1, 1, 'edit', ?, 'ok', ?, ?, 1)",
        [guild.id, kind, name, res.id, roleId || null, perkOwner, String(userId), now]
    );
    return { ok: true, row: { id: ins.insertId, name, sheet_id: res.id, role_id: roleId || null } };
}

// ---------- background work: website requests, sharing, perks ----------
async function work(client) {
    if (working) return;
    working = true;
    try {
        await ensureTable();
        if (readHelper() && !helperReady()) await claimHelper().catch(err => console.log('⚠️ [SHEETS] Helper claim failed:', err.message));
        const ready = helperReady();

        // Website asked to create a sheet
        if (ready) {
            const [todo] = await pool.execute("SELECT * FROM guild_sheets WHERE state = 'create' ORDER BY id LIMIT 10");
            for (const r of todo) {
                try {
                    const res = await helper('create', r.kind === 'raid' ? { name: r.name, templateId: RAID_TEMPLATE_ID, mode: 'edit', editors: robotEmails() } : { name: r.name, header: LOG_HEADER, mode: 'edit', editors: robotEmails() });
                    await pool.execute("UPDATE guild_sheets SET sheet_id = ?, made_by_pingway = 1, shared_mode = 'edit', state = 'ok', status = NULL, robot_ok = 1 WHERE id = ?", [res.id, r.id]);
                } catch (err) {
                    await pool.execute("UPDATE guild_sheets SET state = 'error', status = ? WHERE id = ?", [('Could not create the sheet: ' + err.message).slice(0, 160), r.id]);
                }
            }
        }

        // Removed sheets: Pingway-made ones go to the trash of Pingway's Gmail; admin-made ones are only disconnected
        const [gone] = await pool.execute("SELECT * FROM guild_sheets WHERE state = 'delete' ORDER BY id LIMIT 20");
        for (const r of gone) {
            if (Number(r.made_by_pingway) === 1 && r.sheet_id) {
                if (!ready) continue;
                try { await helper('delete', { id: r.sheet_id }); } catch (err) {
                    if (!/not a Pingway sheet|not found|No item/i.test(err.message)) { logOnce('⚠️ [SHEETS] Delete failed for a sheet (will retry): ' + err.message); continue; }
                }
            }
            await pool.execute('DELETE FROM guild_sheets WHERE id = ?', [r.id]);
        }

        // Perks: sheets above the free 5 need an admin with Supporter Perks
        const [rows] = await pool.execute("SELECT * FROM guild_sheets WHERE state = 'ok' AND enabled = 1 ORDER BY guild_id, created_at, id");
        const byGuild = new Map();
        for (const r of rows) { if (!byGuild.has(r.guild_id)) byGuild.set(r.guild_id, []); byGuild.get(r.guild_id).push(r); }
        for (const [guildId, list] of byGuild) {
            if (list.length <= FREE_ON) continue;
            const guild = client.guilds.cache.get(guildId);
            if (!guild) continue;
            if (await ownerHasMembership(guild.ownerId)) continue;
            // Sheets whose admin's perks still count (incl. the 48 h grace) stay ON. Of the rest, the oldest 5 run free.
            const uncovered = [];
            for (const r of list) if (!(r.perk_owner && await sponsorHasPerks(r.perk_owner))) uncovered.push(r);
            for (const r of uncovered.slice(FREE_ON)) {
                const next = await findPerksAdmin(guild, r.perk_owner);
                if (next) {
                    await pool.execute('UPDATE guild_sheets SET perk_owner = ? WHERE id = ?', [next, r.id]);
                    continue;
                }
                // No admin with perks: switch OFF (hidden from /raid, view-only). These are the newest ones.
                await pool.execute('UPDATE guild_sheets SET enabled = 0, perk_owner = NULL WHERE id = ?', [r.id]);
                console.log('💜 [SHEETS] A sheet in ' + guild.name + ' was switched OFF (Supporter Perks ended; the free limit is ' + FREE_ON + ').');
            }
        }

        // Sheets Pingway made before the robot was added as an editor: add it now
        if (ready && robotEmails().length) {
            const [missing] = await pool.execute("SELECT id, sheet_id FROM guild_sheets WHERE state = 'ok' AND made_by_pingway = 1 AND sheet_id IS NOT NULL AND robot_ok = 0 LIMIT 20");
            for (const r of missing) {
                try { await helper('editor', { id: r.sheet_id, editors: robotEmails() }); await pool.execute('UPDATE guild_sheets SET robot_ok = 1 WHERE id = ?', [r.id]); }
                catch (err) { logOnce('⚠️ [SHEETS] Could not give Pingway access to a sheet (will retry): ' + err.message); }
            }
        }

        // Sharing follows ON / OFF for sheets Pingway made (OFF = view-only)
        if (ready) {
            const [share] = await pool.execute("SELECT id, sheet_id, enabled, shared_mode FROM guild_sheets WHERE state = 'ok' AND made_by_pingway = 1 AND sheet_id IS NOT NULL AND shared_mode <> IF(enabled = 1, 'edit', 'view') LIMIT 20");
            for (const r of share) {
                const mode = Number(r.enabled) === 1 ? 'edit' : 'view';
                try { await helper('share', { id: r.sheet_id, mode }); await pool.execute('UPDATE guild_sheets SET shared_mode = ? WHERE id = ?', [mode, r.id]); }
                catch (err) { logOnce('⚠️ [SHEETS] Could not change sharing (will retry): ' + err.message); }
            }
        }
    } catch (err) {
        logOnce('❌ [SHEETS] Background work failed: ' + err.message);
    } finally {
        working = false;
    }
}

function logOnce(text) {
    if (Date.now() - warned < 30 * 60 * 1000) return;
    warned = Date.now();
    console.log(text);
}

function start(client) {
    if (started) return;
    started = true;
    work(client);
    setInterval(() => work(client), WORK_MS);
}

module.exports = {
    start, work, ensureTable, listSheets, visibleTo, sheetUrl, createSheet, helperReady,
    RAID_TEMPLATE_ID, FREE_ON, MAX_SHEETS, COOLDOWN_MS, LAYOUT_WARNING
};
