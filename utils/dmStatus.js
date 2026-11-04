// Remembers users Pingway can't DM (DMs closed, or no server shared with Pingway), so their alerts are not
// collected or checked for nothing. Their alerts pause and are tried again later: after 6 hours, then 12, 24,
// and at most every 48 hours. The website shows a warning and has an "I fixed it" button that clears the pause.

const { pool } = require('./db');

const FIRST_WAIT_MS = 6 * 60 * 60 * 1000;
const MAX_WAIT_MS = 48 * 60 * 60 * 1000;

let blocked = new Map(); // userId -> retry_after (ms)
let tableReady = false;

async function ensureTable() {
    if (tableReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS dm_blocked (
        user_id VARCHAR(32) PRIMARY KEY,
        reason VARCHAR(40) NOT NULL,
        fails INT NOT NULL DEFAULT 1,
        since BIGINT NOT NULL,
        retry_after BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    tableReady = true;
}

// Called every 5 minutes (with the subscriber refresh)
async function load() {
    try {
        await ensureTable();
        const [rows] = await pool.execute('SELECT user_id, retry_after FROM dm_blocked');
        blocked = new Map(rows.map(r => [String(r.user_id), Number(r.retry_after)]));
    } catch (err) {
        console.error('❌ [DM STATUS] Could not load paused users:', err.message);
    }
}

function isBlocked(userId) {
    const retryAfter = blocked.get(String(userId));
    return retryAfter !== undefined && retryAfter > Date.now();
}

async function markFailed(userId, reason) {
    const id = String(userId);
    const now = Date.now();
    try {
        await ensureTable();
        const [[row]] = await pool.execute('SELECT fails FROM dm_blocked WHERE user_id = ?', [id]);
        const fails = row ? Number(row.fails) + 1 : 1;
        const retryAfter = now + Math.min(FIRST_WAIT_MS * Math.pow(2, fails - 1), MAX_WAIT_MS);
        await pool.execute(
            `INSERT INTO dm_blocked (user_id, reason, fails, since, retry_after) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE reason = VALUES(reason), fails = VALUES(fails), retry_after = VALUES(retry_after)`,
            [id, reason, fails, now, retryAfter]
        );
        blocked.set(id, retryAfter);
        console.log('📵 [DM STATUS] Can\'t DM user ' + id + ' (' + reason + '). Their alerts pause until ' + new Date(retryAfter).toISOString() + '.');
    } catch (err) {
        console.error('❌ [DM STATUS] Could not save paused user:', err.message);
    }
}

// A DM went through: clear any old pause
async function markOk(userId) {
    const id = String(userId);
    if (!blocked.has(id)) return;
    blocked.delete(id);
    try {
        await pool.execute('DELETE FROM dm_blocked WHERE user_id = ?', [id]);
        console.log('📬 [DM STATUS] DMs to user ' + id + ' work again. Alerts resumed.');
    } catch (err) {
        console.error('❌ [DM STATUS] Could not clear paused user:', err.message);
    }
}

module.exports = { load, isBlocked, markFailed, markOk };
