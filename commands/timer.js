const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, MessageFlags, RoleSelectMenuBuilder, PermissionsBitField } = require('discord.js');
const { pool } = require('../utils/db');
const { toDiscordTimestamp } = require('../utils/hammertime');
const { isMaintenance } = require('../maintenance');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('timer')
        .setDescription('⏳ Check dynamic countdowns for FFXIV daily/weekly resets and housing lotteries.'),

    async execute(interaction) {
        // Maintenance Check: Block command execution when maintenance mode is ON
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!',
                flags: [MessageFlags.Ephemeral]
            });
        }

        const now = new Date();
        const guildId = interaction.guildId;

        const formatEvercold = (diff) => {
            const months = Math.floor(diff / (1000 * 60 * 60 * 24 * 30));
            const days = Math.floor((diff % (1000 * 60 * 60 * 24 * 30)) / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            return `${months}M ${days}d ${hours}h ${minutes}m`;
        };

        const formatFFXIV = (diff) => {
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;
        };

        // --- Logic: Daily/Weekly/GC Resets ---
        let dailyReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 15, 0, 0));
        if (now.getTime() >= dailyReset.getTime()) {
            dailyReset.setUTCDate(dailyReset.getUTCDate() + 1);
        }

        let gcReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 0, 0));
        if (now >= gcReset) gcReset.setUTCDate(gcReset.getUTCDate() + 1);

        let weeklyReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0));
        while (weeklyReset.getUTCDay() !== 2 || now >= weeklyReset) weeklyReset.setUTCDate(weeklyReset.getUTCDate() + 1);

        // --- Logic: Housing Lottery ---
        const anchor = Date.UTC(2026, 6, 25, 15, 0, 0);
        const ENTRY_DURATION = 5 * 24 * 60 * 60 * 1000;
        const RESULTS_DURATION = 4 * 24 * 60 * 60 * 1000;
        const CYCLE = ENTRY_DURATION + RESULTS_DURATION;
        const timeSinceAnchor = now.getTime() - anchor;
        const timeInCycle = ((timeSinceAnchor % CYCLE) + CYCLE) % CYCLE;

        let housingPhase, housingTime, housingTarget;
        if (timeInCycle < ENTRY_DURATION) {
            housingPhase = "🏠 Entry Period (Bidding)";
            housingTime = ENTRY_DURATION - timeInCycle;
        } else {
            housingPhase = "⏱️ Results Period";
            housingTime = CYCLE - timeInCycle;
        }
        housingTarget = new Date(now.getTime() + housingTime);

        // --- Logic: Database Custom Event / Evercold ---
        let customFieldName = '❄️ Evercold Early Access';
        let evercoldField = "Not set. Use 'Specify Release Date' below.";
        let hasReleaseDate = false;

        try {
            const [rows] = await pool.execute(`SELECT * FROM server_releases WHERE guild_id = ?`, [guildId]);
            const data = rows[0];

            if (data) {
                if (data.event_name) {
                    customFieldName = `❄️ ${data.event_name}`;
                }
                if (data.release_time && typeof data.release_time === 'string') {
                    const parts = data.release_time.split(' ');
                    if (parts.length === 2) {
                        const [y, m, d] = parts[0].split('/');
                        const timeParts = parts[1].split(':');
                        const h = timeParts[0];
                        const min = timeParts[1] || 0;
                        const s = timeParts[2] || 0;
                        if (y && m && d && h) {
                            const targetUtcMs = Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(min, 10), parseInt(s, 10));
                            const target = new Date(targetUtcMs);
                            
                            hasReleaseDate = true;
                            const hammertimeStr = toDiscordTimestamp(target.getTime(), 'f');
                            const hammertimeRelative = toDiscordTimestamp(target.getTime(), 'R');
                            evercoldField = `**${formatEvercold(target - now)}** remaining (${hammertimeRelative})\nTarget: ${hammertimeStr}`;
                        }
                    }
                }
            }
        } catch (err) {
            console.error("[ERROR] Failed to fetch release data from MySQL database:", err);
        }

        const dailyHammertime = toDiscordTimestamp(dailyReset.getTime(), 'f');
        const gcHammertime = toDiscordTimestamp(gcReset.getTime(), 'f');
        const weeklyHammertime = toDiscordTimestamp(weeklyReset.getTime(), 'f');
        const housingHammertime = toDiscordTimestamp(housingTarget.getTime(), 'f');

        const embed = new EmbedBuilder()
            .setTitle('⏳ FFXIV & Event Timers')
            .setColor('#00aaff')
            .addFields(
                { name: customFieldName, value: evercoldField },
                { name: '🌅 Daily Reset', value: `**${formatFFXIV(dailyReset - now)}** remaining\nTarget: ${dailyHammertime}` },
                { name: '🎖️ GC Provisioning', value: `**${formatFFXIV(gcReset - now)}** remaining\nTarget: ${gcHammertime}` },
                { name: '🗓️ Weekly Reset', value: `**${formatFFXIV(weeklyReset - now)}** remaining\nTarget: ${weeklyHammertime}` },
                { name: '🏘️ Housing Lottery', value: `Phase: **${housingPhase}**\nRemaining: **${formatFFXIV(housingTime)}**\nTarget: ${housingHammertime}` }
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('set_date').setLabel('Specify Release Date').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('toggle_notif').setLabel('Toggle Notification').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('set_role').setLabel('Role').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('test_notif').setLabel('Test Notification').setStyle(ButtonStyle.Danger)
        );

        const responseMessage = await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });

        // --- Component Collector for Main Menu ---
        const collector = responseMessage.createMessageComponentCollector({ time: 300_000 });

        collector.on('collect', async (i) => {
            try {
                // Pass 'set_date' and 'test_notif' to release.js by ignoring them in this collector
                if (i.customId === 'set_date' || i.customId === 'test_notif') {
                    return; 
                }

                // --- TOGGLE NOTIFICATION BUTTON ---
                if (i.customId === 'toggle_notif') {
                    if (!hasReleaseDate) {
                        return i.reply({
                            content: '❌ No Release date is set yet.',
                            flags: [MessageFlags.Ephemeral]
                        });
                    }

                    let dbRoleId = null;
                    try {
                        const [rows] = await pool.execute(`SELECT role_id FROM server_releases WHERE guild_id = ?`, [guildId]);
                        if (rows.length > 0 && rows[0].role_id) {
                            dbRoleId = rows[0].role_id;
                        }
                    } catch (err) {
                        console.error('[ERROR] Failed to query role_id for notification toggle:', err);
                    }

                    if (!dbRoleId) {
                        return i.reply({
                            content: '⚠️ Ask an Admin to click the **Role** button to configure a notification role first.',
                            flags: [MessageFlags.Ephemeral]
                        });
                    }

                    const targetRole = i.guild.roles.cache.get(dbRoleId);
                    if (!targetRole) {
                        return i.reply({
                            content: '⚠️ The configured notification role no longer exists in this server. Ask an Admin to set a new role.',
                            flags: [MessageFlags.Ephemeral]
                        });
                    }

                    const member = i.member;
                    try {
                        if (member.roles.cache.has(dbRoleId)) {
                            await member.roles.remove(dbRoleId);
                            return i.reply({
                                content: `🔔 Notification removed! You will no longer receive pings for release alerts.`,
                                flags: [MessageFlags.Ephemeral]
                            });
                        } else {
                            await member.roles.add(dbRoleId);
                            return i.reply({
                                content: `✅ Notification enabled! You've been assigned the <@&${dbRoleId}> role.`,
                                flags: [MessageFlags.Ephemeral]
                            });
                        }
                    } catch (roleErr) {
                        console.error('[ERROR] Permission error adding/removing role:', roleErr);
                        return i.reply({
                            content: '❌ **Failed to update role:** Please ensure my bot role is placed above the notification role in Server Settings.',
                            flags: [MessageFlags.Ephemeral]
                        });
                    }
                }

                // --- ROLE BUTTON (ADMIN ONLY) ---
                if (i.customId === 'set_role') {
                    if (!i.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                        return i.reply({ content: '❌ Only Administrators can change the notification role for this server.', flags: [MessageFlags.Ephemeral] });
                    }

                    let selectedRoleId = null;
                    let savedRoleId = null;

                    try {
                        const [roleRows] = await pool.execute(`SELECT role_id FROM server_releases WHERE guild_id = ?`, [guildId]);
                        if (roleRows.length > 0 && roleRows[0].role_id) {
                            const existingRole = i.guild.roles.cache.get(roleRows[0].role_id);
                            if (existingRole) {
                                savedRoleId = existingRole.id;
                                selectedRoleId = savedRoleId; // Fallback to current database role if they just hit confirm
                            }
                        }
                    } catch (err) {
                        console.error('[ERROR] Failed to fetch notification role:', err);
                    }

                    const roleSelectBuilder = new RoleSelectMenuBuilder()
                        .setCustomId('role_select_menu')
                        .setPlaceholder('Select notification role...');

                    if (savedRoleId) {
                        roleSelectBuilder.setDefaultRoles(savedRoleId);
                    }

                    const selectRow = new ActionRowBuilder().addComponents(roleSelectBuilder);
                    const buttonRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('role_confirm').setLabel('Confirm').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId('role_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                    );

                    // Reply and capture the sub-message reference
                    const roleMessage = await i.reply({
                        content: '⚙️ Choose the notification role using the dropdown below, then click Confirm:',
                        components: [selectRow, buttonRow],
                        flags: [MessageFlags.Ephemeral],
                        withResponse: true
                    }).then(res => res.resource.message);

                    // Local collector specifically for this sub-menu
                    const roleCollector = roleMessage.createMessageComponentCollector({ time: 300_000 });

                    roleCollector.on('collect', async (subI) => {
                        try {
                            // --- TRACK SELECTION (NO SAVE YET) ---
                            if (subI.isRoleSelectMenu() && subI.customId === 'role_select_menu') {
                                selectedRoleId = subI.values[0];
                                return await subI.deferUpdate(); // Instantly acknowledge selection without timing out
                            }

                            // --- CONFIRM BUTTON (SAVE TO DB) ---
                            if (subI.customId === 'role_confirm') {
                                if (!selectedRoleId) {
                                    return subI.reply({
                                        content: '⚠️ Please select a role from the dropdown menu first.',
                                        flags: [MessageFlags.Ephemeral]
                                    });
                                }

                                try {
                                    await pool.execute(
                                        `INSERT INTO server_releases (guild_id, role_id) VALUES (?, ?) 
                                         ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)`,
                                        [guildId, selectedRoleId]
                                    );

                                    roleCollector.stop();
                                    return subI.update({
                                        content: `✅ Notification role successfully updated to <@&${selectedRoleId}>!`,
                                        components: []
                                    });
                                } catch (dbErr) {
                                    console.error('[ERROR] Failed to save notification role to database:', dbErr);
                                    return subI.update({
                                        content: '❌ Failed to save the role to the database.',
                                        components: []
                                    });
                                }
                            }

                            // --- CANCEL BUTTON ---
                            if (subI.customId === 'role_cancel') {
                                roleCollector.stop();
                                return await subI.update({
                                    content: 'Role selection canceled.',
                                    components: []
                                });
                            }
                        } catch (subErr) {
                            console.error('[ERROR] Role sub-menu handling error:', subErr);
                        }
                    });
                }
            } catch (err) {
                console.error('[ERROR] Collector handling error:', err);
            }
        });

        // Disable buttons on collector expiration
        collector.on('end', () => {
            const disabledRow = new ActionRowBuilder().addComponents(
                row.components.map(button => ButtonBuilder.from(button).setDisabled(true))
            );
            interaction.editReply({ components: [disabledRow] }).catch(() => {});
        });
    }
};