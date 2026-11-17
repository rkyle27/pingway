// Separate alert settings + Item alerts tables. This file is IDENTICAL in both repos:
//   website: lib/alertSplitDdl.js      bot: utils/alertSplitDdl.js
// Change both together, so whichever side starts first creates exactly the same tables and runs the same one-time copy.
//
// alert_settings     one row per user and kind: 'retainer' (retainer undercut alerts) or 'item' (Item alerts).
//                    dm = the DM switch, alert_interval = minutes (0 = Immediate, 1/2/5/10/15/30). No row = DM on, every 1 minute.
// alert_channels     server channels per user and kind (3 free, 10 with Supporter Perks, one per server, optional role ping).
//                    Counted separately from market_alert_channels (market alerts) and from the other kind.
// market_alert_dcs   the Data Centers market alerts scan (set on the website). /price and /datacenter keep user_datacenters.
// item_alerts        Item alerts (Ko-fi / Patreon members): one row per user and item. places = JSON list of
//                    { type: 'region' | 'dc' | 'world', name } (region = Universalis region name, e.g. 'Japan', 'North-America').
//                    quality 'nq' | 'hq' | 'both'. max_price = alert below this many Gil per unit (NULL = no fixed limit),
//                    below_median = alert below the median of each watched place. At least one rule is set.
//                    Rows stay saved while a membership is paused (the bot skips them, the website hides them).
// alert_migrations   one-time copies that already ran (name -> time).
//
// One-time copy 'alert-split-1' (migrateOnce), run by whichever side starts first:
//   - each user's personal /datacenter list -> market_alert_dcs (users with market_alerts rows and no personal list:
//     any one older per-server list, the same one the bot used for market alerts);
//   - for users with Retainer Watch: market_alerts.alert_interval -> alert_settings (kind 'retainer'), DM switch ON
//     (retainer undercuts were always sent by DM until now), no retainer channels.
// Guarded: the marker row is inserted in the same transaction as the copy (INSERT IGNORE on its primary key), so it
// runs once even if the bot and the website start together (the second one waits on the row lock, then sees it done).
// The copy itself only uses INSERT IGNORE, so it never overwrites anything a user saved.

const MIGRATION = 'alert-split-1';
const KINDS = ['retainer', 'item'];
const INTERVALS = [0, 1, 2, 5, 10, 15, 30];

const DDL = [
    `CREATE TABLE IF NOT EXISTS alert_settings (
        user_id VARCHAR(32) NOT NULL,
        kind VARCHAR(8) NOT NULL,
        dm TINYINT NOT NULL DEFAULT 1,
        alert_interval TINYINT NOT NULL DEFAULT 1,
        updated_at BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS alert_channels (
        user_id VARCHAR(32) NOT NULL,
        kind VARCHAR(8) NOT NULL,
        guild_id VARCHAR(32) NOT NULL,
        channel_id VARCHAR(32) NOT NULL,
        role_id VARCHAR(32) NULL DEFAULT NULL,
        position INT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, kind, guild_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS market_alert_dcs (
        user_id VARCHAR(32) NOT NULL PRIMARY KEY,
        datacenters TEXT,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS item_alerts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        item_id INT NOT NULL,
        item_name VARCHAR(120) NOT NULL DEFAULT '',
        quality VARCHAR(4) NOT NULL DEFAULT 'nq',
        places TEXT,
        max_price INT UNSIGNED NULL DEFAULT NULL,
        below_median TINYINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL DEFAULT 0,
        UNIQUE KEY uniq_user_item (user_id, item_id),
        KEY idx_item (item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS alert_migrations (
        name VARCHAR(64) NOT NULL PRIMARY KEY,
        done_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

const missing = err => !!err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR' ||
    /doesn't exist|Unknown column|no such table/i.test(String(err.message)));

function parseList(value) {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
    } catch (e) {
        return [];
    }
}

async function createTables(pool) {
    for (const sql of DDL) await pool.execute(sql);
}

// Rows of a SELECT, or [] when that table / column does not exist yet
async function rowsOr(conn, sql, params) {
    try {
        const [rows] = await conn.execute(sql, params || []);
        return rows || [];
    } catch (err) {
        if (missing(err)) return null;
        throw err;
    }
}

// INSERT IGNORE in chunks (never overwrites a saved row)
async function insertIgnore(conn, head, rows, width) {
    for (let i = 0; i < rows.length; i += 200) {
        const part = rows.slice(i, i + 200);
        await conn.execute(head + ' VALUES ' + part.map(() => '(' + Array(width).fill('?').join(', ') + ')').join(', '), part.flat());
    }
}

// The copy itself (inside migrateOnce's transaction). Returns { dcs, retainers } = rows offered (INSERT IGNORE).
async function copyOldSettings(conn, now) {
    // Market alert Data Centers: personal /datacenter first; market alert users without one: any one older per-server list
    const dcRows = (await rowsOr(conn, 'SELECT user_id, guild_id, datacenters FROM user_datacenters')) || [];
    const marketRows = (await rowsOr(conn, 'SELECT user_id FROM market_alerts')) || [];
    const marketUsers = new Set(marketRows.map(r => String(r.user_id)));
    const chosen = new Map(); // userId -> { personal, list }
    for (const r of dcRows) {
        const id = String(r.user_id);
        const personal = r.guild_id === 'personal';
        if (!personal && !marketUsers.has(id)) continue;
        const list = parseList(r.datacenters);
        if (!list.length) continue;
        const cur = chosen.get(id);
        if (!cur || (personal && !cur.personal)) chosen.set(id, { personal, list });
    }
    const dcInsert = Array.from(chosen, ([id, c]) => [id, JSON.stringify(c.list), now]);
    await insertIgnore(conn, 'INSERT IGNORE INTO market_alert_dcs (user_id, datacenters, updated_at)', dcInsert, 3);

    // Retainer undercut settings: the market alert timing they had, DM on, no channels
    const watchRows = await rowsOr(conn, 'SELECT DISTINCT user_id FROM retainer_watch');
    let retInsert = [];
    if (watchRows && watchRows.length) {
        const intervalRows = (await rowsOr(conn, 'SELECT user_id, alert_interval FROM market_alerts')) || [];
        const interval = new Map(intervalRows.map(r => [String(r.user_id), Number(r.alert_interval)]));
        retInsert = watchRows.map(r => {
            const id = String(r.user_id);
            const m = interval.has(id) && INTERVALS.includes(interval.get(id)) ? interval.get(id) : 1;
            return [id, 'retainer', 1, m, now];
        });
        await insertIgnore(conn, 'INSERT IGNORE INTO alert_settings (user_id, kind, dm, alert_interval, updated_at)', retInsert, 5);
    }
    return { dcs: dcInsert.length, retainers: retInsert.length };
}

// Runs the one-time copy if it has not run yet. Returns the copy counts, or null when it already ran.
async function migrateOnce(pool, now) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [res] = await conn.execute('INSERT IGNORE INTO alert_migrations (name, done_at) VALUES (?, ?)', [MIGRATION, now]);
        if (!res || !res.affectedRows) {
            await conn.rollback();
            return null;
        }
        const out = await copyOldSettings(conn, now);
        await conn.commit();
        return out;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// Tables + the one-time copy (call before reading or writing any of these tables)
async function ensureAlertSplit(pool, now) {
    await createTables(pool);
    return migrateOnce(pool, now || Date.now());
}

module.exports = { MIGRATION, KINDS, INTERVALS, DDL, createTables, migrateOnce, ensureAlertSplit, copyOldSettings, parseList };
