// Voice tables (Google voice credits + My Settings -> Voice). This file is IDENTICAL in both repos:
//   website: lib/voiceDdl.js      bot: utils/voice/ddl.js
// Change both together, so whichever side starts first creates exactly the same tables.
//
// tts_char_lots       exact characters per batch (1 credit = 2,000 characters is only a display/input unit)
// voice_user_settings Google switch, nickname, max characters per message, member_until (console membership, ms or NULL)

const TTS_CHAR_LOTS_DDL = `CREATE TABLE IF NOT EXISTS tts_char_lots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        chars_total INT NOT NULL,
        chars_left INT NOT NULL,
        kofi_tx VARCHAR(80) DEFAULT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL DEFAULT 0,
        UNIQUE KEY uniq_tx (kofi_tx),
        KEY idx_user (user_id, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const VOICE_USER_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS voice_user_settings (
        user_id VARCHAR(32) PRIMARY KEY,
        google_on TINYINT(1) NOT NULL DEFAULT 1,
        nickname VARCHAR(32) DEFAULT NULL,
        max_chars SMALLINT DEFAULT NULL,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const MEMBER_UNTIL_ALTER = 'ALTER TABLE voice_user_settings ADD COLUMN member_until BIGINT NULL';

// The other side (bot / website) may have added the column at the same moment: that is fine.
const isDuplicateColumn = err => !!err && (err.code === 'ER_DUP_FIELDNAME' || err.errno === 1060 || /duplicate column/i.test(String(err.message)));

/** Creates both tables if missing and adds member_until if missing. db = pool or connection (execute). */
async function createVoiceTables(db) {
    await db.execute(TTS_CHAR_LOTS_DDL);
    await db.execute(VOICE_USER_SETTINGS_DDL);
    try {
        await db.execute(MEMBER_UNTIL_ALTER);
    } catch (err) {
        if (!isDuplicateColumn(err)) throw err;
    }
}

module.exports = { TTS_CHAR_LOTS_DDL, VOICE_USER_SETTINGS_DDL, MEMBER_UNTIL_ALTER, isDuplicateColumn, createVoiceTables };
