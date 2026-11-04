// Shared menu for /raid and /logger: Open sheet / Check schedule (raid only) / Create sheet (admins).
// Sheets are listed per member: only ON sheets, and only those with no role or a role the member has (admins see all).
const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
    StringSelectMenuBuilder, RoleSelectMenuBuilder, PermissionFlagsBits
} = require('discord.js');
const S = require('./guildSheets');
const { isMaintenance } = require('../maintenance');

const SITE = 'https://pingway.app';
const label = kind => (kind === 'raid' ? 'raid' : 'logger');

function linkRows(sheets) {
    const rows = [];
    for (let i = 0; i < Math.min(sheets.length, 20); i += 5) {
        rows.push(new ActionRowBuilder().addComponents(sheets.slice(i, i + 5).map(s =>
            new ButtonBuilder().setLabel(String(s.name).slice(0, 80)).setStyle(ButtonStyle.Link).setURL(S.sheetUrl(s.sheet_id)))));
    }
    return rows;
}

async function run(interaction, kind) {
    if (isMaintenance(interaction.guildId)) {
        return interaction.reply({ content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!', flags: [MessageFlags.Ephemeral] });
    }
    if (!interaction.guild) return interaction.reply({ content: 'This command only works in a server.', flags: [MessageFlags.Ephemeral] });
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    const all = await S.listSheets(interaction.guildId, kind);
    const visible = S.visibleTo(all, interaction.member, isAdmin);
    const title = kind === 'raid' ? '📅 **Raid sheets**' : '🗒️ **Logger sheets**';
    const intro = title + ' · ' + (visible.length ? visible.length + ' for you' : 'none for you yet' + (isAdmin ? '' : ' (ask an admin)')) +
        '\nManage names, roles and on/off on the website: ' + SITE + '/servers.html';

    const buttons = [new ButtonBuilder().setCustomId('gs_open').setLabel('Open sheet').setEmoji('🔗').setStyle(ButtonStyle.Primary).setDisabled(!visible.length)];
    if (kind === 'raid') buttons.push(new ButtonBuilder().setCustomId('gs_sched').setLabel('Check schedule').setEmoji('📅').setStyle(ButtonStyle.Secondary).setDisabled(!visible.length));
    if (isAdmin) buttons.push(new ButtonBuilder().setCustomId('gs_create').setLabel('Create sheet').setEmoji('➕').setStyle(ButtonStyle.Success));
    await interaction.reply({ content: intro, components: [new ActionRowBuilder().addComponents(buttons)], flags: [MessageFlags.Ephemeral] });
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 5 * 60 * 1000 });
    collector.on('collect', async i => {
        try {
            if (i.customId === 'gs_open') {
                return i.update({
                    content: title + '\n' + visible.map(s => '• **' + s.name + '**').join('\n') + (kind === 'raid' ? '\n\n' + S.LAYOUT_WARNING : ''),
                    components: linkRows(visible)
                });
            }
            if (i.customId === 'gs_sched' || i.customId === 'gs_pick') {
                const id = i.customId === 'gs_pick' ? Number(i.values[0]) : (visible.length === 1 ? visible[0].id : null);
                if (!id) {
                    const menu = new StringSelectMenuBuilder().setCustomId('gs_pick').setPlaceholder('Which raid sheet?')
                        .addOptions(visible.slice(0, 25).map(s => ({ label: String(s.name).slice(0, 100), value: String(s.id) })));
                    return i.update({ content: '📅 Pick a raid sheet:', components: [new ActionRowBuilder().addComponents(menu)] });
                }
                const sheet = visible.find(s => s.id === id);
                await i.deferUpdate();
                const { fetchRaidSchedule } = require('../events/interactions/raidHandler');
                let text = await fetchRaidSchedule(interaction.guildId, sheet.sheet_id);
                text = '**' + sheet.name + '**\n' + text;
                if (text.length > 1900) text = text.slice(0, 1890) + '\n…';
                return i.editReply({ content: text, components: linkRows([sheet]) });
            }
            if (i.customId === 'gs_create') {
                if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: '⚠️ Only administrators can create sheets.', flags: [MessageFlags.Ephemeral] });
                if (!S.helperReady()) return i.update({ content: '⚠️ Pingway can\'t create sheets right now. Please try again later.', components: [] });
                const modal = new ModalBuilder().setCustomId('gs_create_modal_' + i.id).setTitle(kind === 'raid' ? 'New raid sheet' : 'New logger sheet')
                    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Sheet name')
                        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setPlaceholder(kind === 'raid' ? 'e.g. Static A' : 'e.g. Command log')));
                await i.showModal(modal);
                const sub = await i.awaitModalSubmit({ filter: m => m.customId === 'gs_create_modal_' + i.id, time: 5 * 60 * 1000 }).catch(() => null);
                if (!sub) return;
                const name = sub.fields.getTextInputValue('name').trim().slice(0, 100) || (kind === 'raid' ? 'Raid' : 'Log');
                const roleMenu = new RoleSelectMenuBuilder().setCustomId('gs_role').setPlaceholder('Who can see it? Pick a role').setMinValues(1).setMaxValues(1);
                await sub.update({
                    content: '➕ **' + name + '**: which role can see this sheet in /' + label(kind) + '? (Admins always see every sheet.)',
                    components: [new ActionRowBuilder().addComponents(roleMenu),
                        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gs_everyone').setLabel('Everyone').setStyle(ButtonStyle.Secondary))]
                });
                const pick = await message.awaitMessageComponent({ filter: x => x.user.id === interaction.user.id && ['gs_role', 'gs_everyone'].includes(x.customId), time: 5 * 60 * 1000 }).catch(() => null);
                if (!pick) return;
                await pick.deferUpdate();
                const roleId = pick.customId === 'gs_role' ? pick.values[0] : null;
                await pick.editReply({ content: '⏳ Creating **' + name + '**…', components: [] });
                const res = await S.createSheet(interaction.guild, { kind, name, roleId, userId: interaction.user.id }).catch(err => ({ ok: false, error: err.message }));
                if (!res.ok) return pick.editReply({ content: '❌ ' + res.error });
                return pick.editReply({
                    content: '✅ **' + name + '** is ready' + (roleId ? ' for <@&' + roleId + '>' : ' for everyone') + '. Anyone with the link can edit it.' +
                        (kind === 'raid' ? '\n' + S.LAYOUT_WARNING : ''),
                    components: linkRows([res.row]), allowedMentions: { parse: [] }
                });
            }
        } catch (err) {
            console.error('❌ [SHEETS] /' + label(kind) + ' menu:', err.message);
        }
    });
}

module.exports = { run };
