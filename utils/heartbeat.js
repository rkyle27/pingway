// Bot status for the website: once a minute, write "I'm alive" (and whether maintenance mode is on) to the
// database. The website shows Online / Maintenance / Offline from it. Only a time and an on/off flag are
// stored - no servers or users.

const { pool } = require('./db');
const { isMaintenance } = require('../maintenance');

const EVERY_MS = 60 * 1000;
let started = false;
let tableReady = false;
let warned = 0;

async function beat() {
    try {
        if (!tableReady) {
            await pool.execute(`CREATE TABLE IF NOT EXISTS bot_heartbeat (
                id TINYINT PRIMARY KEY,
                last_seen BIGINT NOT NULL,
                maintenance TINYINT NOT NULL DEFAULT 0,
                started_at BIGINT NOT NULL DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
            tableReady = true;
        }
        const now = Date.now();
        await pool.execute(
            'INSERT INTO bot_heartbeat (id, last_seen, maintenance, started_at) VALUES (1, ?, ?, ?) ' +
            'ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), maintenance = VALUES(maintenance)' + (started === 'first' ? ', started_at = VALUES(started_at)' : ''),
            [now, isMaintenance() ? 1 : 0, now]
        );
        if (started === 'first') started = true;
    } catch (err) {
        // A missed beat just shows the bot as offline for a moment; log at most every 30 minutes
        if (Date.now() - warned > 30 * 60 * 1000) {
            warned = Date.now();
            console.warn('⚠️ [STATUS] Could not save the website status heartbeat:', err.message);
        }
    }
}

function start() {
    if (started) return;
    started = 'first';
    beat();
    setInterval(beat, EVERY_MS);
}

module.exports = { start, beat };
