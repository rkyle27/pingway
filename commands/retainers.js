const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const M = require('../utils/marketTools');
const { SITE, linkRow, checkPerks, gil } = require('../utils/perkCommand');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// Supporter Perk: your retainers from the website, each with how many of its items are undercut right now,
// and those items (your price vs the cheaper one). Uses what Retainer Watch already tracks.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('retainers')
        .setDescription(t('en', 'market.cmd.retainers')).setDescriptionLocalizations(discordLocalizations('market.cmd.retainers')),

    async execute(interaction) {
        if (!(await checkPerks(interaction))) return;
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const lang = await userLanguage.forInteraction(interaction);
        try {
            const [watches] = await pool.execute(
                "SELECT id, world_name, retainer_name, enabled, active FROM retainer_watch WHERE user_id = ? AND status = 'found' ORDER BY id", [interaction.user.id]
            );
            if (!watches.length) {
                return interaction.editReply({ content: t(lang, 'market.noRetainers'), components: [linkRow(t(lang, 'market.openRetainers'), SITE + '/retainers.html')] });
            }
            const blocks = [];
            const allIds = [];
            const perWatch = [];
            for (const w of watches) {
                const [items] = await pool.execute('SELECT item_id, hq, price, last_alert_price FROM retainer_items WHERE watch_id = ? AND last_alert_price IS NOT NULL AND last_alert_price < price ORDER BY item_id', [w.id]);
                items.forEach(i => allIds.push(Number(i.item_id)));
                perWatch.push({ w, items });
            }
            const names = allIds.length ? await M.itemNames(allIds, lang).catch(() => new Map()) : new Map();
            for (const { w, items } of perWatch) {
                const on = Number(w.active) === 1;
                const head = t(lang, 'market.retainerHead', { icon: items.length ? '🔻' : '✅', retainer: w.retainer_name, world: w.world_name, off: on ? '' : t(lang, 'market.retainerOff'), count: items.length ? t(lang, 'market.undercutCount', { count: items.length }) : t(lang, 'market.noUndercuts') });
                const rows = items.slice(0, 8).map(i => t(lang, 'market.retainerRow', { item: (names.get(Number(i.item_id)) || {}).name || (t(lang, 'market.itemFallback', { id: i.item_id })), hq: Number(i.hq) ? ' (HQ)' : '', yours: gil(i.price, lang), cheaper: gil(i.last_alert_price, lang) }));
                if (items.length > 8) rows.push(t(lang, 'market.andMore', { count: items.length - 8 }));
                blocks.push([head, ...rows].join('\n'));
            }
            let text = blocks.join('\n');
            if (text.length > 4000) text = text.slice(0, 3990) + '\n…';
            const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle(t(lang, 'market.yourRetainers')).setDescription(text)
                .setFooter({ text: t(lang, 'market.retainersFooter') });
            return interaction.editReply({ embeds: [embed], components: [linkRow(t(lang, 'market.openRetainers'), SITE + '/retainers.html')] });
        } catch (err) {
            console.error('❌ [RETAINERS CMD]', err.message);
            return interaction.editReply({ content: t(lang, 'market.retainersFailed') });
        }
    }
};
