const { ActionRowBuilder, ComponentType, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { pool } = require('../../utils/db');
const { toDiscordTimestamp } = require('../../utils/hammertime');
const { isMaintenance } = require('../../maintenance');
const { t } = require('../../utils/i18n');
const userLanguage = require('../../utils/userLanguage');

module.exports = {
    async handleInteraction(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        // Maintenance Check: Block interaction when maintenance mode is ON
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: t(lang, 'core.maintenance'),
                flags: [MessageFlags.Ephemeral]
            });
        }

        const guildId = interaction.guildId;
        const cid = interaction.customId;

        const getGuildData = async () => {
            const [rows] = await pool.execute(`SELECT * FROM server_releases WHERE guild_id = ?`, [guildId]);
            return rows[0] || {};
        };

        const saveGuildData = async (data) => {
            const current = await getGuildData();

            const eventName = data.event_name !== undefined ? data.event_name : (current.event_name || null);
            const releaseTime = data.release_time !== undefined ? data.release_time : (current.release_time || null);
            const isNotified = data.is_notified !== undefined ? (data.is_notified ? 1 : 0) : (current.is_notified ? 1 : 0);
            const channelId = data.channel_id !== undefined ? data.channel_id : (current.channel_id || null);
            const roleId = data.role_id !== undefined ? data.role_id : (current.role_id || null);

            await pool.execute(
                `INSERT INTO server_releases (guild_id, event_name, release_time, role_id, channel_id, is_notified)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    event_name = VALUES(event_name),
                    release_time = VALUES(release_time),
                    role_id = VALUES(role_id),
                    channel_id = VALUES(channel_id),
                    is_notified = VALUES(is_notified)`,
                [guildId, eventName, releaseTime, roleId, channelId, isNotified]
            );
        };

        // 1. Set Date Button Trigger -> Opens Modal
        if (interaction.isButton() && cid === 'set_date') {
            if (!interaction.member.permissions.has('Administrator')) {
                return interaction.reply({ content: t(lang, 'release.adminsOnlyDate'), flags: [MessageFlags.Ephemeral] });
            }

            try {
                const now = new Date();
                const modal = new ModalBuilder()
                    .setCustomId('release_date_modal')
                    .setTitle(t(lang, 'release.modalTitle'));

                const nameInput = new TextInputBuilder()
                    .setCustomId('event_name_input')
                    .setLabel(t(lang, 'release.eventName'))
                    .setStyle(TextInputStyle.Short)
                    .setValue('Evercold Early Access')
                    .setRequired(true)
                    .setMaxLength(50);

                const yearInput = new TextInputBuilder()
                    .setCustomId('year_input')
                    .setLabel(t(lang, 'release.year'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(now.getFullYear()))
                    .setRequired(true)
                    .setMaxLength(4);

                const monthInput = new TextInputBuilder()
                    .setCustomId('month_input')
                    .setLabel(t(lang, 'release.month'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(now.getMonth() + 1))
                    .setRequired(true)
                    .setMaxLength(2);

                const dayInput = new TextInputBuilder()
                    .setCustomId('day_input')
                    .setLabel(t(lang, 'release.day'))
                    .setStyle(TextInputStyle.Short)
                    .setValue(String(now.getDate()))
                    .setRequired(true)
                    .setMaxLength(2);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(nameInput),
                    new ActionRowBuilder().addComponents(yearInput),
                    new ActionRowBuilder().addComponents(monthInput),
                    new ActionRowBuilder().addComponents(dayInput)
                );

                return await interaction.showModal(modal);
            } catch (err) {
                console.error("[ERROR] Failed to show release modal:", err);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({ content: t(lang, 'release.modalFailed'), flags: [MessageFlags.Ephemeral] }).catch(() => { });
                }
            }
        }

        // 2. Modal Submit Handler -> Proceeds to Hour, Minute, and GMT Selection Menus
        if (interaction.isModalSubmit() && cid === 'release_date_modal') {
            const eventName = interaction.fields.getTextInputValue('event_name_input');
            const year = interaction.fields.getTextInputValue('year_input');
            const month = interaction.fields.getTextInputValue('month_input');
            const day = interaction.fields.getTextInputValue('day_input');

            if (isNaN(year) || isNaN(month) || isNaN(day)) {
                return interaction.reply({ content: t(lang, 'release.invalidDate'), flags: [MessageFlags.Ephemeral] });
            }

            const state = { event_name: eventName, year, month, day, hour: '21', minute: '00', gmt: 9 };

            const hoursOptions = Array.from({ length: 24 }, (_, i) => {
                const h = String(i).padStart(2, '0');
                return { label: h, value: h };
            });

            const minutesOptions = Array.from({ length: 12 }, (_, i) => {
                const m = String(i * 5).padStart(2, '0');
                return { label: m, value: m };
            });

            const gmtOptions = Array.from({ length: 25 }, (_, i) => {
                const offset = i - 12;
                const label = `GMT ${offset >= 0 ? '+' + offset : offset}`;
                return { label, value: String(offset), default: offset === 9 };
            });

            const hoursMenu = new StringSelectMenuBuilder().setCustomId('release_sel_hour').setPlaceholder(t(lang, 'release.selectHour')).addOptions(hoursOptions);
            const minutesMenu = new StringSelectMenuBuilder().setCustomId('release_sel_minute').setPlaceholder(t(lang, 'release.selectMinute')).addOptions(minutesOptions);
            const gmtMenu = new StringSelectMenuBuilder().setCustomId('release_sel_gmt').setPlaceholder(t(lang, 'release.selectTz')).addOptions(gmtOptions);

            const row1 = new ActionRowBuilder().addComponents(hoursMenu);
            const row2 = new ActionRowBuilder().addComponents(minutesMenu);
            const row3 = new ActionRowBuilder().addComponents(gmtMenu);
            const row4 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('release_time_done').setLabel(t(lang, 'release.confirm')).setStyle(ButtonStyle.Success)
            );

            await interaction.reply({
                content: t(lang, 'release.timeSetup', { name: eventName, year, month, day }),
                components: [row1, row2, row3, row4],
                flags: [MessageFlags.Ephemeral]
            });

            const response = await interaction.fetchReply();
            const collector = response.createMessageComponentCollector({ time: 120000 });

            collector.on('collect', async i => {
                if (i.customId === 'release_sel_hour') {
                    state.hour = i.values[0];
                    await i.deferUpdate().catch(() => {});
                } else if (i.customId === 'release_sel_minute') {
                    state.minute = i.values[0];
                    await i.deferUpdate().catch(() => {});
                } else if (i.customId === 'release_sel_gmt') {
                    state.gmt = parseInt(i.values[0], 10);
                    await i.deferUpdate().catch(() => {});
                } else if (i.customId === 'release_time_done') {
                    const y = parseInt(state.year, 10);
                    const m = parseInt(state.month, 10) - 1;
                    const d = parseInt(state.day, 10);
                    const h = parseInt(state.hour, 10);
                    const min = parseInt(state.minute, 10);

                    const targetUtcMs = Date.UTC(y, m, d, h - state.gmt, min, 0);
                    const targetDate = new Date(targetUtcMs);

                    const fYear = targetDate.getUTCFullYear();
                    const fMonth = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
                    const fDay = String(targetDate.getUTCDate()).padStart(2, '0');
                    const fHour = String(targetDate.getUTCHours()).padStart(2, '0');
                    const fMin = String(targetDate.getUTCMinutes()).padStart(2, '0');
                    const fSec = String(targetDate.getUTCSeconds()).padStart(2, '0');

                    const formattedStorageString = `${fYear}/${fMonth}/${fDay} ${fHour}:${fMin}:${fSec}`;

                    await saveGuildData({
                        event_name: state.event_name,
                        release_time: formattedStorageString,
                        is_notified: false,
                        channel_id: interaction.channelId
                    });

                    const hammertimeStr = ` (${toDiscordTimestamp(targetDate.getTime(), 'f')})`;
                    await i.update({
                        content: t(lang, 'release.scheduled', { name: state.event_name, year: state.year, month: state.month, day: state.day, hour: state.hour, minute: state.minute, sign: state.gmt >= 0 ? '+' : '', gmt: state.gmt, timestamp: hammertimeStr }),
                        components: []
                    });
                    collector.stop();
                }
            });

            // --- COLLECTOR TIMEOUT CLEANUP ---
            collector.on('end', (collected, reason) => {
                if (reason !== 'user') {
                    interaction.editReply({
                        content: t(lang, 'release.expired'),
                        components: []
                    }).catch(() => {});
                }
            });
        }

        // 3. Get Notifications Button
        if (interaction.isButton() && cid === 'get_notif') {
            const guildData = await getGuildData();
            const savedRoleId = guildData.role_id;
            const isAdmin = interaction.member.permissions.has('Administrator');

            if (!savedRoleId) {
                if (!isAdmin) {
                    return interaction.reply({
                        content: t(lang, 'release.askAdmin'),
                        flags: [MessageFlags.Ephemeral]
                    });
                } else {
                    await interaction.guild.roles.fetch();
                    const roles = interaction.guild.roles.cache
                        .filter(r => !r.managed && r.id !== guildId)
                        .sort((a, b) => b.position - a.position)
                        .first(25);

                    if (roles.length === 0) {
                        return interaction.reply({
                            content: t(lang, 'release.noRoles'),
                            flags: [MessageFlags.Ephemeral]
                        });
                    }

                    const roleOptions = roles.map(r =>
                        new StringSelectMenuOptionBuilder()
                            .setLabel(r.name)
                            .setValue(r.id)
                    );

                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('release_role_setup')
                        .setPlaceholder(t(lang, 'release.selectRole'))
                        .addOptions(roleOptions);

                    const row = new ActionRowBuilder().addComponents(selectMenu);

                    return interaction.reply({
                        content: t(lang, 'release.adminSetup'),
                        components: [row],
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }

            const role = interaction.guild.roles.cache.get(savedRoleId);
            if (!role) {
                return interaction.reply({
                    content: t(lang, 'release.roleGone'),
                    flags: [MessageFlags.Ephemeral]
                });
            }

            // --- PERMISSION SAFETY CHECK FOR ROLE TOGGLING ---
            try {
                if (interaction.member.roles.cache.has(savedRoleId)) {
                    await interaction.member.roles.remove(role);
                    return interaction.reply({
                        content: t(lang, 'release.removed', { roleId: savedRoleId }),
                        flags: [MessageFlags.Ephemeral]
                    });
                } else {
                    await interaction.member.roles.add(role);
                    return interaction.reply({
                        content: t(lang, 'release.assigned', { roleId: savedRoleId }),
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            } catch (err) {
                console.error('[ERROR] Role toggle failed:', err);
                return interaction.reply({
                    content: t(lang, 'release.roleFailed'),
                    flags: [MessageFlags.Ephemeral]
                });
            }
        }

        // 4. Role Setup Select Menu Handler
        if (interaction.isStringSelectMenu() && cid === 'release_role_setup') {
            if (!interaction.member.permissions.has('Administrator')) {
                return interaction.reply({ content: t(lang, 'release.adminsOnly'), flags: [MessageFlags.Ephemeral] });
            }

            const selectedRoleId = interaction.values[0];
            await saveGuildData({ role_id: selectedRoleId });

            return interaction.update({
                content: t(lang, 'release.roleSet', { roleId: selectedRoleId }),
                components: []
            });
        }

        // 5. Test Notification Button
        if (interaction.isButton() && cid === 'test_notif') {
            if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: t(lang, 'release.adminsOnly'), flags: [MessageFlags.Ephemeral] });

            const guildData = await getGuildData();
            if (!guildData.release_time) return interaction.reply({ content: t(lang, 'release.noDate'), flags: [MessageFlags.Ephemeral] });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            const testTarget = new Date(Date.now() + 60000);
            const year = testTarget.getUTCFullYear();
            const month = String(testTarget.getUTCMonth() + 1).padStart(2, '0');
            const day = String(testTarget.getUTCDate()).padStart(2, '0');
            const hour = String(testTarget.getUTCHours()).padStart(2, '0');
            const minute = String(testTarget.getUTCMinutes()).padStart(2, '0');
            const second = String(testTarget.getUTCSeconds()).padStart(2, '0');

            const formattedTestDate = `${year}/${month}/${day} ${hour}:${minute}:${second}`;
            await saveGuildData({ release_time: formattedTestDate, is_notified: false });

            const hammertimeTestStr = toDiscordTimestamp(testTarget.getTime(), 'f');
            return interaction.editReply(t(lang, 'release.testStarted', { timestamp: hammertimeTestStr }));
        }
    }
};