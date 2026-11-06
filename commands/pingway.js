// /pingway en | fr | de | jp | auto - choose the language of Pingway's replies and DMs for yourself.
// Saved in user_language (shared with the website: My Settings -> Bot language). "auto" = your Discord app language.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { t, fromDiscordLocale, discordLocalizations, DEFAULT_LANG } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// subcommand -> saved value ('jp' is shown to users, the code inside Pingway is 'ja')
const CHOICES = { en: 'en', fr: 'fr', de: 'de', jp: 'ja', auto: null };

function addSub(builder, name) {
    return builder.addSubcommand(sub => sub
        .setName(name)
        .setDescription(t('en', 'pingway.cmd.' + name))
        .setDescriptionLocalizations(discordLocalizations('pingway.cmd.' + name)));
}

let data = new SlashCommandBuilder()
    .setName('pingway')
    .setDescription(t('en', 'pingway.cmd.description'))
    .setDescriptionLocalizations(discordLocalizations('pingway.cmd.description'));
for (const name of Object.keys(CHOICES)) data = addSub(data, name);

module.exports = {
    data,
    CHOICES,

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (!Object.prototype.hasOwnProperty.call(CHOICES, sub)) return;
        const choice = CHOICES[sub];
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
