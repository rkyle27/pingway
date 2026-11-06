const { Events } = require('discord.js');
const { t } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// The developer's Discord User ID (set DEVELOPER_DISCORD_ID in .env) so the bot can DM them when added to a new server
const DEVELOPER_DISCORD_ID = process.env.DEVELOPER_DISCORD_ID;

module.exports = {
    name: Events.GuildCreate,
    async execute(guild, client) {
        console.log(`🎉 Bot added to a new server: ${guild.name} (ID: ${guild.id})`);

        try {
            const owner = await guild.fetchOwner();
            const memberCount = guild.memberCount;
            const lang = await userLanguage.forUser(DEVELOPER_DISCORD_ID);
            
            const message = 
                t(lang, 'guild.added', { server: guild.name, id: guild.id, owner: owner.user.tag, ownerId: owner.id, members: memberCount, total: client.guilds.cache.size });

            // Fetch your user account and send a DM notification
            const developer = await client.users.fetch(DEVELOPER_DISCORD_ID);
            if (developer) {
                await developer.send(message);
            }
        } catch (error) {
            console.error('❌ Failed to send guild creation notification DM:', error);
        }
    },
};