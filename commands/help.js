const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('📖 Lists all available Pingway bot commands and instructions.'),

    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('📖 Pingway Bot Commands Guide')
            .setColor('#00ffcc')
            .setDescription('Here is a complete list of commands available in Pingway:')
            .addFields(
                { name: '/price <item>', value: 'Check cross-world market board prices for an FFXIV item based on your configured Data Centers.' },
                { name: '/datacenter', value: 'Configure your preferred Data Centers for market board price lookups.' },
                { name: '/raid', value: 'View the upcoming 7-day raid schedule synced with Google Sheets.' },
                { name: '/timer', value: 'Check dynamic FFXIV reset timers, housing lottery status, and countdowns.' },
                { name: '/todo', value: 'Interactive checklist for daily and weekly FFXIV activities.' },
                { name: '/firmament', value: 'View or set up personal Skyrise Celebration / Firmament timers.' },
                { name: '/pf', value: 'Create and manage custom Party Finder listings with job slot claims.' },
				{ name: '/poll', value: 'Create a poll.' },
                { name: '/status', value: 'Check FFXIV server status & toggle notification.' },
                { name: '/ign', value: 'Generate a Card containing you Lodestone info, QRcode to Lodestone, etch.' },
                { name: '/ignconfig', value: 'Link your Lodestone, Custom Photo, and other infos.' },
                { name: '/ailistenhere', value: 'Toggle AI auto-listening in the current channel. (ADMIN)' },
                { name: '/notifhere', value: 'Set channel for notifications such as party finder, etc. (ADMIN)' },
                { name: '/clean', value: 'Wipe all bot messages or cached history. (ADMIN)' },
                { name: '/logger', value: 'Set up a google sheet to log commands used: Who, When & What command. (ADMIN)' },
                { name: '/clearbotdms', value: 'Clean up direct messages sent by the bot (Use inside Direct Messages with the bot).' }
            )
            .setFooter({ text: 'Pingway FFXIV Discord Bot Assistant • Developed by River Zola' });

        return interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }
};