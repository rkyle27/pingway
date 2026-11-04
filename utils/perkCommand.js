// Shared bits for the Supporter Perks commands (/bestsellers, /buysell, /retainers).
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { ownerHasMembership } = require('./membership');
const { isMaintenance } = require('../maintenance');

const SITE = 'https://pingway.app';
const VOTE = 'https://top.gg/bot/1530586586524418048/vote';

const linkRow = (label, url, extra) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url),
    ...(extra ? [new ButtonBuilder().setLabel(extra[0]).setStyle(ButtonStyle.Link).setURL(extra[1])] : [])
);

// Replies and returns false when the command can't run (maintenance or no Supporter Perks)
async function checkPerks(interaction) {
    if (isMaintenance(interaction.guildId)) {
        await interaction.reply({ content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!', flags: [MessageFlags.Ephemeral] });
        return false;
    }
    if (!(await ownerHasMembership(interaction.user.id))) {
        await interaction.reply({
            content: '💜 This command is a **Supporter Perk** (10 points a month on My Settings).\nGet points by voting for Pingway on top.gg: 1 point per vote, 2 on weekends.',
            components: [linkRow('My Settings', SITE + '/me.html#perks', ['Vote on top.gg', VOTE])],
            flags: [MessageFlags.Ephemeral]
        });
        return false;
    }
    return true;
}

const gil = n => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('en-US') + ' gil';

module.exports = { SITE, linkRow, checkPerks, gil };
