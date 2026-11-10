// Dev page tables (Dev / Staff logins, audit log, command queue, homepage countdown + poll, giveaways). This file is IDENTICAL in both repos:
//   website: lib/devDdl.js      bot: utils/devDdl.js
// Change both together, so whichever side starts first creates exactly the same tables.
//
// dev_users        who may open the Dev page: role 'dev' or 'staff'. Passwords are only ever stored as a slow hash (scrypt, own salt);
//                  setup_hash = SHA-256 of the one-time setup code (the code itself is never stored). Lockout after 5 wrong tries.
// dev_audit        every Dev / Staff action: who, when, what, before / after values (never passwords or setup codes)
// command_queue    commands from the Dev page that must run inside the bot (the bot polls every ~5 s and writes the result back)
// dev_settings     small Dev page settings (e.g. the Google Sheet id for the audit log export)
// site_countdown   the homepage countdown layer (one row, id = 1), uploaded image kept in the row
// site_polls       homepage polls; code = the poll's generated key, votes are stored with it
// site_poll_votes  one row per Discord account and poll (answers = JSON list of answer numbers)
// giveaways        Dev page giveaways: the reward, the server + member the bot picked, DM / claim state (v2.2 Part 8)

const DEV_USERS_DDL = `CREATE TABLE IF NOT EXISTS dev_users (
        user_id VARCHAR(32) PRIMARY KEY,
        role VARCHAR(8) NOT NULL,
        name VARCHAR(100) DEFAULT NULL,
        pass_hash VARCHAR(255) DEFAULT NULL,
        setup_hash CHAR(64) DEFAULT NULL,
        setup_expires BIGINT NOT NULL DEFAULT 0,
        fail_count INT NOT NULL DEFAULT 0,
        locked_until BIGINT NOT NULL DEFAULT 0,
        session_ver INT NOT NULL DEFAULT 1,
        added_by VARCHAR(32) DEFAULT NULL,
        created_at BIGINT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const DEV_AUDIT_DDL = `CREATE TABLE IF NOT EXISTS dev_audit (
        id INT AUTO_INCREMENT PRIMARY KEY,
        at BIGINT NOT NULL,
        actor_id VARCHAR(32) NOT NULL,
        actor_role VARCHAR(8) NOT NULL,
        action VARCHAR(64) NOT NULL,
        target VARCHAR(200) DEFAULT NULL,
        before_val MEDIUMTEXT,
        after_val MEDIUMTEXT,
        detail TEXT,
        KEY idx_at (at),
        KEY idx_action (action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const COMMAND_QUEUE_DDL = `CREATE TABLE IF NOT EXISTS command_queue (
        id INT AUTO_INCREMENT PRIMARY KEY,
        action VARCHAR(40) NOT NULL,
        args TEXT,
        state VARCHAR(10) NOT NULL DEFAULT 'pending',
        result MEDIUMTEXT,
        audit_id INT DEFAULT NULL,
        requested_by VARCHAR(32) NOT NULL,
        created_at BIGINT NOT NULL,
        started_at BIGINT NOT NULL DEFAULT 0,
        finished_at BIGINT NOT NULL DEFAULT 0,
        KEY idx_state (state, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const DEV_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS dev_settings (
        k VARCHAR(64) PRIMARY KEY,
        v TEXT,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const SITE_COUNTDOWN_DDL = `CREATE TABLE IF NOT EXISTS site_countdown (
        id TINYINT PRIMARY KEY,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        title VARCHAR(120) DEFAULT NULL,
        target_at BIGINT NOT NULL DEFAULT 0,
        zero_message VARCHAR(300) DEFAULT NULL,
        link_url VARCHAR(500) DEFAULT NULL,
        link_label VARCHAR(60) DEFAULT NULL,
        image MEDIUMBLOB,
        image_type VARCHAR(20) DEFAULT NULL,
        image_ver VARCHAR(20) DEFAULT NULL,
        updated_by VARCHAR(32) DEFAULT NULL,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const SITE_POLLS_DDL = `CREATE TABLE IF NOT EXISTS site_polls (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code CHAR(16) NOT NULL,
        question VARCHAR(300) NOT NULL,
        explanation TEXT,
        answers MEDIUMTEXT NOT NULL,
        multi TINYINT(1) NOT NULL DEFAULT 0,
        ends_at BIGINT NOT NULL DEFAULT 0,
        state VARCHAR(10) NOT NULL DEFAULT 'live',
        result_text TEXT,
        created_by VARCHAR(32) NOT NULL,
        created_at BIGINT NOT NULL,
        ended_at BIGINT NOT NULL DEFAULT 0,
        UNIQUE KEY uniq_code (code),
        KEY idx_state (state, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const SITE_POLL_VOTES_DDL = `CREATE TABLE IF NOT EXISTS site_poll_votes (
        poll_code CHAR(16) NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        answers TEXT NOT NULL,
        voted_at BIGINT NOT NULL,
        PRIMARY KEY (poll_code, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const GIVEAWAYS_DDL = `CREATE TABLE IF NOT EXISTS giveaways (
        id INT AUTO_INCREMENT PRIMARY KEY,
        reward_text VARCHAR(200) NOT NULL DEFAULT '',
        reward_kind VARCHAR(16) NOT NULL DEFAULT 'manual',
        reward_amount INT NOT NULL DEFAULT 0,
        state VARCHAR(12) NOT NULL DEFAULT 'picking',
        guild_id VARCHAR(32) DEFAULT NULL,
        guild_name VARCHAR(100) DEFAULT NULL,
        winner_id VARCHAR(32) DEFAULT NULL,
        winner_name VARCHAR(100) DEFAULT NULL,
        note VARCHAR(300) DEFAULT NULL,
        reroll_of INT DEFAULT NULL,
        queue_id INT DEFAULT NULL,
        grant_queue_id INT DEFAULT NULL,
        created_by VARCHAR(32) NOT NULL,
        created_at BIGINT NOT NULL,
        picked_at BIGINT NOT NULL DEFAULT 0,
        expires_at BIGINT NOT NULL DEFAULT 0,
        claimed_at BIGINT NOT NULL DEFAULT 0,
        KEY idx_state (state, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const ALL_DDL = [DEV_USERS_DDL, DEV_AUDIT_DDL, COMMAND_QUEUE_DDL, DEV_SETTINGS_DDL, SITE_COUNTDOWN_DDL, SITE_POLLS_DDL, SITE_POLL_VOTES_DDL, GIVEAWAYS_DDL];

/** Creates every Dev page table that is missing. db = pool or connection (execute). */
async function createDevTables(db) {
    for (const ddl of ALL_DDL) await db.execute(ddl);
}

module.exports = { DEV_USERS_DDL, DEV_AUDIT_DDL, COMMAND_QUEUE_DDL, DEV_SETTINGS_DDL, SITE_COUNTDOWN_DDL, SITE_POLLS_DDL, SITE_POLL_VOTES_DDL, GIVEAWAYS_DDL, ALL_DDL, createDevTables };
