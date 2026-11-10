// In-memory stand-in for the MySQL tables of the IGN Card claims (lib/ign.js / the bot's utils/ignClaims.js), the
// Firmament timer and the FFXIV Collect cache + IGN card stat switches (utils/ffxivCollect.js / lib/collectStats.js), for the tests. It understands exactly the SQL those files send (anything else on these tables throws).
// Other tables: SELECT -> no rows, writes -> ok (the tests only look at these tables).
'use strict';

function makeDb() {
    const db = { chars: [], codes: [], config: new Map(), firm: new Map(), cols: new Set(), nextId: 1, log: [], fcChars: new Map(), fcLists: new Map() };
    const CS = ['cs_mounts', 'cs_minions', 'cs_achievements', 'cs_orchestrions', 'cs_cards']; // IGN card stat switches (FFXIV Collect)
    const dup = msg => Object.assign(new Error('Duplicate entry ' + msg), { code: 'ER_DUP_ENTRY', errno: 1062 });

    function parseInsert(s, params) {
        const m = s.match(/^INSERT (IGNORE )?INTO (\w+) \(([^)]+)\) VALUES \((.+?)\)( ON DUPLICATE KEY UPDATE .*)?$/);
        if (!m) return null;
        const cols = m[3].split(',').map(x => x.trim());
        let pi = 0;
        const vals = m[4].split(',').map(x => x.trim()).map(tok => tok === '?' ? params[pi++] : tok === 'NULL' ? null : Number(tok));
        const row = {};
        cols.forEach((c, i) => { row[c] = vals[i]; });
        return { ignore: !!m[1], table: m[2], row, upsert: !!m[5] };
    }

    function run(sql, params = []) {
        const s = sql.replace(/\s+/g, ' ').trim();
        db.log.push({ sql: s, params });
        let m;
        if (/^CREATE TABLE/.test(s)) return [{}];
        if ((m = s.match(/^SHOW COLUMNS FROM (\w+) LIKE '(\w+)'$/))) return [db.cols.has(m[1] + '.' + m[2]) ? [{ Field: m[2] }] : []];
        if ((m = s.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+) /))) { db.cols.add(m[1] + '.' + m[2]); return [{}]; }

        // ---- ign_characters ----
        if (/^SELECT .+ FROM ign_characters WHERE user_id = \? ORDER BY position, id$/.test(s)) {
            return [db.chars.filter(r => r.user_id === params[0]).sort((a, b) => a.position - b.position || a.id - b.id).map(r => ({ ...r }))];
        }
        if (s === 'SELECT COUNT(*) AS n FROM ign_characters WHERE user_id = ?') return [[{ n: db.chars.filter(r => r.user_id === params[0]).length }]];
        if (s === 'SELECT DISTINCT user_id FROM ign_characters WHERE lodestone_id = ? AND user_id <> ?') {
            return [[...new Set(db.chars.filter(r => r.lodestone_id === params[0] && r.user_id !== params[1]).map(r => r.user_id))].map(user_id => ({ user_id }))];
        }
        if (s === 'UPDATE ign_characters SET is_main = 0 WHERE user_id = ? AND id <> ?') { db.chars.filter(r => r.user_id === params[0] && r.id !== params[1]).forEach(r => { r.is_main = 0; }); return [{}]; }
        if (s === 'UPDATE ign_characters SET is_main = 1 WHERE id = ?') { db.chars.filter(r => r.id === params[0]).forEach(r => { r.is_main = 1; }); return [{}]; }
        if (s === 'UPDATE ign_characters SET is_main = (lodestone_id = ?) WHERE user_id = ?') { db.chars.filter(r => r.user_id === params[1]).forEach(r => { r.is_main = r.lodestone_id === String(params[0]) ? 1 : 0; }); return [{}]; }
        if (s === 'DELETE FROM ign_characters WHERE user_id = ? AND lodestone_id = ?') {
            const before = db.chars.length;
            db.chars = db.chars.filter(r => !(r.user_id === params[0] && r.lodestone_id === params[1]));
            return [{ affectedRows: before - db.chars.length }];
        }
        if (s === 'UPDATE ign_characters SET claim_key = ?, verified_at = ?, character_name = ?, world = ? WHERE id = ?') {
            if (db.chars.some(r => r.claim_key === params[0] && r.id !== params[4])) throw dup('claim_key');
            db.chars.filter(r => r.id === params[4]).forEach(r => Object.assign(r, { claim_key: params[0], verified_at: params[1], character_name: params[2], world: params[3] }));
            return [{ affectedRows: 1 }];
        }
        if (/^UPDATE ign_characters SET main_job = \?, portrait_url = \?, full_photo_url = \?, portrait_toggle = \?, tomestone_url = \?, fflogs_url = \?, show_tomestone = \?, show_fflogs = \?, show_photo = \?, is_main = \? WHERE id = \? AND user_id = \?$/.test(s)) {
            const [main_job, portrait_url, full_photo_url, portrait_toggle, tomestone_url, fflogs_url, show_tomestone, show_fflogs, show_photo, is_main, id, uid] = params;
            db.chars.filter(r => r.id === id && r.user_id === uid).forEach(r => Object.assign(r, { main_job, portrait_url, full_photo_url, portrait_toggle, tomestone_url, fflogs_url, show_tomestone, show_fflogs, show_photo, is_main }));
            return [{}];
        }
        if (s === 'UPDATE ign_characters SET main_job = ?, portrait_url = ?, full_photo_url = ?, portrait_toggle = ?, tomestone_url = ?, fflogs_url = ? WHERE id = ?') {
            const [main_job, portrait_url, full_photo_url, portrait_toggle, tomestone_url, fflogs_url, id] = params;
            db.chars.filter(r => r.id === id).forEach(r => Object.assign(r, { main_job, portrait_url, full_photo_url, portrait_toggle, tomestone_url, fflogs_url }));
            return [{}];
        }

        // ---- FFXIV Collect: card stat switches on ign_characters, saved character data, master lists ----
        if (s === 'SELECT ' + CS.join(', ') + ' FROM ign_characters WHERE user_id = ? AND lodestone_id = ?') {
            const r = db.chars.find(x => x.user_id === params[0] && x.lodestone_id === params[1]);
            return [r ? [Object.fromEntries(CS.map(c => [c, r[c] === undefined ? null : r[c]]))] : []];
        }
        if (s === 'SELECT lodestone_id, ' + CS.join(', ') + ' FROM ign_characters WHERE user_id = ?') {
            return [db.chars.filter(r => r.user_id === params[0]).map(r => Object.assign({ lodestone_id: r.lodestone_id }, Object.fromEntries(CS.map(c => [c, r[c] === undefined ? null : r[c]]))))];
        }
        if (s === 'UPDATE ign_characters SET ' + CS.map(c => c + ' = ?').join(', ') + ' WHERE user_id = ? AND lodestone_id = ?') {
            const r = db.chars.find(x => x.user_id === params[5] && x.lodestone_id === params[6]);
            if (r) CS.forEach((c, i) => { r[c] = params[i]; });
            return [{ affectedRows: r ? 1 : 0 }];
        }
        if (s === 'SELECT user_id, lodestone_id, character_name, world FROM ign_characters WHERE is_main = 1 AND claim_key IS NOT NULL') {
            return [db.chars.filter(r => Number(r.is_main) === 1 && r.claim_key).map(r => ({ user_id: r.user_id, lodestone_id: r.lodestone_id, character_name: r.character_name, world: r.world }))];
        }
        if (s === 'SELECT lodestone_id, status, data, fetched_at, checked_at, manual_at FROM ffxiv_collect_chars WHERE lodestone_id = ?') {
            const r = db.fcChars.get(params[0]); return [r ? [{ ...r }] : []];
        }
        if ((m = s.match(/^SELECT lodestone_id, status, data, fetched_at FROM ffxiv_collect_chars WHERE lodestone_id IN \(([?, ]+)\)$/))) {
            return [params.map(id => db.fcChars.get(id)).filter(Boolean).map(r => ({ lodestone_id: r.lodestone_id, status: r.status, data: r.data, fetched_at: r.fetched_at }))];
        }
        if (/^INSERT INTO ffxiv_collect_chars \(lodestone_id, status, data, fetched_at, checked_at, manual_at\) VALUES/.test(s)) {
            const [lodestone_id, status, data, fetched_at, checked_at, manual_at] = params;
            db.fcChars.set(lodestone_id, { lodestone_id, status, data, fetched_at, checked_at, manual_at });
            return [{ affectedRows: 1 }];
        }
        if (s === 'UPDATE ffxiv_collect_chars SET manual_at = ? WHERE lodestone_id = ?') { const r = db.fcChars.get(params[1]); if (r) r.manual_at = params[0]; return [{}]; }
        if (s === 'SELECT data, fetched_at FROM ffxiv_collect_lists WHERE collection = ? AND lang = ?') {
            const r = db.fcLists.get(params[0] + ':' + params[1]); return [r ? [{ ...r }] : []];
        }
        if (/^INSERT INTO ffxiv_collect_lists \(collection, lang, data, fetched_at\) VALUES/.test(s)) {
            db.fcLists.set(params[0] + ':' + params[1], { data: params[2], fetched_at: params[3] });
            return [{ affectedRows: 1 }];
        }

        // ---- user_ign_config ----
        if (s === 'SELECT * FROM user_ign_config WHERE user_id = ?') { const r = db.config.get(params[0]); return [r ? [{ ...r }] : []]; }
        if (s === 'SELECT user_id FROM user_ign_config WHERE lodestone_id = ? AND user_id <> ?') {
            return [[...db.config.values()].filter(r => String(r.lodestone_id) === params[0] && r.user_id !== params[1]).map(r => ({ user_id: r.user_id }))];
        }
        if (/^SELECT lodestone_id, main_job, portrait_url, full_photo_url, portrait_toggle, tomestone_url, fflogs_url FROM user_ign_config WHERE user_id = \?$/.test(s)) {
            const r = db.config.get(params[0]); return [r ? [{ ...r }] : []];
        }
        if (s === 'DELETE FROM user_ign_config WHERE user_id = ?') { db.config.delete(params[0]); return [{}]; }

        // ---- ign_claim_codes ----
        if (s === 'SELECT code, expires_at FROM ign_claim_codes WHERE user_id = ? AND lodestone_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1') {
            const r = db.codes.filter(c => c.user_id === params[0] && c.lodestone_id === params[1] && c.used_at === null && c.expires_at > params[2]).sort((a, b) => b.created_at - a.created_at)[0];
            return [r ? [{ code: r.code, expires_at: r.expires_at }] : []];
        }
        if (s === 'SELECT COUNT(*) AS n FROM ign_claim_codes WHERE user_id = ? AND created_at > ?') return [[{ n: db.codes.filter(c => c.user_id === params[0] && c.created_at > params[1]).length }]];
        if (s === 'DELETE FROM ign_claim_codes WHERE expires_at < ?') { db.codes = db.codes.filter(c => !(c.expires_at < params[0])); return [{}]; }
        if (s === 'SELECT code, user_id, lodestone_id, expires_at, used_at, checks, last_check_at FROM ign_claim_codes WHERE code = ? AND user_id = ?') {
            const r = db.codes.find(c => c.code === params[0] && c.user_id === params[1]); return [r ? [{ ...r }] : []];
        }
        if (s === 'SELECT code, user_id, lodestone_id, expires_at, used_at, checks, last_check_at FROM ign_claim_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1') {
            const r = db.codes.filter(c => c.user_id === params[0] && c.used_at === null).sort((a, b) => b.created_at - a.created_at)[0]; return [r ? [{ ...r }] : []];
        }
        if (s === 'UPDATE ign_claim_codes SET checks = checks + 1, last_check_at = ? WHERE code = ? AND used_at IS NULL AND (last_check_at IS NULL OR last_check_at <= ?)') {
            const r = db.codes.find(c => c.code === params[1] && c.used_at === null && (c.last_check_at === null || c.last_check_at <= params[2]));
            if (r) { r.checks++; r.last_check_at = params[0]; }
            return [{ affectedRows: r ? 1 : 0 }];
        }
        if (s === 'UPDATE ign_claim_codes SET used_at = ? WHERE code = ? AND used_at IS NULL') {
            const r = db.codes.find(c => c.code === params[1] && c.used_at === null);
            if (r) r.used_at = params[0];
            return [{ affectedRows: r ? 1 : 0 }];
        }

        // ---- firmament_personal_data ----
        if (/^SELECT next_celebration_timestamp, cycle_length, notify_dm FROM firmament_personal_data WHERE user_id = \?$/.test(s)) { const r = db.firm.get(params[0]); return [r ? [{ ...r }] : []]; }
        if (s === 'DELETE FROM firmament_personal_data WHERE user_id = ?') { db.firm.delete(params[0]); return [{}]; }
        if (s === 'UPDATE firmament_personal_data SET notify_dm = ? WHERE user_id = ?') { const r = db.firm.get(params[1]); if (r) r.notify_dm = params[0]; return [{}]; }

        const ins = /^INSERT /.test(s) ? parseInsert(s, params) : null;
        if (ins && ins.table === 'ign_characters') {
            const r = ins.row;
            if (db.chars.some(x => x.user_id === r.user_id && x.lodestone_id === r.lodestone_id) || (r.claim_key && db.chars.some(x => x.claim_key === r.claim_key))) {
                if (ins.ignore) return [{ affectedRows: 0 }];
                throw dup('ign_characters');
            }
            const row = Object.assign({ id: db.nextId++, claim_key: null, is_main: 0, position: 0, character_name: null, world: null, main_job: null, portrait_url: null, full_photo_url: null,
                portrait_toggle: 1, tomestone_url: null, fflogs_url: null, show_tomestone: 1, show_fflogs: 1, show_photo: 1, verified_at: null }, r);
            db.chars.push(row);
            return [{ affectedRows: 1, insertId: row.id }];
        }
        if (ins && ins.table === 'user_ign_config') { db.config.set(ins.row.user_id, Object.assign({}, db.config.get(ins.row.user_id) || {}, ins.row)); return [{ affectedRows: 1 }]; }
        if (ins && ins.table === 'ign_claim_codes') {
            if (db.codes.some(c => c.code === ins.row.code)) throw dup('code');
            db.codes.push(Object.assign({ used_at: null, checks: 0, last_check_at: null }, ins.row));
            return [{ affectedRows: 1 }];
        }
        if (ins && ins.table === 'firmament_personal_data') {
            const old = db.firm.get(ins.row.user_id);
            db.firm.set(ins.row.user_id, old ? Object.assign(old, { next_celebration_timestamp: ins.row.next_celebration_timestamp, cycle_length: ins.row.cycle_length }) : ins.row);
            return [{ affectedRows: 1 }];
        }
        if (/\b(ign_characters|ign_claim_codes|user_ign_config|firmament_personal_data|ffxiv_collect_chars|ffxiv_collect_lists)\b/.test(s) && !/^CREATE TABLE/.test(s)) throw new Error('Unexpected SQL in test: ' + s);
        if (/^SELECT/.test(s)) return [[]];
        return [{ affectedRows: 0 }];
    }

    const pool = {
        async execute(sql, params) { return run(sql, params); },
        async getConnection() {
            return { execute: async (sql, params) => run(sql, params), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
        }
    };
    return { db, pool };
}

module.exports = { makeDb };
