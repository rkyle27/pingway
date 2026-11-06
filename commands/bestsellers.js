const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const M = require('../utils/marketTools');
const { SITE, linkRow, checkPerks, gil } = require('../utils/perkCommand');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// Supporter Perk: top selling items on your world or data center. Settings (world, world/DC) come from the
// Retainers page -> Market tools on the website.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('bestsellers')
        .setDescription(t('en', 'market.cmd.bestsellers')).setDescriptionLocalizations(discordLocalizations('market.cmd.bestsellers'))
        .addStringOption(o => o.setName('where').setDescription(t('en', 'market.cmd.bestsellersWhere')).setDescriptionLocalizations(discordLocalizations('market.cmd.bestsellersWhere'))
            .addChoices({ name: t('en', 'market.cmd.myWorld'), name_localizations: discordLocalizations('market.cmd.myWorld'), value: 'world' }, { name: t('en', 'market.cmd.myDc'), name_localizations: discordLocalizations('market.cmd.myDc'), value: 'dc' })),

    async execute(interaction) {
        if (!(await checkPerks(interaction))) return;
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const lang = await userLanguage.forInteraction(interaction);
        try {
            const prefs = await M.loadPrefs(pool, interaction.user.id);
            if (!prefs || !prefs.world) {
                return interaction.editReply({ content: t(lang, 'market.pickWorld'), components: [linkRow(t(lang, 'market.openMarketTools'), SITE + '/retainers.html#market')] });
            }
            const scope = interaction.options.getString('where') || prefs.bestScope;
            const r = await M.bestSellers(pool, { world: prefs.world, scope, lang });
            if (r.warming) return interaction.editReply({ content: t(lang, 'market.warming') });
            const lines = r.items.slice(0, 15).map((it, i) => t(lang, 'market.bestLine', { n: String(i + 1).padStart(2), name: it.name, perDay: it.perDay, avg: gil(it.avg, lang) }));
            const embed = new EmbedBuilder().setColor(0x8b5cf6)
                .setTitle(t(lang, 'market.bestTitle', { place: r.place }))
                .setDescription(lines.join('\n') || t(lang, 'market.noSales'))
                .setFooter({ text: t(lang, 'market.bestFooter') });
            return interaction.editReply({ embeds: [embed], components: [linkRow(t(lang, 'market.marketTools'), SITE + '/retainers.html#market')] });
        } catch (err) {
            console.error('❌ [BESTSELLERS]', err.message);
            return interaction.editReply({ content: t(lang, 'market.universalisDown') });
        }
    }
};
