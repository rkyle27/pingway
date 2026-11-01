const { Events } = require('discord.js');

// The developer's Discord User ID (set DEVELOPER_DISCORD_ID in .env) so the bot can DM them when added to a new server
const DEVELOPER_DISCORD_ID = process.env.DEVELOPER_DISCORD_ID;

module.exports = {
    name: Events.GuildCreate,
    async execute(guild, client) {
        console.log(`🎉 Bot added to a new server: ${guild.name} (ID: ${guild.id})`);

        try {
            const owner = await guild.fetchOwner();
            const memberCount = guild.memberCount;
            
            const message = 
                `🎉 **Pingway was added to a new server!**\n\n` +
                `📌 **Server Name:** ${guild.name}\n` +
                `🆔 **Guild ID:** ${guild.id}\n` +
                `👑 **Owner:** ${owner.user.tag} (${owner.id})\n` +
                `👥 **Member Count:** ${memberCount}\n` +
                `📊 **Total Servers:** ${client.guilds.cache.size}`;

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