const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('./i18n');

// One shared help list for /help and the chat "help" reply, so they never drift apart.
const WEBSITE_URL = 'https://pingway.app';
const INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=1530586586524418048';
const SUPPORT_URL = 'https://discord.gg/DDdV48X4G2';
const PRIVACY_URL = 'https://github.com/rkyle27/pingway/blob/main/privacy.md';

// Texts: locales/<lang>/help.json (lang = the reader's language, English by default)
const FIELDS = ['market', 'perks', 'status', 'party', 'character', 'games', 'ai', 'admin', 'other'];

function buildHelpPayload(lang = 'en') {
    const embed = new EmbedBuilder()
        .setTitle(t(lang, 'help.title'))
        .setColor('#9b6bff')
        .setDescription(t(lang, 'help.description', { url: WEBSITE_URL }))
        .addFields(FIELDS.map(k => ({ name: t(lang, 'help.fields.' + k + '.name'), value: t(lang, 'help.fields.' + k + '.value') })))
        .setFooter({ text: t(lang, 'help.footer') });

    const links = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'help.buttons.website')).setEmoji('🌐').setURL(WEBSITE_URL),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'help.buttons.invite')).setEmoji('➕').setURL(INVITE_URL),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'help.buttons.support')).setEmoji('💬').setURL(SUPPORT_URL),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'help.buttons.privacy')).setEmoji('🔒').setURL(PRIVACY_URL)
    );

    return { embeds: [embed], components: [links] };
}

module.exports = { buildHelpPayload, WEBSITE_URL };
