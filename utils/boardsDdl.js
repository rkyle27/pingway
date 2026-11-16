// Boards tables (Static / FC / Community event posters on pingway.app). This file is IDENTICAL in both repos:
//   website: lib/boardsDdl.js      bot: utils/boardsDdl.js
// Change both together, so whichever side starts first creates exactly the same tables.
//
// board_posters   one poster: kind lfm (Looking for members) / lfs (Looking for a static) / fc (Free Company) / lffc (Looking for an FC)
//                 / event (Community event). Lists (content, roles, jobs, tags, worlds, links) are JSON text. The uploaded picture
//                 (WebP, made small in the browser) is kept in the row; image_ver changes with every new picture (its address).
//                 Static / FC posters expire 30 days after they were posted or bumped; events leave the boards when they start.
//                 hidden = 1 after 3 reports (until a dev brings it back on the Dev page). notify_* = the optional server channel post.
//                 expiry_dm_stage = the last expiry reminder DM the bot sent (5, 3 or 0 days left; NULL = none since the last bump).
// board_signups   one sign-up / recruitment offer / invite per user and poster (what they chose to send: IGN card, FFLogs, Tomestone)
// board_reports   one report per user and poster (reason + optional note)
// board_stars     one star per user and Community event

const BOARD_POSTERS_DDL = `CREATE TABLE IF NOT EXISTS board_posters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        kind VARCHAR(8) NOT NULL,
        owner_id VARCHAR(32) NOT NULL,
        owner_name VARCHAR(100) NOT NULL DEFAULT '',
        title VARCHAR(100) NOT NULL,
        description TEXT,
        region VARCHAR(40) NOT NULL DEFAULT '',
        dc VARCHAR(20) NOT NULL DEFAULT '',
        world VARCHAR(20) NOT NULL DEFAULT '',
        worlds VARCHAR(400) NOT NULL DEFAULT '[]',
        content VARCHAR(400) NOT NULL DEFAULT '[]',
        roles VARCHAR(200) NOT NULL DEFAULT '[]',
        jobs VARCHAR(400) NOT NULL DEFAULT '[]',
        tags VARCHAR(400) NOT NULL DEFAULT '[]',
        schedule VARCHAR(200) NOT NULL DEFAULT '',
        playtime VARCHAR(200) NOT NULL DEFAULT '',
        host VARCHAR(100) NOT NULL DEFAULT '',
        event_at BIGINT NOT NULL DEFAULT 0,
        links TEXT,
        image MEDIUMBLOB,
        image_type VARCHAR(20) DEFAULT NULL,
        image_ver VARCHAR(20) DEFAULT NULL,
        created_at BIGINT NOT NULL,
        bumped_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        hidden TINYINT(1) NOT NULL DEFAULT 0,
        report_count INT NOT NULL DEFAULT 0,
        star_count INT NOT NULL DEFAULT 0,
        notify_channel TINYINT(1) NOT NULL DEFAULT 0,
        notify_guild_id VARCHAR(32) DEFAULT NULL,
        notify_channel_id VARCHAR(32) DEFAULT NULL,
        notify_role_id VARCHAR(32) DEFAULT NULL,
        expiry_dm_stage TINYINT DEFAULT NULL,
        KEY idx_owner (owner_id),
        KEY idx_board (kind, hidden, expires_at),
        KEY idx_event (kind, event_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const BOARD_SIGNUPS_DDL = `CREATE TABLE IF NOT EXISTS board_signups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        poster_id INT NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        user_name VARCHAR(100) NOT NULL DEFAULT '',
        lodestone_id VARCHAR(20) DEFAULT NULL,
        char_name VARCHAR(64) DEFAULT NULL,
        char_world VARCHAR(64) DEFAULT NULL,
        send_card TINYINT(1) NOT NULL DEFAULT 0,
        fflogs_url VARCHAR(500) DEFAULT NULL,
        tomestone_url VARCHAR(500) DEFAULT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE KEY uq_signup (poster_id, user_id),
        KEY idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const BOARD_REPORTS_DDL = `CREATE TABLE IF NOT EXISTS board_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        poster_id INT NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        user_name VARCHAR(100) NOT NULL DEFAULT '',
        reason VARCHAR(16) NOT NULL,
        note VARCHAR(600) NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL,
        UNIQUE KEY uq_report (poster_id, user_id),
        KEY idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const BOARD_STARS_DDL = `CREATE TABLE IF NOT EXISTS board_stars (
        poster_id INT NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (poster_id, user_id),
        KEY idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const ALL_DDL = [BOARD_POSTERS_DDL, BOARD_SIGNUPS_DDL, BOARD_REPORTS_DDL, BOARD_STARS_DDL];

/** Creates every Boards table that is missing. db = pool or connection (execute). */
async function createBoardTables(db) {
    for (const ddl of ALL_DDL) await db.execute(ddl);
}

module.exports = { BOARD_POSTERS_DDL, BOARD_SIGNUPS_DDL, BOARD_REPORTS_DDL, BOARD_STARS_DDL, ALL_DDL, createBoardTables };
