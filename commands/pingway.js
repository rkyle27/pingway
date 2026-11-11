// /pingway language: English | Français | Deutsch | 日本語 | Auto - choose the language of Pingway's replies and DMs for yourself.
// One command, one required option (no sub-commands). Saved in user_language (shared with the website:
// My Settings -> Bot language). "auto" = your Discord app language.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { t, fromDiscordLocale, discordLocalizations, DEFAULT_LANG } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// option value -> saved value ('jp' is shown to users, the code inside Pingway is 'ja')
const CHOICES = { en: 'en', fr: 'fr', de: 'de', jp: 'ja', auto: null };

const data = new SlashCommandBuilder()
    .setName('pingway')
    .setDescription(t('en', 'pingway.cmd.description'))
    .setDescriptionLocalizations(discordLocalizations('pingway.cmd.description'))
    .addStringOption(o => o
        .setName('language')
        .setNameLocalizations(discordLocalizations('pingway.cmd.languageName'))
        .setDescription(t('en', 'pingway.cmd.language'))
        .setDescriptionLocalizations(discordLocalizations('pingway.cmd.language'))
        .setRequired(true)
        .addChoices(...Object.keys(CHOICES).map(value => ({
            name: t('en', 'pingway.cmd.choices.' + value),
            name_localizations: discordLocalizations('pingway.cmd.choices.' + value),
            value
        }))));

module.exports = {
    data,
    CHOICES,

    async execute(interaction) {
        const value = interaction.options.getString('language', true);
        if (!Object.prototype.hasOwnProperty.call(CHOICES, value)) return;
        const choice = CHOICES[value];
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // saving can take a moment
        try {
            await userLanguage.setChoice(interaction.user.id, choice);
        } catch (err) {
            console.error('❌ [PINGWAY] Could not save the language choice:', err.message);
            const lang = await userLanguage.forInteraction(interaction);
            return interaction.editReply({ content: t(lang, 'pingway.saveFailed') });
        }
        // Reply in the NEW language (auto = the Discord app language)
        const lang = choice || fromDiscordLocale(interaction.locale) || DEFAULT_LANG;
        const content = choice
            ? t(lang, 'pingway.saved', { language: t(lang, 'pingway.names.' + lang) })
            : t(lang, 'pingway.savedAuto', { language: t(lang, 'pingway.names.' + lang) });
        return interaction.editReply({ content: content + '\n' + t(lang, 'pingway.website') });
    }
};
