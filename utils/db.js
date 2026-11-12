const mysql = require('mysql2/promise');

// Encrypts traffic between the bot and the database (TLS 1.2+). Set DB_SSL=off only if the database doesn't support it.
// If the host gives you its CA certificate, put it in DB_CA to also verify the server (stops impersonation).
const DB_SSL = String(process.env.DB_SSL || 'on').toLowerCase();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bot_database',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    
    // --- TIMEOUT & STALE CONNECTION FIXES ---
    enableKeepAlive: true,        // Send TCP keepalive packets to prevent host drops
    keepAliveInitialDelay: 0,     // Start sending keepalive packets immediately
    connectTimeout: 10000,        // 10s max wait for initial connection before timing out
    maxIdle: 10,                  // Automatically purge idle connections
    idleTimeout: 60000,           // Drop connections that have been idle over 60s

    ssl: DB_SSL === 'off' ? undefined
        : process.env.DB_CA ? { ca: process.env.DB_CA, rejectUnauthorized: true, minVersion: 'TLSv1.2' }
        : { rejectUnauthorized: false, minVersion: 'TLSv1.2' }
});

async function initDatabase() {
    let connection;
    try {
        connection = await pool.getConnection();

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS server_settings (
                guild_id VARCHAR(64) PRIMARY KEY,
                raid_sheet_id VARCHAR(255) DEFAULT NULL,
                logger_sheet_id VARCHAR(255) DEFAULT NULL,
                startup_channel_id VARCHAR(64) DEFAULT NULL,
                sciondex_channel_id VARCHAR(64) DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // Migration check for pre-existing server_settings tables missing sciondex_channel_id
        const [sciondexChannelCol] = await connection.execute(`
            SHOW COLUMNS FROM server_settings LIKE 'sciondex_channel_id';
        `);

        if (sciondexChannelCol.length === 0) {
            await connection.execute(`
                ALTER TABLE server_settings ADD COLUMN sciondex_channel_id VARCHAR(64) DEFAULT NULL;
            `);
            console.log('🔄 Added "sciondex_channel_id" column to "server_settings" table.');
        }

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS party_finders (
                id VARCHAR(64) PRIMARY KEY,
                guild_id VARCHAR(64),
                user_id VARCHAR(64),
                data JSON,
                message_id VARCHAR(64) DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_datacenters (
                guild_id VARCHAR(64),
                user_id VARCHAR(64),
                datacenters TEXT,
                PRIMARY KEY (guild_id, user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS server_releases (
                guild_id VARCHAR(64) PRIMARY KEY,
                event_name VARCHAR(255),
                release_time VARCHAR(64),
                role_id VARCHAR(64),
                channel_id VARCHAR(64),
                is_notified BOOLEAN DEFAULT FALSE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS ai_memories (
                user_id VARCHAR(64) PRIMARY KEY,
                memory_text TEXT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS ai_active_channels (
                guild_id VARCHAR(64),
                channel_id VARCHAR(64),
                PRIMARY KEY (guild_id, channel_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // One AI channel per server: servers that still have several keep only the newest channel
        // (Discord channel IDs grow over time, so the highest ID is the most recently made channel).
        try {
            await connection.execute(`
                DELETE a FROM ai_active_channels a
                JOIN ai_active_channels b ON a.guild_id = b.guild_id AND CAST(a.channel_id AS UNSIGNED) < CAST(b.channel_id AS UNSIGNED)
            `);
        } catch (err) {
            console.warn('⚠️ [AI] Could not reduce servers to one AI channel:', err.message);
        }

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS firmament_personal_data (
                user_id VARCHAR(64) PRIMARY KEY,
                guild_id VARCHAR(64) DEFAULT NULL,
                next_celebration_timestamp BIGINT NOT NULL,
                cycle_length BIGINT DEFAULT 259200000,
                notify_dm TINYINT(1) DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_facts (
                user_id VARCHAR(64),
                fact_key VARCHAR(64),
                fact_value TEXT,
                PRIMARY KEY (user_id, fact_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS reminders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(64),
                channel_id VARCHAR(64),
                user_id VARCHAR(64),
                reminder_text TEXT,
                target_timestamp BIGINT,
                is_recurring BOOLEAN DEFAULT FALSE,
                is_sent BOOLEAN DEFAULT FALSE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // Migration check for pre-existing reminders tables missing recurrence_rule
        const [recurrenceCol] = await connection.execute("SHOW COLUMNS FROM reminders LIKE 'recurrence_rule';");
        if (recurrenceCol.length === 0) {
            await connection.execute('ALTER TABLE reminders ADD COLUMN recurrence_rule VARCHAR(255) DEFAULT NULL AFTER is_recurring;');
            console.log('🔄 Added "recurrence_rule" column to "reminders" table.');
        }

        await connection.execute(`
    		CREATE TABLE IF NOT EXISTS user_server_subscriptions (
                user_id VARCHAR(32) PRIMARY KEY,
                datacenter VARCHAR(64) NOT NULL,
                world VARCHAR(64) NOT NULL,
                notifications_enabled BOOLEAN DEFAULT TRUE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS guild_polls (
                poll_id VARCHAR(32) PRIMARY KEY,
                guild_id VARCHAR(32) NOT NULL,
                channel_id VARCHAR(32) NOT NULL,
                creator_id VARCHAR(32) NOT NULL,
                question VARCHAR(256) NOT NULL,
                allow_multiple BOOLEAN NOT NULL DEFAULT 0,
                answers JSON NOT NULL,
                roles JSON NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS poll_votes (
                poll_id VARCHAR(32) NOT NULL,
                user_id VARCHAR(32) NOT NULL,
                answer_index INT NOT NULL,
                PRIMARY KEY (poll_id, user_id, answer_index),
                FOREIGN KEY (poll_id) REFERENCES guild_polls(poll_id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS user_ign_config (
                user_id VARCHAR(32) PRIMARY KEY,
                lodestone_url TEXT NOT NULL,
                character_name VARCHAR(128) NOT NULL,
                title VARCHAR(128),
                world VARCHAR(64) NOT NULL,
                datacenter VARCHAR(64) NOT NULL,
                race_tribe VARCHAR(128),
                free_company VARCHAR(128),
                lodestone_portrait TEXT,
                custom_photo TEXT,
                custom_links TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS market_alerts (
                user_id VARCHAR(32) PRIMARY KEY,
                dm_enabled TINYINT(1) DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // --- SCIONDEX SYSTEM TABLES ---

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS sciondex_users (
                user_id VARCHAR(64) PRIMARY KEY,
                shards INT DEFAULT 0,
                phoenix_downs INT DEFAULT 0,
                stars INT DEFAULT 0,
                last_recruit_date DATE DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // Migration check for pre-existing sciondex_users tables missing the 'stars' column
        const [starsColumn] = await connection.execute(`
            SHOW COLUMNS FROM sciondex_users LIKE 'stars';
        `);

        if (starsColumn.length === 0) {
            await connection.execute(`
                ALTER TABLE sciondex_users ADD COLUMN stars INT DEFAULT 0 AFTER phoenix_downs;
            `);
            console.log('🔄 Added "stars" column to "sciondex_users" table.');
        }

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS sciondex_user_party (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(64) NOT NULL,
                slot INT NOT NULL CHECK (slot BETWEEN 1 AND 4),
                npc_id VARCHAR(64) NOT NULL,
                star INT DEFAULT 1,
                hp INT DEFAULT 100,
                atk INT DEFAULT 10,
                UNIQUE KEY user_slot (user_id, slot),
                FOREIGN KEY (user_id) REFERENCES sciondex_users(user_id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // Migration check for existing sciondex_user_party tables missing star, hp, or atk columns
        const [partyColumns] = await connection.execute(`
            SHOW COLUMNS FROM sciondex_user_party;
        `);
        const columnNames = partyColumns.map(col => col.Field);

        if (!columnNames.includes('star')) {
            await connection.execute(`ALTER TABLE sciondex_user_party ADD COLUMN star INT DEFAULT 1 AFTER npc_id;`);
            console.log('🔄 Added "star" column to "sciondex_user_party" table.');
        }
        if (!columnNames.includes('hp')) {
            await connection.execute(`ALTER TABLE sciondex_user_party ADD COLUMN hp INT DEFAULT 100 AFTER star;`);
            console.log('🔄 Added "hp" column to "sciondex_user_party" table.');
        }
        if (!columnNames.includes('atk')) {
            await connection.execute(`ALTER TABLE sciondex_user_party ADD COLUMN atk INT DEFAULT 10 AFTER hp;`);
            console.log('🔄 Added "atk" column to "sciondex_user_party" table.');
        }

        // --- One-time migrations (each runs only once, tracked in bot_migrations) ---
        await connection.execute('CREATE TABLE IF NOT EXISTS bot_migrations (name VARCHAR(100) PRIMARY KEY, ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;');
        const runOnce = async (name, fn) => {
            const [done] = await connection.execute('SELECT name FROM bot_migrations WHERE name = ?', [name]);
            if (done.length > 0) return;
            await fn();
            await connection.execute('INSERT INTO bot_migrations (name) VALUES (?)', [name]);
            console.log('🔄 One-time migration done: ' + name);
        };

        // /status used to auto-save Aether / Adamantoise with DM alerts ON. Turn those alerts off (users can turn them back on).
        await runOnce('status_auto_alerts_off_2026_10_31', async () => {
            const [result] = await connection.execute(
                "UPDATE user_server_subscriptions SET notifications_enabled = 0 WHERE datacenter = 'Aether' AND world = 'Adamantoise' AND notifications_enabled = 1"
            );
            console.log('   /status: DM alerts turned off for ' + result.affectedRows + ' auto-created subscription(s).');
        });

        // /marketalert no longer has its own Data Center picker (alerts use /datacenter). Remove the old data.
        await runOnce('drop_market_alerts_datacenters_2026_10_31', async () => {
            const [col] = await connection.execute("SHOW COLUMNS FROM market_alerts LIKE 'datacenters'");
            if (col.length > 0) {
                await connection.execute('ALTER TABLE market_alerts DROP COLUMN datacenters');
                console.log('   market_alerts: removed old "datacenters" column.');
            }
        });

        console.log('✅ MySQL2 database tables verified/initialized successfully.');
    } catch (err) {
        console.error('❌ Failed to connect to MySQL database:', err.message);
    } finally {
        if (connection) connection.release();
    }
}

// The database host closes connections that sit idle too long. The next query on such a connection fails
// with "disconnected by the server because of inactivity" before it runs, so it is safe to try once more
// on a fresh connection (the pool drops the dead one by itself).
function isIdleDisconnect(err) {
    return Boolean(err) && (err.errno === 4031 || /disconnected by the server because of inactivity/i.test(String(err.message || '')));
}
for (const method of ['execute', 'query']) {
    const original = pool[method].bind(pool);
    pool[method] = async (...args) => {
        try {
            return await original(...args);
        } catch (err) {
            if (!isIdleDisconnect(err)) throw err;
            return original(...args);
        }
    };
}

module.exports = { pool, initDatabase };