const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const M = require('../utils/marketTools');
const { SITE, linkRow, checkPerks, gil } = require('../utils/perkCommand');

// Supporter Perk: your retainers from the website, each with how many of its items are undercut right now,
// and those items (your price vs the cheaper one). Uses what Retainer Watch already tracks.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('retainers')
        .setDescription('💜 Your watched retainers and their undercut items (Supporter Perk).'),

    async execute(interaction) {
        if (!(await checkPerks(interaction))) return;
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            const [watches] = await pool.execute(
                "SELECT id, world_name, retainer_name, enabled, active FROM retainer_watch WHERE user_id = ? AND status = 'found' ORDER BY id", [interaction.user.id]
            );
            if (!watches.length) {
                return interaction.editReply({ content: '🏷️ You have no retainers on Retainer Watch yet. Add them on the website.', components: [linkRow('Open Retainers', SITE + '/retainers.html')] });
            }
            const blocks = [];
            const allIds = [];
            const perWatch = [];
            for (const w of watches) {
                const [items] = await pool.execute('SELECT item_id, hq, price, last_alert_price FROM retainer_items WHERE watch_id = ? AND last_alert_price IS NOT NULL AND last_alert_price < price ORDER BY item_id', [w.id]);
                items.forEach(i => allIds.push(Number(i.item_id)));
                perWatch.push({ w, items });
            }
            const names = allIds.length ? await M.itemNames(allIds).catch(() => new Map()) : new Map();
            for (const { w, items } of perWatch) {
                const on = Number(w.active) === 1;
                const head = (items.length ? '🔻' : '✅') + ' **' + w.retainer_name + '** (' + w.world_name + ')' + (on ? '' : ' · off') + ' — ' +
                    (items.length ? items.length + ' undercut' : 'no undercuts');
                const rows = items.slice(0, 8).map(i => '      ' + ((names.get(Number(i.item_id)) || {}).name || ('Item ' + i.item_id)) + (Number(i.hq) ? ' (HQ)' : '') +
                    ': yours ' + gil(i.price) + ' · cheaper ' + gil(i.last_alert_price));
                if (items.length > 8) rows.push('      …and ' + (items.length - 8) + ' more');
                blocks.push([head, ...rows].join('\n'));
            }
            let text = blocks.join('\n');
            if (text.length > 4000) text = text.slice(0, 3990) + '\n…';
            const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('🏷️ Your retainers').setDescription(text)
                .setFooter({ text: 'From Retainer Watch (Universalis data; updates when players view the market board)' });
            return interaction.editReply({ embeds: [embed], components: [linkRow('Open Retainers', SITE + '/retainers.html')] });
        } catch (err) {
            console.error('❌ [RETAINERS CMD]', err.message);
            return interaction.editReply({ content: '❌ Could not load your retainers right now. Please try again in a minute.' });
        }
    }
};
