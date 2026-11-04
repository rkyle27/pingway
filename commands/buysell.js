const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const M = require('../utils/marketTools');
const { SITE, linkRow, checkPerks, gil } = require('../utils/perkCommand');

// Supporter Perk: popular items listed cheaper on another world than on your home world.
// Uses your Market tools settings from the website (DC or whole region, Materia, filters, sort).
module.exports = {
    data: new SlashCommandBuilder()
        .setName('buysell')
        .setDescription('💜 Popular items that are cheaper on another world than on yours (Supporter Perk).'),

    async execute(interaction) {
        if (!(await checkPerks(interaction))) return;
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            const prefs = await M.loadPrefs(pool, interaction.user.id);
            if (!prefs || !prefs.world) {
                return interaction.editReply({ content: '🌍 Pick your world first on the website: **Retainers → Market tools**.', components: [linkRow('Open Market tools', SITE + '/retainers.html#market')] });
            }
            const r = await M.buySell(pool, { world: prefs.world, mode: prefs.dealMode, materia: prefs.materia, minDiff: prefs.minDiff, minSales: prefs.minSales, sorts: prefs.sorts.split(',') });
            if (r.warming) return interaction.editReply({ content: '⏳ Pingway is still collecting market data. Please try again in a few hours.' });
            const lines = r.items.map((it, i) => '`' + String(i + 1).padStart(2) + '` **' + it.name + '**\n      buy ' + gil(it.buyPrice) + ' on ' + (it.buyWorld || '?') + ' → sell ' + gil(it.sellAt) +
                ' · **+' + gil(it.profit) + '** (' + it.percent + '% cheaper) · ' + it.perDay + ' sold/day');
            const where = (r.mode === 'region' ? 'your region' : 'your data center') + (r.materia ? ' + Materia' : '');
            const embed = new EmbedBuilder().setColor(0x8b5cf6)
                .setTitle('🔁 Buy & sell for ' + prefs.world)
                .setDescription((lines.join('\n') || 'No deals with your filters right now.') + '\n\n-# Buying in ' + where + '. Sell price = the cheapest listing on ' + prefs.world + ' now; market tax not included.')
                .setFooter({ text: 'Change settings on pingway.app → Retainers → Market tools' });
            return interaction.editReply({ embeds: [embed], components: [linkRow('Market tools', SITE + '/retainers.html#market')] });
        } catch (err) {
            console.error('❌ [BUYSELL]', err.message);
            return interaction.editReply({ content: '❌ Universalis is not answering right now. Please try again in a minute.' });
        }
    }
};
