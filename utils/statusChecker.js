const { pool } = require('./db');
const { isMaintenance } = require('../maintenance');
const axios = require('axios');
const { t } = require('./i18n');
const userLanguage = require('./userLanguage');

let previousStatuses = {};

function initStatusChecker(client) {
    // Run the check every 30 seconds
    setInterval(async () => {
        // Skip execution if global maintenance mode is active
        if (isMaintenance()) return;

        try {
            // 1. Fetch live server statuses from the v2indexdata endpoint safely with a 6-second timeout
            const response = await axios.get('https://is.xivup.com/v2indexdata', {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Accept': 'application/json'
                },
                timeout: 6000
            });

            const data = response.data;
            if (!data) return;

            const currentStatuses = {};

            // Helper to recursively pull world statuses from the nested xivup v2 payload
            function scanObject(node) {
                if (!node || typeof node !== 'object') return;
                
                const name = node.Name || node.name;
                const status = node.Status; // Status 4 means UP
                const onlineFlag = node.Online ?? node.online;

                if (name && typeof name === 'string') {
                    if (status !== undefined) {
                        currentStatuses[name.trim()] = (status === 4) ? 'UP' : 'DOWN';
                    } else if (onlineFlag !== undefined) {
                        currentStatuses[name.trim()] = onlineFlag ? 'UP' : 'DOWN';
                    }
                }

                for (const key of Object.keys(node)) {
                    scanObject(node[key]);
                }
            }

            scanObject(data);

            // If it's the first run, initialize history state without triggering alerts
            if (Object.keys(previousStatuses).length === 0) {
                previousStatuses = currentStatuses;
                return;
            }

            // 2. Fetch all active subscriptions from DB where notifications are enabled
            const [subscriptions] = await pool.execute(
                'SELECT user_id, datacenter, world FROM user_server_subscriptions WHERE notifications_enabled = 1'
            );

            if (!subscriptions || subscriptions.length === 0) {
                previousStatuses = currentStatuses;
                return;
            }

            for (const sub of subscriptions) {
                const world = sub.world;
                const oldStatus = previousStatuses[world];
                const newStatus = currentStatuses[world];

                // Strict check: Only trigger if the world was explicitly DOWN before and is now UP
                if (oldStatus === 'DOWN' && newStatus === 'UP') {
                    try {
                        const user = await client.users.fetch(sub.user_id).catch(() => null);
                        if (user) {
                            const lang = await userLanguage.forUser(sub.user_id); // DM: the user's language
                            await user.send(
                                t(lang, 'status.alertDm', { world, dc: sub.datacenter })
                            );
                            console.log(`[SUCCESS] Sent FFXIV status DM notification to user ${sub.user_id}`);
                        }
                    } catch (dmErr) {
                        console.error(`[ERROR] Could not send status DM to user ${sub.user_id}:`, dmErr.message);
                    }
                }
            }

            // Update cached history for the next cycle
            previousStatuses = currentStatuses;
        } catch (error) {
            if (error.code !== 'ECONNABORTED' && error.code !== 'ETIMEDOUT') {
                console.error('❌ Error in statusChecker loop:', error.message);
            }
        }
    }, 30000);
}

module.exports = { initStatusChecker };