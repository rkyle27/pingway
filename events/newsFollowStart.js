// Pingway news follow: one startup pass ~60s after ready (so boot is not slowed), for servers not followed yet.
const { Events } = require('discord.js');
const { followAllOnce } = require('../utils/newsFollow');

const START_DELAY_MS = 60 * 1000;

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        setTimeout(() => { followAllOnce(client).catch(() => {}); }, START_DELAY_MS);
    }
};
