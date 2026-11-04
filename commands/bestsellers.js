const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const M = require('../utils/marketTools');
const { SITE, linkRow, checkPerks, gil } = require('../utils/perkCommand');

// Supporter Perk: top selling items on your world or data center. Settings (world, world/DC) come from the
// Retainers page -> Market tools on the website.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('bestsellers')
        .setDescription('💜 Top selling items on your world or data center (Supporter Perk).')
        .addStringOption(o => o.setName('where').setDescription('Your world or your whole data center (default: your website setting)')
            .addChoices({ name: 'My world', value: 'world' }, { name: 'My data center', value: 'dc' })),

    async execute(interaction) {
        if (!(await checkPerks(interaction))) return;
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            const prefs = await M.loadPrefs(pool, interaction.user.id);
            if (!prefs || !prefs.world) {
                return interaction.editReply({ content: '🌍 Pick your world first on the website: **Retainers → Market tools**.', components: [linkRow('Open Market tools', SITE + '/retainers.html#market')] });
            }
            const scope = interaction.options.getString('where') || prefs.bestScope;
            const r = await M.bestSellers(pool, { world: prefs.world, scope });
            if (r.warming) return interaction.editReply({ content: '⏳ Pingway is still collecting market data. Please try again in a few hours.' });
            const lines = r.items.slice(0, 15).map((it, i) => '`' + String(i + 1).padStart(2) + '` **' + it.name + '** · ' + it.perDay + ' sold/day · avg ' + gil(it.avg));
            const embed = new EmbedBuilder().setColor(0x8b5cf6)
                .setTitle('🏆 Best sellers on ' + r.place)
                .setDescription(lines.join('\n') || 'No sales found.')
                .setFooter({ text: 'Universalis market data · change settings on pingway.app → Retainers → Market tools' });
            return interaction.editReply({ embeds: [embed], components: [linkRow('Market tools', SITE + '/retainers.html#market')] });
        } catch (err) {
            console.error('❌ [BESTSELLERS]', err.message);
            return interaction.editReply({ content: '❌ Universalis is not answering right now. Please try again in a minute.' });
        }
    }
};
