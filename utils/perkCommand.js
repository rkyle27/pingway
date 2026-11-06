// Shared bits for the Supporter Perks commands (/bestsellers, /buysell, /retainers).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { ownerHasMembership } = require('./membership');
const { isMaintenance } = require('../maintenance');
const { t, localeOf } = require('./i18n');
const userLanguage = require('./userLanguage');

const SITE = 'https://pingway.app';
const VOTE = 'https://top.gg/bot/1530586586524418048/vote';

const linkRow = (label, url, extra) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url),
    ...(extra ? [new ButtonBuilder().setLabel(extra[0]).setStyle(ButtonStyle.Link).setURL(extra[1])] : [])
);

// Replies and returns false when the command can't run (maintenance or no Supporter Perks)
async function checkPerks(interaction) {
    const lang = await userLanguage.forInteraction(interaction);
    if (isMaintenance(interaction.guildId)) {
        await interaction.reply({ content: t(lang, 'core.maintenance'), flags: [MessageFlags.Ephemeral] });
        return false;
    }
    if (!(await ownerHasMembership(interaction.user.id))) {
        await interaction.reply({
            content: t(lang, 'perks.needPerks'),
            components: [linkRow(t(lang, 'perks.mySettings'), SITE + '/me.html#perks', [t(lang, 'perks.voteTopgg'), VOTE])],
            flags: [MessageFlags.Ephemeral]
        });
        return false;
    }
    return true;
}

const gil = (n, lang) => (n === null || n === undefined) ? '—' : t(lang, 'perks.gil', { n: Number(n).toLocaleString(localeOf(lang)) });

module.exports = { SITE, linkRow, checkPerks, gil };
