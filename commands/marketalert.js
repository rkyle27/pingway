const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

const BT = String.fromCharCode(96); // backtick for inline code formatting

// Market alerts use the user's personal /datacenter setting (same data as /price)
async function getUserDCs(userId) {
    try {
        const [rows] = await pool.execute(
            'SELECT datacenters FROM user_datacenters WHERE user_id = ? ORDER BY (guild_id = ?) DESC LIMIT 1',
            [userId, 'personal']
        );
        if (rows.length > 0 && rows[0].datacenters) {
            const parsed = typeof rows[0].datacenters === 'string' ? JSON.parse(rows[0].datacenters) : rows[0].datacenters;
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch (e) {
        console.error('Error fetching /datacenter data for market alerts:', e);
    }
    return [];
}

async function getDmEnabled(userId) {
    const [rows] = await pool.execute('SELECT dm_enabled FROM market_alerts WHERE user_id = ?', [userId]);
    return rows.length > 0 ? Number(rows[0].dm_enabled) === 1 : false;
}

// DM interval chosen on the website (minutes). Missing column or row = 1 minute.
async function getInterval(userId) {
    try {
        const [rows] = await pool.execute('SELECT alert_interval FROM market_alerts WHERE user_id = ?', [userId]);
        const m = rows.length > 0 ? Number(rows[0].alert_interval) : 1;
        return [1, 2, 5, 10, 15, 30].includes(m) ? m : 1;
    } catch (e) {
        return 1;
    }
}

async function buildPayload(userId, notice, lang = 'en') {
    const dmEnabled = await getDmEnabled(userId);
    const dcs = await getUserDCs(userId);
    const interval = await getInterval(userId);
    const dcText = dcs.length > 0
        ? BT + dcs.join(', ') + BT
        : t(lang, 'marketalert.noneSet');

    const content = (notice ? notice + '\n\n' : '') +
        t(lang, 'marketalert.settings', {
            dm: dmEnabled ? t(lang, 'marketalert.on') : t(lang, 'marketalert.off'),
            dcs: dcText,
            interval: t(lang, interval === 1 ? 'marketalert.minute' : 'marketalert.minutes', { n: interval })
        });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('marketalert_toggle_dm')
            .setLabel(dmEnabled ? t(lang, 'marketalert.disable') : t(lang, 'marketalert.enable'))
            .setStyle(dmEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('marketalert_done')
            .setLabel(t(lang, 'marketalert.done'))
            .setStyle(ButtonStyle.Secondary)
    );

    return { content, components: [row] };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('marketalert')
        .setDescription(t('en', 'marketalert.cmd.description')).setDescriptionLocalizations(discordLocalizations('marketalert.cmd.description')),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        try {
            const payload = await buildPayload(interaction.user.id, undefined, lang);
            return interaction.reply(Object.assign(payload, { flags: [MessageFlags.Ephemeral] }));
        } catch (error) {
            console.error('Error opening /marketalert:', error);
            return interaction.reply({
                content: t(lang, 'marketalert.loadFailed'),
                flags: [MessageFlags.Ephemeral]
            }).catch(() => {});
        }
    },

    async handleInteraction(interaction) {
        if (!interaction.isButton()) return;
        const userId = interaction.user.id;
        const lang = await userLanguage.forInteraction(interaction);

        if (interaction.customId === 'marketalert_toggle_dm') {
            try {
                const newStatus = (await getDmEnabled(userId)) ? 0 : 1;
                await pool.execute(
                    'INSERT INTO market_alerts (user_id, dm_enabled) VALUES (?, ?) ON DUPLICATE KEY UPDATE dm_enabled = VALUES(dm_enabled)',
                    [userId, newStatus]
                );
                const notice = newStatus === 1
                    ? t(lang, 'marketalert.enabledNotice')
                    : t(lang, 'marketalert.disabledNotice');
                return interaction.update(await buildPayload(userId, notice, lang));
            } catch (error) {
                console.error('Error toggling marketalert DM status in MySQL:', error);
                return interaction.reply({
                    content: t(lang, 'marketalert.updateFailed'),
                    flags: [MessageFlags.Ephemeral]
                }).catch(() => {});
            }
        }

        if (interaction.customId === 'marketalert_done') {
            await interaction.deferUpdate().catch(() => {});
            return interaction.deleteReply().catch(() => {});
        }
    }
};
