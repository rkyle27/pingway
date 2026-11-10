const { 
    Events, 
    MessageFlags, 
    PermissionFlagsBits, 
    ChannelSelectMenuBuilder, 
    ChannelType, 
    ActionRowBuilder 
} = require('discord.js');
const path = require('path');
const { isBotBusy, getBusyTask } = require('../utils/lock');
const { isMaintenance } = require('../maintenance');
const { pool } = require('../utils/db');
const { isSlowError, isDiscordApiError, redactApiError, describeInteraction } = require('../utils/discordErrors');
const { t } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// "I'm busy" reply: the running task's name in the reader's language when it is a known one
const BUSY_TASKS = { 'Clearing Bot DM Messages': 'clearDms', 'Cleaning channel messages': 'cleanChannel' };
async function busyText(langOf) {
    const lang = await langOf();
    const task = getBusyTask();
    return t(lang, 'core.busy', { task: BUSY_TASKS[task] ? t(lang, 'core.tasks.' + BUSY_TASKS[task]) : task });
}

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction, client) {
        // Remember the user's Discord app language (for DMs and background messages) - never blocks
        if (interaction.user) userLanguage.noteLocale(interaction.user.id, interaction.locale).catch(() => {});
        const langOf = () => userLanguage.forInteraction(interaction); // cached 60s
        try {
            // Global Maintenance Check
            if (isMaintenance(interaction.guildId)) {
                if (!interaction.isRepliable()) return; // e.g. autocomplete cannot be replied to
                return await interaction.reply({
                    content: t(await langOf(), 'core.maintenance'),
                    flags: [MessageFlags.Ephemeral]
                });
            }

            // Autocomplete (e.g. /pf mount): the command's autocomplete() answers; never throws back to Discord
            if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) {
                const acCommand = client.commands.get(interaction.commandName);
                if (acCommand && typeof acCommand.autocomplete === 'function') return await acCommand.autocomplete(interaction);
                return await interaction.respond([]).catch(() => { });
            }

            // 1. Handle Slash Commands
            if (interaction.isChatInputCommand()) {
                const commandName = interaction.commandName;
                const userTag = interaction.user.tag;
                const userId = interaction.user.id;
                const location = interaction.guild 
                    ? `Guild: ${interaction.guild.name} (${interaction.guild.id})` 
                    : 'Direct Message (DM)';

                // Log slash command usage to console
                console.log(`💻 [SLASH COMMAND] /${commandName} | User: ${userTag} (${userId}) | Location: ${location}`);

                const isDM = !interaction.guildId;
                if (isDM && commandName !== 'clearbotdms' && commandName !== 'pingway') {
                    return await interaction.reply({
                        content: t(await langOf(), 'core.noDms'),
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                if (isBotBusy() && commandName !== 'clean' && commandName !== 'clearbotdms') {
                    return await interaction.reply({
                        content: await busyText(langOf),
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                // --- SCIONDEX GUILD CHANNEL SETUP GUARD ---
                if (commandName === 'sciondex') {
                    const guildId = interaction.guildId;
                    const channelId = interaction.channelId;

                    const [rows] = await pool.execute(
                        'SELECT sciondex_channel_id FROM server_settings WHERE guild_id = ?',
                        [guildId]
                    );

                    const configuredChannelId = rows.length > 0 ? rows[0].sciondex_channel_id : null;
                    const isAdmin = interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator);

                    if (!configuredChannelId || configuredChannelId !== channelId) {
                        if (isAdmin) {
                            const channelSelect = new ChannelSelectMenuBuilder()
                                .setCustomId('select_sciondex_channel')
                                .setPlaceholder(t(await langOf(), 'core.sciondexSelect'))
                                .setChannelTypes(ChannelType.GuildText);

                            const row = new ActionRowBuilder().addComponents(channelSelect);

                            const adminNotice = !configuredChannelId
                                ? t(await langOf(), 'core.sciondexAdminNotSetUp')
                                : t(await langOf(), 'core.sciondexAdminRestricted', { channelId: configuredChannelId });

                            return await interaction.reply({
                                content: adminNotice,
                                components: [row],
                                flags: [MessageFlags.Ephemeral]
                            });
                        } else {
                            const userNotice = !configuredChannelId
                                ? t(await langOf(), 'core.sciondexNotSetUp')
                                : t(await langOf(), 'core.sciondexOnlyIn', { channelId: configuredChannelId });

                            return await interaction.reply({
                                content: userNotice,
                                flags: [MessageFlags.Ephemeral]
                            });
                        }
                    }
                }

                const command = client.commands.get(commandName);
                if (!command) {
                    return await interaction.reply({
                        content: t(await langOf(), 'core.commandNotFound', { commandName }),
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                try {
                    const loggerHandler = require('./interactions/logger.js');
                    if (loggerHandler && typeof loggerHandler.handleInteraction === 'function') {
                        loggerHandler.handleInteraction(interaction).catch(err => console.error('Logging error:', err));
                    }
                } catch (logErr) {
                    console.error('⚠️ Could not load logger handler:', logErr.message);
                }

                return await command.execute(interaction);
            }

            // 2. Handle Components & Modals
            if (
                interaction.isButton() ||
                interaction.isStringSelectMenu() ||
                interaction.isChannelSelectMenu() ||
                interaction.isModalSubmit()
            ) {
                const cid = interaction.customId;
                if (!cid) return;

                const interactionType = interaction.isButton() 
                    ? 'BUTTON' 
                    : interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()
                    ? 'SELECT MENU' 
                    : 'MODAL SUBMIT';

                // Log component/modal interaction to console
                console.log(`🔘 [${interactionType}] ID: "${cid}" | User: ${interaction.user.tag} (${interaction.user.id})`);

                // --- SCIONDEX ADMIN CHANNEL SELECTION HANDLER ---
                if (cid === 'select_sciondex_channel' && interaction.isChannelSelectMenu()) {
                    const selectedChannelId = interaction.values[0];
                    const guildId = interaction.guildId;

                    await pool.execute(
                        `INSERT INTO server_settings (guild_id, sciondex_channel_id) 
                         VALUES (?, ?) 
                         ON DUPLICATE KEY UPDATE sciondex_channel_id = VALUES(sciondex_channel_id)`,
                        [guildId, selectedChannelId]
                    );

                    return await interaction.reply({
                        content: t(await langOf(), 'core.sciondexChannelSet', { channelId: selectedChannelId }),
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                // --- DIRECT SCIONDEX ROUTING FIX ---
                if (cid.startsWith('btn_') || cid.startsWith('select_')) {
                    const sciondex = require(path.join(__dirname, '..', 'commands', 'sciondex.js'));
                    if (sciondex && typeof sciondex.handleButtonInteraction === 'function') {
                        return await sciondex.handleButtonInteraction(interaction);
                    }
                }

                // Dev page Giveaway: the winner's Claim button (in their DM)
                if (cid.startsWith('giveaway_claim_')) {
                    return await require('../utils/giveaway').handleClaim(interaction, { pool, langOf: () => langOf() });
                }

                // Market Alert
                if (cid.startsWith('marketalert_') || cid.startsWith('market_')) {
                    const marketCommand = client.commands.get('marketalert');
                    if (marketCommand && typeof marketCommand.handleInteraction === 'function') {
                        return await marketCommand.handleInteraction(interaction);
                    } else if (marketCommand && typeof marketCommand.execute === 'function') {
                        return await marketCommand.execute(interaction);
                    }
                }

                // Poll
                if (cid.startsWith('poll_')) {
                    const pollCommand = client.commands.get('poll');
                    if (pollCommand && typeof pollCommand.execute === 'function') {
                        return await pollCommand.execute(interaction);
                    }
                }

                // Voice (/vc panel)
                if (cid.startsWith('vc_')) {
                    const vcCommand = client.commands.get('vc');
                    if (vcCommand && typeof vcCommand.handleInteraction === 'function') {
                        return await vcCommand.handleInteraction(interaction);
                    }
                }

                // /collect panel (FFXIV Collect)
                if (cid.startsWith('collect_')) {
                    const collectCommand = client.commands.get('collect');
                    if (collectCommand && typeof collectCommand.handleInteraction === 'function') {
                        return await collectCommand.handleInteraction(interaction);
                    }
                }

                // Price
                if (cid.startsWith('price_')) {
                    const priceCommand = client.commands.get('price');
                    if (priceCommand && typeof priceCommand.execute === 'function') {
                        return await priceCommand.execute(interaction);
                    }
                }

                // Firmament
                if (
                    cid === 'toggle_firmament_dm' ||
                    cid === 'sync_firmament_timer' ||
                    cid === 'firmament_sync_modal' ||
                    cid === 'remove_firmament_counter'
                ) {
                    const firmamentHandler = require('./interactions/firmament.js');
                    if (firmamentHandler && typeof firmamentHandler.handleInteraction === 'function') {
                        return await firmamentHandler.handleInteraction(interaction);
                    }
                }

                // Setup Modals
                if (cid === 'raid_setup_modal' || cid === 'logger_setup_modal') {
                    const setupHandler = require('./interactions/setupHandler.js');
                    if (setupHandler && typeof setupHandler.handleModal === 'function') {
                        return await setupHandler.handleModal(interaction);
                    }
                }

                // Data Center Setup
                if (cid.startsWith('dc_')) {
                    const dcCommandPath = path.join(__dirname, '..', 'commands', 'datacenter.js');
                    const dcCommand = require(dcCommandPath);
                    if (dcCommand && typeof dcCommand.handleInteraction === 'function') {
                        return await dcCommand.handleInteraction(interaction);
                    }
                }

                // Party Finder Wizard
                if (cid.startsWith('pf_')) {
                    const pfCommandPath = path.join(__dirname, '..', 'commands', 'pf.js');
                    const pfCommand = require(pfCommandPath);
                    if (pfCommand && typeof pfCommand.handleInteraction === 'function') {
                        return await pfCommand.handleInteraction(interaction);
                    }
                }

                // Todo
                if (
                    cid.startsWith('done_') ||
                    cid.startsWith('undone_') ||
                    cid.includes('warp') ||
                    cid.startsWith('todo_') ||
                    cid.startsWith('rem_')
                ) {
                    const todoCommand = client.commands.get('todo');
                    if (todoCommand && typeof todoCommand.execute === 'function') {
                        return await todoCommand.execute(interaction);
                    }
                }

                // Status
                if (cid.startsWith('status_')) {
                    const statusHandler = require('./interactions/status.js');
                    if (statusHandler && typeof statusHandler.handleInteraction === 'function') {
                        return await statusHandler.handleInteraction(interaction);
                    }
                }

                // IGN Config
                if (cid.startsWith('ign_') || cid.startsWith('ign_select_')) {
                    const ignConfigCommand = client.commands.get('ignconfig');
                    if (ignConfigCommand) {
                        if (interaction.isModalSubmit() && typeof ignConfigCommand.handleModal === 'function') {
                            return await ignConfigCommand.handleModal(interaction);
                        } else if (interaction.isStringSelectMenu() && typeof ignConfigCommand.handleSelectMenu === 'function') {
                            return await ignConfigCommand.handleSelectMenu(interaction);
                        } else if (typeof ignConfigCommand.handleButton === 'function') {
                            return await ignConfigCommand.handleButton(interaction);
                        }
                    }
                }

                // Release Events
                if (
                    cid.includes('release') ||
                    cid.includes('evercold') ||
                    cid === 'set_date' ||
                    cid === 'get_notif' ||
                    cid === 'test_notif' ||
                    cid === 'release_name_modal' ||
                    cid === 'release_role_setup'
                ) {
                    const releaseHandler = require('./interactions/release.js');
                    if (releaseHandler && typeof releaseHandler.handleInteraction === 'function') {
                        return await releaseHandler.handleInteraction(interaction);
                    }
                }
            }

        } catch (error) {
            const ctx = describeInteraction(interaction);
            if (isSlowError(error)) {
                // Discord gave up on the interaction (slow host) - one short line, no dump
                console.error(`⏱️ [SLOW] ${error.message} (${error.code}) | ${ctx}`);
            } else {
                console.error(`❌ Error handling interaction | ${ctx}:`, isDiscordApiError(error) ? redactApiError(error) : error);
            }
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: t(await langOf(), 'core.interactionError'),
                    flags: [MessageFlags.Ephemeral]
                }).catch(() => { });
            }
        }
    }
};