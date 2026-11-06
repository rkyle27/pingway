const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const M = require('../utils/marketTools');
const { SITE, linkRow, checkPerks, gil } = require('../utils/perkCommand');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// Supporter Perk: popular items listed cheaper on another world than on your home world.
// Uses your Market tools settings from the website (DC or whole region, Materia, filters, sort).
module.exports = {
    data: new SlashCommandBuilder()
        .setName('buysell')
        .setDescription(t('en', 'market.cmd.buysell')).setDescriptionLocalizations(discordLocalizations('market.cmd.buysell')),

    async execute(interaction) {
        if (!(await checkPerks(interaction))) return;
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const lang = await userLanguage.forInteraction(interaction);
        try {
            const prefs = await M.loadPrefs(pool, interaction.user.id);
            if (!prefs || !prefs.world) {
                return interaction.editReply({ content: t(lang, 'market.pickWorld'), components: [linkRow(t(lang, 'market.openMarketTools'), SITE + '/retainers.html#market')] });
            }
            const r = await M.buySell(pool, { world: prefs.world, mode: prefs.dealMode, materia: prefs.materia, minDiff: prefs.minDiff, minSales: prefs.minSales, sorts: prefs.sorts.split(','), lang });
            if (r.warming) return interaction.editReply({ content: t(lang, 'market.warming') });
            const lines = r.items.map((it, i) => t(lang, 'market.buysellLine', { n: String(i + 1).padStart(2), name: it.name, buy: gil(it.buyPrice, lang), world: it.buyWorld || '?', sell: gil(it.sellAt, lang), profit: gil(it.profit, lang), percent: it.percent, perDay: it.perDay }));
            const where = (r.mode === 'region' ? t(lang, 'market.whereRegion') : t(lang, 'market.whereDc')) + (r.materia ? t(lang, 'market.plusMateria') : '');
            const embed = new EmbedBuilder().setColor(0x8b5cf6)
                .setTitle(t(lang, 'market.buysellTitle', { world: prefs.world }))
                .setDescription((lines.join('\n') || t(lang, 'market.noDeals')) + t(lang, 'market.buysellNote', { where, world: prefs.world }))
                .setFooter({ text: t(lang, 'market.footerSettings') });
            return interaction.editReply({ embeds: [embed], components: [linkRow(t(lang, 'market.marketTools'), SITE + '/retainers.html#market')] });
        } catch (err) {
            console.error('❌ [BUYSELL]', err.message);
            return interaction.editReply({ content: t(lang, 'market.universalisDown') });
        }
    }
};
