const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// One shared help list for /help and the chat "help" reply, so they never drift apart.
const WEBSITE_URL = 'https://pingway.app';
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
                       '**/marketalert** — DMs listings 80%+ below the usual price (every minute by default; change the DM interval on the website).'
            },
            {
                name: '💜 Supporter Perks',
                value: '**/bestsellers** — Top selling items on your world or data center.\n' +
                       '**/buysell** — Popular items cheaper on another world than on yours.\n' +
                       '**/retainers** — Your watched retainers and their undercut items.\n' +
                       'Settings: website → Retainers → Market tools. Perks: 10 points a month (vote on top.gg for points).'
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
                value: '**/trivia** — Guess the FFXIV word of the day (6 difficulties), earn bits, keep your streak.\n' +
                       '**/sciondex** — Recruit NPCs, build a party, fight bosses.\n' +
                       '**/nissi** — TEA Nissi mechanics quiz.'
            },
            {
                name: '🤖 AI Assistant',
                value: 'Only in the AI channel an admin set with **/ailistenhere** (one per server). Chat naturally, e.g.\n' +
                       '*"Remind me to do roulettes in 2 hours"* · *"Add task Buy Pots"* · *"Show my task list"*\n' +
                       'Say **release recollection** to wipe the short chat memory.'
            },
            {
                name: '🛠️ Admin',
                value: '**/ailistenhere** — Move AI chat to this channel (run it again there to turn it off).\n' +
                       '**/notifhere** — Set this channel for Pingway notifications.\n' +
                       '**/clean** — Bulk-delete messages (also older than 14 days).\n' +
                       '**/honeypot** — "Do not chat here" channel that removes hacked spam accounts.\n' +
                       '**/logger** — Log command usage to a Google Sheet.\n' +
                       '🌐 On the website: **Reaction Roles**, **Tickets** (help desk) and **FFXIV News** channels.'
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
