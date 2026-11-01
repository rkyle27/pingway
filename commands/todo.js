const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags
} = require('discord.js');
const { isMaintenance } = require('../maintenance');
const { pool } = require('../utils/db');

/**
 * Helper to generate the main todo list embed and component rows.
 */
async function generateTodoView(userId, warpType = null) {
    const [rows] = await pool.execute('SELECT * FROM todos WHERE user_id = ?', [userId]);
    const userTasks = rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        name: row.name,
        type: row.type,
        lastCompletedTimestamp: row.last_completed_timestamp
    }));

    if (userTasks.length === 0) {
        const embed = new EmbedBuilder().setTitle('📋 FFXIV Task List').setColor('#1abc9c').setDescription('📋 Your checklist is empty!');
        const actionRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('todo_add_btn').setLabel('➕ Add Task').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('todo_rem_menu').setLabel('🗑️ Remove Task').setStyle(ButtonStyle.Danger).setDisabled(true)
        );
        return { embeds: [embed], components: [actionRow] };
    }

    const now = new Date();
    /* DISABLED FOR TESTING: Time warp logic
    if (warpType === 'daily') {
        now.setTime(now.getTime() + (24 * 60 * 60 * 1000));
    } else if (warpType === 'weekly') {
        now.setTime(now.getTime() + (7 * 24 * 60 * 60 * 1000));
    }
    */

    const getJSTDate = (date = new Date()) => {
        const options = { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hour12: false };
        const formatter = new Intl.DateTimeFormat('en-US', options);
        const parts = formatter.formatToParts(date);
        const map = {};
        parts.forEach(p => map[p.type] = p.value);
        
        const weekdayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
        
        return {
            year: parseInt(map.year, 10),
            month: parseInt(map.month, 10) - 1,
            day: parseInt(map.day, 10),
            hour: parseInt(map.hour, 10),
            minute: parseInt(map.minute, 10),
            second: parseInt(map.second, 10),
            weekday: weekdayMap[map.weekday]
        };
    };

    const isTaskDone = (task) => {
        if (!task.lastCompletedTimestamp) return false;
        const completedDate = new Date(task.lastCompletedTimestamp);

        const currentJST = getJSTDate(now);
        const completedJST = getJSTDate(completedDate);

        if (task.type === 'daily') {
            const currentBoundaryTime = new Date(Date.UTC(currentJST.year, currentJST.month, currentJST.day, 0, 0, 0) - (9 * 60 * 60 * 1000));
            return completedDate.getTime() >= currentBoundaryTime.getTime();
        } else {
            const currentTokyoMidnightUTC = Date.UTC(currentJST.year, currentJST.month, currentJST.day, 0, 0, 0) - (9 * 60 * 60 * 1000);
            const lastReset = new Date(currentTokyoMidnightUTC);
            lastReset.setUTCHours(lastReset.getUTCHours() + 17);

            let dayDiff = currentJST.weekday - 2;
            if (dayDiff < 0) dayDiff += 7;

            if (dayDiff === 0 && currentJST.hour < 17) {
                dayDiff = 7;
            }

            lastReset.setUTCDate(lastReset.getUTCDate() - dayDiff);
            return completedDate >= lastReset;
        }
    };

    const embed = new EmbedBuilder().setTitle('📋 FFXIV Task List').setColor('#1abc9c');
    const dailies = userTasks.filter(t => t.type === 'daily');
    const weeklies = userTasks.filter(t => t.type === 'weekly');

    let listString = warpType && warpType !== 'reset' ? `⚠️ **Simulated Time:** ${now.toUTCString()}\n\n` : '';
    listString += `**☀️ Dailies**\n`;
    listString += '🔴 *Note: GC reset is 5am JST and should not be on this list.*\n';
    const allButtons = [];

    dailies.forEach((task) => {
        const done = isTaskDone(task);
        listString += `${done ? '✅' : '🟥'} ${task.name}\n`;
        allButtons.push(new ButtonBuilder().setCustomId(`${done ? 'undone' : 'done'}_${task.id}`).setLabel(task.name.substring(0, 20)).setStyle(done ? ButtonStyle.Secondary : ButtonStyle.Primary));
    });

    listString += `\n**📅 Weeklies**\n`;
    weeklies.forEach((task) => {
        const done = isTaskDone(task);
        listString += `${done ? '✅' : '🟥'} ${task.name}\n`;
        allButtons.push(new ButtonBuilder().setCustomId(`${done ? 'undone' : 'done'}_${task.id}`).setLabel(task.name.substring(0, 20)).setStyle(done ? ButtonStyle.Secondary : ButtonStyle.Primary));
    });

    listString += '\n\n💡 *Click the task buttons to check/uncheck items, or use Add/Remove below.*';

    const activeButtons = allButtons.slice(0, 25);
    if (allButtons.length > 25) {
        listString += `\n⚠️ *Showing first 25 of ${allButtons.length} tasks due to Discord component limits.*`;
    }

    const componentRows = [];
    for (let i = 0; i < activeButtons.length; i += 5) {
        componentRows.push(new ActionRowBuilder().addComponents(activeButtons.slice(i, i + 5)));
    }

    if (!warpType || warpType === 'reset') {
        embed.setDescription(listString);
    } else {
        embed.setDescription(`⚠️ **TIME WARP ACTIVE:** Simulating ${warpType === 'daily' ? '+1 Day' : '+1 Week'} into the future!\n\n` + listString);
    }

    // Add/Remove Action Row
    const managementRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('todo_add_btn').setLabel('➕ Add Task').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('todo_rem_menu').setLabel('🗑️ Remove Task').setStyle(ButtonStyle.Danger)
    );
    componentRows.push(managementRow);

    /* DISABLED FOR TESTING: Admin Time Warp button row
    const adminRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('test_daily_warp').setLabel('⏱️ Test Daily (+1 Day)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('test_weekly_warp').setLabel('📅 Test Weekly (+1 Week)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('test_reset_warp').setLabel('🔄 Reset Time').setStyle(ButtonStyle.Secondary)
    );
    componentRows.push(adminRow);
    */

    return { embeds: [embed], components: componentRows };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('todo')
        .setDescription('📋 Manage and view your FFXIV task list.'),

    async execute(interaction) {
        if (isMaintenance(interaction.guildId)) {
            const replyPayload = {
                content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!',
                flags: [MessageFlags.Ephemeral]
            };
            if (interaction.deferred || interaction.replied) {
                return interaction.followUp(replyPayload);
            }
            return interaction.reply(replyPayload);
        }

        // 1. Button Interactions
        if (interaction.isButton()) {
            const cid = interaction.customId;

            /* DISABLED FOR TESTING: Time Warp Button Handlers
            if (cid === 'test_daily_warp' || cid === 'test_weekly_warp' || cid === 'test_reset_warp') {
                if (!interaction.member.permissions.has('ADMINISTRATOR')) {
                    return interaction.reply({ content: "❌ Admins only.", flags: [MessageFlags.Ephemeral] });
                }
                await interaction.deferUpdate().catch(() => {});
                let warpType = cid === 'test_daily_warp' ? 'daily' : (cid === 'test_weekly_warp' ? 'weekly' : 'reset');
                const viewData = await generateTodoView(interaction.user.id, warpType);
                return interaction.editReply(viewData);
            }
            */

            // Handle Task Done / Undone Toggles
            if (cid.startsWith('done_') || cid.startsWith('undone_')) {
                await interaction.deferUpdate().catch(() => {});
                const firstUnderscore = cid.indexOf('_');
                const action = cid.substring(0, firstUnderscore);
                const taskId = cid.substring(firstUnderscore + 1);

                try {
                    const timestamp = (action === 'done') ? Date.now() : null;
                    await pool.execute('UPDATE todos SET last_completed_timestamp = ? WHERE id = ? AND user_id = ?', [timestamp, taskId, interaction.user.id]);
                    const viewData = await generateTodoView(interaction.user.id);
                    return interaction.editReply(viewData);
                } catch (error) {
                    console.error('Error updating task status:', error);
                    return interaction.followUp({ content: '❌ Error updating task status.', flags: [MessageFlags.Ephemeral] });
                }
            }

            // Handle Add Task Button -> Open Modal
            if (cid === 'todo_add_btn') {
                const modal = new ModalBuilder()
                    .setCustomId('todo_add_modal')
                    .setTitle('➕ Add New To-Do Item');

                const nameInput = new TextInputBuilder()
                    .setCustomId('todo_name_input')
                    .setLabel('Task Name')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('e.g., Expert Roulette')
                    .setRequired(true)
                    .setMaxLength(100);

                modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
                return await interaction.showModal(modal);
            }

            // Handle Remove Menu Trigger
            if (cid === 'todo_rem_menu') {
                await interaction.deferUpdate().catch(() => {});
                try {
                    const [rows] = await pool.execute('SELECT * FROM todos WHERE user_id = ?', [interaction.user.id]);
                    if (rows.length === 0) {
                        return interaction.followUp({ content: '❌ You have no tasks to remove.', flags: [MessageFlags.Ephemeral] });
                    }

                    const removeEmbed = new EmbedBuilder()
                        .setTitle('🗑️ Task Management: Removal Interface')
                        .setDescription('Select a task below to remove it, or use the controls underneath.')
                        .setColor('#e74c3c');

                    const buttons = rows.map(task =>
                        new ButtonBuilder()
                            .setCustomId(`rem_select_${task.id}`)
                            .setLabel(task.name.substring(0, 20))
                            .setStyle(ButtonStyle.Secondary)
                    );

                    const componentRows = [];
                    for (let i = 0; i < buttons.length; i += 5) {
                        componentRows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                    }

                    const controlRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('rem_done_btn').setLabel('✅ Done').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId('rem_back_btn').setLabel('⬅️ Back to Todo List').setStyle(ButtonStyle.Primary)
                    );
                    componentRows.push(controlRow);

                    return interaction.editReply({ content: null, embeds: [removeEmbed], components: componentRows });
                } catch (error) {
                    console.error('Error opening remove interface:', error);
                }
            }

            // Return to main list
            if (cid === 'rem_back_btn' || cid === 'rem_done_btn') {
                await interaction.deferUpdate().catch(() => {});
                const viewData = await generateTodoView(interaction.user.id);
                return interaction.editReply({ content: null, ...viewData });
            }

            // Task selected for deletion -> Ask Confirmation in place
            if (cid.startsWith('rem_select_')) {
                await interaction.deferUpdate().catch(() => {});
                const taskId = cid.replace('rem_select_', '');
                const [rows] = await pool.execute('SELECT * FROM todos WHERE id = ? AND user_id = ?', [taskId, interaction.user.id]);
                if (rows.length === 0) {
                    return interaction.followUp({ content: '❌ Task not found.', flags: [MessageFlags.Ephemeral] });
                }
                const task = rows[0];

                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`rem_yes_${task.id}`).setLabel('Yes, Delete').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`rem_cancel_${task.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                );

                return interaction.editReply({
                    content: `⚠️ Are you sure you want to remove the task **"${task.name}"**?`,
                    embeds: [],
                    components: [confirmRow]
                });
            }

            // Cancel deletion -> Return to removal menu
            if (cid.startsWith('rem_cancel_')) {
                await interaction.deferUpdate().catch(() => {});
                const [rows] = await pool.execute('SELECT * FROM todos WHERE user_id = ?', [interaction.user.id]);
                
                const removeEmbed = new EmbedBuilder()
                    .setTitle('🗑️ Task Management: Removal Interface')
                    .setDescription('Select a task below to remove it, or use the controls underneath.')
                    .setColor('#e74c3c');

                const buttons = rows.map(task =>
                    new ButtonBuilder()
                        .setCustomId(`rem_select_${task.id}`)
                        .setLabel(task.name.substring(0, 20))
                        .setStyle(ButtonStyle.Secondary)
                );

                const componentRows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    componentRows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }

                const controlRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('rem_done_btn').setLabel('✅ Done').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('rem_back_btn').setLabel('⬅️ Back to Todo List').setStyle(ButtonStyle.Primary)
                );
                componentRows.push(controlRow);

                return interaction.editReply({ content: null, embeds: [removeEmbed], components: componentRows });
            }

            // Confirm deletion
            if (cid.startsWith('rem_yes_')) {
                await interaction.deferUpdate().catch(() => {});
                const taskId = cid.replace('rem_yes_', '');
                try {
                    const [rows] = await pool.execute('SELECT * FROM todos WHERE id = ? AND user_id = ?', [taskId, interaction.user.id]);
                    if (rows.length === 0) {
                        return interaction.followUp({ content: '❌ Task not found.', flags: [MessageFlags.Ephemeral] });
                    }
                    const task = rows[0];

                    await pool.execute('DELETE FROM todos WHERE id = ? AND user_id = ?', [taskId, interaction.user.id]);

                    const formattedFreq = task.type ? (task.type.charAt(0).toUpperCase() + task.type.slice(1)) : 'Task';

                    // Update interaction message directly to state deletion success
                    await interaction.editReply({
                        content: `"${task.name}" ["${formattedFreq}"] has been successfully removed from task list.`,
                        components: [],
                        embeds: []
                    });

                    // Automatically return to updated main To-Do list after 3 seconds
                    setTimeout(async () => {
                        const viewData = await generateTodoView(interaction.user.id);
                        await interaction.editReply({ content: null, ...viewData }).catch(() => {});
                    }, 3000);

                } catch (error) {
                    console.error('Error deleting task:', error);
                    return interaction.followUp({ content: '❌ An error occurred while deleting the task.', flags: [MessageFlags.Ephemeral] });
                }
            }

            // Confirm Save Task
            if (cid.startsWith('todo_save_confirm_')) {
                await interaction.deferUpdate().catch(() => {});

                const parts = cid.replace('todo_save_confirm_', '').split('_');
                const frequency = parts[0];
                const encodedName = parts.slice(1).join('_');
                const taskName = Buffer.from(encodedName, 'base64').toString('utf8');

                const guildId = interaction.guild ? interaction.guild.id : null;
                const now = Date.now();
                const taskId = `task_${now}_${Math.random().toString(36).substring(2, 7)}`;

                try {
                    await pool.execute(
                        'INSERT INTO todos (id, guild_id, user_id, name, type, last_completed_timestamp) VALUES (?, ?, ?, ?, ?, NULL)',
                        [taskId, guildId, interaction.user.id, taskName, frequency]
                    );

                    // Update menu directly back to the freshly generated To-Do view
                    const viewData = await generateTodoView(interaction.user.id);
                    return interaction.editReply({ content: null, ...viewData });

                } catch (error) {
                    console.error('Error saving confirmed todo task:', error);
                    return interaction.followUp({ content: '❌ Database error occurred while saving task.', flags: [MessageFlags.Ephemeral] });
                }
            }
        }

        // 2. Handle Modal Submissions for Adding Tasks
        if (interaction.isModalSubmit() && interaction.customId === 'todo_add_modal') {
            const taskName = interaction.fields.getTextInputValue('todo_name_input');

            const [existingRows] = await pool.execute('SELECT COUNT(*) as count FROM todos WHERE user_id = ?', [interaction.user.id]);
            if (existingRows[0].count >= 25) {
                return interaction.reply({
                    content: '❌ You have reached the maximum limit of **25 tasks**.',
                    flags: [MessageFlags.Ephemeral]
                });
            }

            const freqSelect = new StringSelectMenuBuilder()
                .setCustomId('todo_freq_select')
                .setPlaceholder('Select task frequency...')
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('Daily').setValue('daily').setDescription('Resets daily'),
                    new StringSelectMenuOptionBuilder().setLabel('Weekly').setValue('weekly').setDescription('Resets weekly')
                );

            const row = new ActionRowBuilder().addComponents(freqSelect);

            // Replaces parent message in-place instead of creating a second message
            return interaction.update({
                content: `📝 Adding task: **"${taskName}"**\nPlease select its frequency using the dropdown menu below:`,
                embeds: [],
                components: [row]
            });
        }

        // 3. Handle String Select Menu for Frequency Selection
        if (interaction.isStringSelectMenu() && interaction.customId === 'todo_freq_select') {
            const frequency = interaction.values[0];

            const contentMatch = interaction.message.content.match(/Adding task: \*\*"(.+?)"\*\*/);
            const taskName = contentMatch ? contentMatch[1] : 'Custom Task';

            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`todo_save_confirm_${frequency}_${Buffer.from(taskName).toString('base64')}`).setLabel('OK ✅').setStyle(ButtonStyle.Success)
            );

            // Replaces parent message in-place
            return interaction.update({
                content: `📋 **Confirm New Task Details:**\n- **Name:** ${taskName}\n- **Frequency:** ${frequency.charAt(0).toUpperCase() + frequency.slice(1)}\n\nClick **OK** to save:`,
                embeds: [],
                components: [confirmRow]
            });
        }

        // 4. Initial slash command execution (/todo)
        if (interaction.isChatInputCommand() && interaction.commandName === 'todo') {
            try {
                const viewData = await generateTodoView(interaction.user.id);
                return interaction.reply({ ...viewData, flags: [MessageFlags.Ephemeral] });
            } catch (error) {
                console.error('Error executing todo command:', error);
                return interaction.reply({ content: '❌ An error occurred while loading your tasks.', flags: [MessageFlags.Ephemeral] });
            }
        }
    }
};