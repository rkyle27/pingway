const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// One shared help list for /help and the chat "help" reply, so they never drift apart.
const WEBSITE_URL = 'https://pingway.vercel.app';
const INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=1530586586524418048';
const SUPPORT_URL = 'https://discord.gg/DDdV48X4G2';
const PRIVACY_URL = 'https://github.com/rkyle27/pingway/blob/main/privacy.md';

function buildHelpPayload() {
    const embed = new EmbedBuilder()
        .setTitle('📖 Pingway Commands Guide')
        .setColor('#9b6bff')
        .setDescription('🌐 **Manage Pingway in your browser!** Server settings and personal settings at **' + WEBSITE_URL + '**\n\nHere is everything Pingway can do:')
        .addFields(
            {
                name: '💰 Market Board',
                value: '**/price <item>** — Cross-world prices across your Data Centers.\n' +
                       '**/datacenter** — Choose your Data Centers (used everywhere).\n' +
                       '**/marketalert** — DMs every 5 min with listings 80%+ below the usual price.'
            },
            {
                name: '🌍 Status & Timers',
                value: '**/status** — World status, and DM alerts for your world.\n' +
                       '**/timer** — Daily/weekly resets, housing lottery, release countdowns.\n' +
                       '**/todo** — Your daily & weekly checklist.\n' +
                       '**/firmament** — Personal Skyrise Celebration timer with DM.'
            },
            {
                name: '🎯 Party & Raids',
                value: '**/pf** — Party Finder listings with role & job slots.\n' +
                       '**/raid** — 7-day raid schedule from Google Sheets.\n' +
                       '**/poll** — Polls with role-limited voting and results.'
            },
            {
                name: '🪪 Character',
                value: '**/ign** — Your character card with Lodestone info & QR code.\n' +
                       '**/ignconfig** — Link Lodestone, main job, photos, Tomestone & FFLogs.'
            },
            {
                name: '🃏 Games',
                value: '**/sciondex** — Recruit NPCs, build a party, fight bosses.\n' +
                       '**/nissi** — TEA Nissi mechanics quiz.'
            },
            {
                name: '🤖 AI Assistant',
                value: 'Only in channels an admin enabled with **/ailistenhere**. Chat naturally, e.g.\n' +
                       '*"Remind me to do roulettes in 2 hours"* · *"Add task Buy Pots"* · *"Show my task list"*\n' +
                       'Say **release recollection** to wipe the short chat memory.'
            },
            {
                name: '🛠️ Admin',
                value: '**/ailistenhere** — Turn AI chat on/off in this channel.\n' +
                       '**/notifhere** — Set this channel for Pingway notifications.\n' +
                       '**/clean** — Bulk-delete messages (also older than 14 days).\n' +
                       '**/logger** — Log command usage to a Google Sheet.'
            },
            {
                name: '📨 Other',
                value: '**/clearbotdms** — Clean up Pingway\'s messages in your DMs.\n' +
                       '**/help** — This guide.'
            }
        )
        .setFooter({ text: 'Pingway FFXIV Discord Bot • Developed by River Zola' });

    const links = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Website').setEmoji('🌐').setURL(WEBSITE_URL),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Invite').setEmoji('➕').setURL(INVITE_URL),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Support').setEmoji('💬').setURL(SUPPORT_URL),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Privacy').setEmoji('🔒').setURL(PRIVACY_URL)
    );

    return { embeds: [embed], components: [links] };
}

module.exports = { buildHelpPayload, WEBSITE_URL };
