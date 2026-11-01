const {
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');
const { pool } = require('../utils/db');

// In-memory storage for active poll creation wizards
const wizardSessions = new Map();

// Helper to safely parse JSON from DB columns
function safeJsonParse(val, fallback = []) {
    if (!val) return fallback;
    if (typeof val === 'object') return val;
    try {
        return JSON.parse(val);
    } catch {
        return fallback;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create and manage interactive custom polls.'),

    async execute(interaction) {
        try {
            // ---------------------------------------------------------
            // 1. Handle Slash Command Initiation
            // ---------------------------------------------------------
            if (interaction.isChatInputCommand() && interaction.commandName === 'poll') {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('poll_main_create').setLabel('Create Poll').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('poll_main_list').setLabel('Show List').setStyle(ButtonStyle.Secondary)
                );

                return await interaction.reply({
                    content: '📊 **What would you like to do?**',
                    components: [row],
                    flags: [MessageFlags.Ephemeral]
                });
            }

            // ---------------------------------------------------------
            // 2. Handle Modal Submissions
            // ---------------------------------------------------------
            if (interaction.isModalSubmit()) {
                if (interaction.customId === 'poll_modal_question') {
                    const question = interaction.fields.getTextInputValue('poll_question_input');

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('poll_multi_true').setLabel('Yes').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId('poll_multi_false').setLabel('No').setStyle(ButtonStyle.Danger)
                    );

                    const reply = await interaction.update({
                        content: `**Question:** ${question}\n\nDo you want to **allow multiple answers**?`,
                        components: [row],
                        withResponse: true
                    });

                    wizardSessions.set(interaction.user.id, {
                        question,
                        allowMultiple: false,
                        answers: [],
                        roles: [],
                        configMessageId: reply.resource?.message?.id || reply.id
                    });
                }
                else if (interaction.customId.startsWith('poll_modal_answer_')) {
                    const session = wizardSessions.get(interaction.user.id);
                    if (!session) {
                        return interaction.update({ content: 'Session expired.', components: [] });
                    }

                    const answerText = interaction.fields.getTextInputValue('poll_answer_input');
                    session.answers.push(answerText);

                    await updateConfigWindow(interaction, session);
                }
            }

            // ---------------------------------------------------------
            // 3. Handle Button Interactions
            // ---------------------------------------------------------
            else if (interaction.isButton()) {
                const userId = interaction.user.id;
                const session = wizardSessions.get(userId);

                // -- Main Menu --
                if (interaction.customId === 'poll_main_create') {
                    const modal = new ModalBuilder()
                        .setCustomId('poll_modal_question')
                        .setTitle('Create Poll - Question');

                    const questionInput = new TextInputBuilder()
                        .setCustomId('poll_question_input')
                        .setLabel('Poll Name / Question')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setMaxLength(256);

                    modal.addComponents(new ActionRowBuilder().addComponents(questionInput));
                    return await interaction.showModal(modal);
                }
                else if (interaction.customId === 'poll_main_list') {
                    const [rows] = await pool.execute(
                        `SELECT * FROM guild_polls WHERE guild_id = ? AND creator_id = ?`,
                        [interaction.guildId, userId]
                    );

                    if (rows.length === 0) {
                        return interaction.update({ content: '❌ No poll had been created by you in this server.', components: [] });
                    }

                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('poll_list_manage_select')
                        .setPlaceholder('Select a poll to manage')
                        .addOptions(rows.map(poll => ({
                            label: poll.question.substring(0, 90),
                            description: `ID: ${poll.poll_id}`,
                            value: poll.poll_id
                        })));

                    return interaction.update({
                        content: '📋 **Your Created Polls:** Select a poll below to manage:',
                        components: [new ActionRowBuilder().addComponents(selectMenu)]
                    });
                }

                // -- Poll Management via List --
                else if (interaction.customId.startsWith('poll_manage_repost_')) {
                    const pollId = interaction.customId.split('_')[3];
                    const [rows] = await pool.execute(`SELECT * FROM guild_polls WHERE poll_id = ?`, [pollId]);
                    if (rows.length === 0) return interaction.update({ content: 'Poll no longer exists in database.', components: [] });

                    const pollData = rows[0];
                    const answers = safeJsonParse(pollData.answers);
                    const roles = safeJsonParse(pollData.roles);

                    try {
                        const oldChannel = await interaction.guild.channels.fetch(pollData.channel_id).catch(() => null);
                        if (oldChannel) {
                            const oldMessage = await oldChannel.messages.fetch(pollData.poll_id).catch(() => null);
                            if (oldMessage) await oldMessage.delete().catch(() => { });
                        }
                    } catch { }

                    const roleTags = roles.length > 0 ? roles.map(r => `<@&${r}>`).join(' ') : '';
                    let contentStr = `${roleTags}\n## ${pollData.question}\nby: <@${pollData.creator_id}>\n\n`;
                    answers.forEach((ans, idx) => {
                        contentStr += `${idx + 1}. ${ans}\n`;
                    });

                    const newMsg = await interaction.channel.send({ content: contentStr });
                    const newPollId = newMsg.id;

                    const components = [];
                    let currentRow = new ActionRowBuilder();
                    answers.forEach((_, idx) => {
                        if (currentRow.components.length >= 5) {
                            components.push(currentRow);
                            currentRow = new ActionRowBuilder();
                        }
                        currentRow.addComponents(
                            new ButtonBuilder().setCustomId(`poll_vote_${newPollId}_${idx}`).setLabel(`${idx + 1}`).setStyle(ButtonStyle.Secondary)
                        );
                    });
                    if (currentRow.components.length > 0) components.push(currentRow);

                    components.push(new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`poll_action_change_vote_${newPollId}`).setLabel('Change Vote').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`poll_action_results_${newPollId}`).setLabel('Show Result').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`poll_action_delete_${newPollId}`).setLabel('Remove Poll').setStyle(ButtonStyle.Danger)
                    ));

                    await newMsg.edit({ components });

                    await pool.execute(`DELETE FROM guild_polls WHERE poll_id = ?`, [pollId]);
                    await pool.execute(
                        `INSERT INTO guild_polls (poll_id, guild_id, channel_id, creator_id, question, allow_multiple, answers, roles) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [newPollId, interaction.guildId, interaction.channelId, pollData.creator_id, pollData.question, pollData.allow_multiple, typeof pollData.answers === 'string' ? pollData.answers : JSON.stringify(pollData.answers), typeof pollData.roles === 'string' ? pollData.roles : JSON.stringify(pollData.roles)]
                    );

                    return interaction.update({ content: '✅ Poll successfully reposted to this channel!', components: [] });
                }
                else if (interaction.customId.startsWith('poll_manage_delete_prompt_')) {
                    const pollId = interaction.customId.split('_')[4];
                    const confirmRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`poll_manage_delete_yes_${pollId}`).setLabel('Yes, Delete').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`poll_manage_delete_no_${pollId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
                    );
                    return interaction.update({ content: '⚠️ Are you sure you want to delete this poll permanently from database and Discord?', components: [confirmRow] });
                }
                else if (interaction.customId.startsWith('poll_manage_delete_yes_')) {
                    const pollId = interaction.customId.split('_')[4];
                    const [rows] = await pool.execute(`SELECT * FROM guild_polls WHERE poll_id = ?`, [pollId]);

                    if (rows.length > 0) {
                        const pollData = rows[0];
                        try {
                            const channel = await interaction.guild.channels.fetch(pollData.channel_id).catch(() => null);
                            if (channel) {
                                const msg = await channel.messages.fetch(pollId).catch(() => null);
                                if (msg) await msg.delete().catch(() => { });
                            }
                        } catch { }

                        await pool.execute(`DELETE FROM poll_votes WHERE poll_id = ?`, [pollId]);
                        await pool.execute(`DELETE FROM guild_polls WHERE poll_id = ?`, [pollId]);
                    }

                    return interaction.update({ content: '🗑️ Poll successfully deleted.', components: [] });
                }
                else if (interaction.customId.startsWith('poll_manage_delete_no_')) {
                    return interaction.update({ content: 'Action cancelled.', components: [] });
                }

                // -- Wizard Config Options --
                else if (interaction.customId === 'poll_multi_true' || interaction.customId === 'poll_multi_false') {
                    if (!session) return interaction.update({ content: 'Session expired.', components: [] });
                    session.allowMultiple = (interaction.customId === 'poll_multi_true');
                    await updateConfigWindow(interaction, session);
                }
                else if (interaction.customId === 'poll_config_toggle_multi') {
                    if (!session) return interaction.update({ content: 'Session expired.', components: [] });
                    session.allowMultiple = !session.allowMultiple;
                    await updateConfigWindow(interaction, session);
                }
                else if (interaction.customId === 'poll_config_add_answer') {
                    if (!session) return interaction.update({ content: 'Session expired.', components: [] });
                    if (session.answers.length >= 20) {
                        return interaction.reply({ content: 'Maximum limit of 20 answers reached.', flags: [MessageFlags.Ephemeral] });
                    }
                    return await showAnswerModal(interaction, session.answers.length + 1);
                }
                else if (interaction.customId === 'poll_config_remove_answer') {
                    if (!session || session.answers.length === 0) {
                        return interaction.reply({ content: 'No answers to remove.', flags: [MessageFlags.Ephemeral] });
                    }
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('poll_select_remove_answer')
                        .setPlaceholder('Select answer to remove')
                        .addOptions(session.answers.map((ans, idx) => ({
                            label: `${idx + 1}. ${ans.substring(0, 90)}`,
                            value: idx.toString()
                        })));

                    await interaction.update({
                        content: 'Select the answer number you wish to remove:',
                        components: [new ActionRowBuilder().addComponents(selectMenu)]
                    });
                }
                else if (interaction.customId === 'poll_config_add_role') {
                    if (!session) return interaction.update({ content: 'Session expired.', components: [] });
                    const roles = interaction.guild.roles.cache.filter(r => r.id !== interaction.guild.id);
                    if (roles.size === 0) {
                        return interaction.reply({ content: 'No assignable roles found in this server.', flags: [MessageFlags.Ephemeral] });
                    }

                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('poll_select_add_role')
                        .setPlaceholder('Select a role to tag')
                        .addOptions(roles.first(25).map(r => ({
                            label: r.name,
                            value: r.id
                        })));

                    await interaction.update({
                        content: 'Select a role to add:',
                        components: [new ActionRowBuilder().addComponents(selectMenu)]
                    });
                }
                else if (interaction.customId === 'poll_config_remove_role') {
                    if (!session || session.roles.length === 0) {
                        return interaction.reply({ content: 'No roles currently added.', flags: [MessageFlags.Ephemeral] });
                    }

                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('poll_select_remove_role')
                        .setPlaceholder('Select a role to remove')
                        .addOptions(session.roles.map(roleId => {
                            const role = interaction.guild.roles.cache.get(roleId);
                            return {
                                label: role ? role.name : 'Unknown Role',
                                value: roleId
                            };
                        }));

                    await interaction.update({
                        content: 'Select the role you wish to remove:',
                        components: [new ActionRowBuilder().addComponents(selectMenu)]
                    });
                }
                else if (interaction.customId === 'poll_config_cancel') {
                    const confirmRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('poll_cancel_yes').setLabel('Yes, Exit').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId('poll_cancel_no').setLabel('No, Continue').setStyle(ButtonStyle.Secondary)
                    );
                    await interaction.update({ content: 'Are you sure you want to exit the poll creation wizard? All progress will be lost.', components: [confirmRow] });
                }
                else if (interaction.customId === 'poll_cancel_yes') {
                    wizardSessions.delete(userId);
                    await interaction.update({ content: 'Poll creation wizard cancelled.', components: [] });
                }
                else if (interaction.customId === 'poll_cancel_no') {
                    await updateConfigWindow(interaction, session);
                }
                else if (interaction.customId === 'poll_config_finish') {
                    if (!session || session.answers.length < 2) {
                        return interaction.reply({ content: 'You must have at least 2 answers minimum to finish the poll.', flags: [MessageFlags.Ephemeral] });
                    }

                    const roleTags = session.roles.length > 0 ? session.roles.map(r => `<@&${r}>`).join(' ') : '';
                    let contentStr = `${roleTags}\n## ${session.question}\nby: <@${interaction.user.id}>\n\n`;
                    session.answers.forEach((ans, idx) => {
                        contentStr += `${idx + 1}. ${ans}\n`;
                    });

                    const pollMessage = await interaction.channel.send({ content: contentStr });
                    const pollId = pollMessage.id;

                    const components = [];
                    let currentRow = new ActionRowBuilder();
                    session.answers.forEach((_, idx) => {
                        if (currentRow.components.length >= 5) {
                            components.push(currentRow);
                            currentRow = new ActionRowBuilder();
                        }
                        currentRow.addComponents(
                            new ButtonBuilder().setCustomId(`poll_vote_${pollId}_${idx}`).setLabel(`${idx + 1}`).setStyle(ButtonStyle.Secondary)
                        );
                    });
                    if (currentRow.components.length > 0) components.push(currentRow);

                    components.push(new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`poll_action_change_vote_${pollId}`).setLabel('Change Vote').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`poll_action_results_${pollId}`).setLabel('Show Result').setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`poll_action_delete_${pollId}`).setLabel('Remove Poll').setStyle(ButtonStyle.Danger)
                    ));

                    await pollMessage.edit({ components });

                    await pool.execute(
                        `INSERT INTO guild_polls (poll_id, guild_id, channel_id, creator_id, question, allow_multiple, answers, roles) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [pollId, interaction.guildId, interaction.channelId, interaction.user.id, session.question, session.allowMultiple, JSON.stringify(session.answers), JSON.stringify(session.roles)]
                    );

                    wizardSessions.delete(userId);
                    await interaction.update({ content: 'Poll successfully created and posted!', components: [] });
                }

                // -- Voting and Active Poll Actions --
                else if (interaction.customId.startsWith('poll_vote_')) {
                    const parts = interaction.customId.split('_');
                    const pollId = parts[2];
                    const answerIndex = parseInt(parts[3], 10);

                    const [rows] = await pool.execute(`SELECT * FROM guild_polls WHERE poll_id = ?`, [pollId]);
                    if (rows.length === 0) return interaction.reply({ content: 'This poll is no longer active.', flags: [MessageFlags.Ephemeral] });
                    const pollData = rows[0];
                    const roles = safeJsonParse(pollData.roles);

                    if (roles.length > 0) {
                        const member = await interaction.guild.members.fetch(interaction.user.id);
                        const hasRole = roles.some(roleId => member.roles.cache.has(roleId));
                        if (!hasRole) {
                            return interaction.reply({ content: 'You do not have the required role(s) to vote on this poll.', flags: [MessageFlags.Ephemeral] });
                        }
                    }

                    const [voteRows] = await pool.execute(`SELECT answer_index FROM poll_votes WHERE poll_id = ? AND user_id = ?`, [pollId, interaction.user.id]);
                    const userVotes = voteRows.map(r => parseInt(r.answer_index, 10));
                    const hasVotedThisOption = userVotes.includes(answerIndex);

                    if (!pollData.allow_multiple) {
                        if (userVotes.length > 0 && !hasVotedThisOption) {
                            return interaction.reply({
                                content: 'Only one answer is allowed for this poll. Please use **Change Vote** to reset your votes first.',
                                flags: [MessageFlags.Ephemeral]
                            });
                        }
                    }

                    if (hasVotedThisOption) {
                        await pool.execute(`DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ? AND answer_index = ?`, [pollId, interaction.user.id, answerIndex]);
                        await interaction.reply({ content: `Removed your vote for option ${answerIndex + 1}.`, flags: [MessageFlags.Ephemeral] });
                    } else {
                        if (!pollData.allow_multiple) {
                            await pool.execute(`DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?`, [pollId, interaction.user.id]);
                        }
                        await pool.execute(`INSERT INTO poll_votes (poll_id, user_id, answer_index) VALUES (?, ?, ?)`, [pollId, interaction.user.id, answerIndex]);
                        await interaction.reply({ content: `Successfully voted for option ${answerIndex + 1}!`, flags: [MessageFlags.Ephemeral] });
                    }
                }
                else if (interaction.customId.startsWith('poll_action_change_vote_')) {
                    const pollId = interaction.customId.split('_')[4];
                    const confirmRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`poll_confirm_remove_vote_${pollId}`).setLabel('Confirm Vote Removal').setStyle(ButtonStyle.Danger)
                    );
                    await interaction.reply({ content: 'Are you sure you want to remove all your current votes on this poll?', components: [confirmRow], flags: [MessageFlags.Ephemeral] });
                }
                else if (interaction.customId.startsWith('poll_confirm_remove_vote_')) {
                    const pollId = interaction.customId.split('_')[4];
                    await pool.execute(`DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?`, [pollId, interaction.user.id]);
                    await interaction.update({ content: 'Your votes have been completely removed from the database.', components: [] });
                }
                else if (interaction.customId.startsWith('poll_action_results_')) {
                    const pollId = interaction.customId.split('_')[3];
                    const [rows] = await pool.execute(`SELECT * FROM guild_polls WHERE poll_id = ?`, [pollId]);
                    if (rows.length === 0) return interaction.reply({ content: 'This poll is no longer active.', flags: [MessageFlags.Ephemeral] });
                    const pollData = rows[0];

                    // Check privileges
                    const member = await interaction.guild.members.fetch(interaction.user.id);
                    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
                    const isCreator = interaction.user.id === pollData.creator_id;
                    const canSeeVoters = isAdmin || isCreator;

                    const answers = safeJsonParse(pollData.answers);
                    const [voteRows] = await pool.execute(`SELECT user_id, answer_index FROM poll_votes WHERE poll_id = ?`, [pollId]);
                    const uniqueVoters = new Set(voteRows.map(r => r.user_id));
                    const totalVoters = uniqueVoters.size;

                    // Group user IDs by option index
                    const votesByOption = Array.from({ length: answers.length }, () => []);
                    voteRows.forEach(r => {
                        const idx = parseInt(r.answer_index, 10);
                        if (!isNaN(idx) && votesByOption[idx]) {
                            votesByOption[idx].push(`<@${r.user_id}>`);
                        }
                    });

                    let resultText = `📊 **Poll Results: ${pollData.question}**\n\n`;
                    answers.forEach((ans, idx) => {
                        const voters = votesByOption[idx];
                        const count = voters.length;
                        const percentage = totalVoters > 0 ? ((count / totalVoters) * 100).toFixed(1) : '0.0';

                        if (canSeeVoters) {
                            const userListStr = voters.length > 0 ? voters.join(', ') : '_No votes_';
                            resultText += `**${idx + 1}. ${ans}** — ${count} votes (${percentage}%)\n`;
                            resultText += `> **Voters:** ${userListStr}\n\n`;
                        } else {
                            resultText += `**${idx + 1}. ${ans}**\n- Votes: ${count} (${percentage}%)\n\n`;
                        }
                    });
                    resultText += `**Total Unique Voters:** ${totalVoters}`;

                    await interaction.reply({ content: resultText, flags: [MessageFlags.Ephemeral] });
                }
                else if (interaction.customId.startsWith('poll_action_delete_')) {
                    const pollId = interaction.customId.split('_')[3];
                    const [rows] = await pool.execute(`SELECT * FROM guild_polls WHERE poll_id = ?`, [pollId]);
                    if (rows.length === 0) return interaction.reply({ content: 'This poll is no longer active.', flags: [MessageFlags.Ephemeral] });
                    const pollData = rows[0];

                    const member = await interaction.guild.members.fetch(interaction.user.id);
                    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
                    const isCreator = interaction.user.id === pollData.creator_id;

                    if (!isAdmin && !isCreator) {
                        return interaction.reply({ content: 'Only administrators and the poll creator can delete this poll.', flags: [MessageFlags.Ephemeral] });
                    }

                    const confirmRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`poll_confirm_delete_${pollId}`).setLabel('Confirm Deletion').setStyle(ButtonStyle.Danger)
                    );
                    await interaction.reply({ content: 'Are you sure you want to delete this poll permanently?', components: [confirmRow], flags: [MessageFlags.Ephemeral] });
                }
                else if (interaction.customId.startsWith('poll_confirm_delete_')) {
                    const pollId = interaction.customId.split('_')[3];
                    const [rows] = await pool.execute(`SELECT * FROM guild_polls WHERE poll_id = ?`, [pollId]);
                    if (rows.length === 0) return interaction.update({ content: 'Poll already removed.', components: [] });

                    const pollData = rows[0];
                    const member = await interaction.guild.members.fetch(interaction.user.id);
                    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
                    const isCreator = interaction.user.id === pollData.creator_id;

                    if (!isAdmin && !isCreator) {
                        return interaction.update({ content: 'Permission denied.', components: [] });
                    }

                    try {
                        const message = await interaction.channel.messages.fetch(pollId).catch(() => null);
                        if (message) {
                            await message.delete().catch(() => { });
                        }
                    } catch { }

                    await pool.execute(`DELETE FROM poll_votes WHERE poll_id = ?`, [pollId]);
                    await pool.execute(`DELETE FROM guild_polls WHERE poll_id = ?`, [pollId]);

                    await interaction.update({ content: 'Poll deleted successfully from database and channel.', components: [] });
                }
            }

            // ---------------------------------------------------------
            // 4. Handle String Select Menus
            // ---------------------------------------------------------
            else if (interaction.isStringSelectMenu()) {
                const userId = interaction.user.id;

                if (interaction.customId === 'poll_list_manage_select') {
                    const pollId = interaction.values[0];
                    const [rows] = await pool.execute(`SELECT * FROM guild_polls WHERE poll_id = ?`, [pollId]);
                    if (rows.length === 0) return interaction.update({ content: 'Poll no longer found.', components: [] });

                    const poll = rows[0];
                    const manageRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`poll_manage_repost_${poll.poll_id}`).setLabel('Repost').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`poll_manage_delete_prompt_${poll.poll_id}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
                    );

                    return interaction.update({
                        content: `Managing poll: **${poll.question}**\nChoose an action below:`,
                        components: [manageRow]
                    });
                }

                const session = wizardSessions.get(userId);
                if (!session) return interaction.update({ content: 'Session expired.', components: [] });

                if (interaction.customId === 'poll_select_remove_answer') {
                    const removeIdx = parseInt(interaction.values[0]);
                    session.answers.splice(removeIdx, 1);
                    await updateConfigWindow(interaction, session);
                }
                else if (interaction.customId === 'poll_select_add_role') {
                    const roleId = interaction.values[0];
                    if (!session.roles.includes(roleId)) {
                        session.roles.push(roleId);
                    }
                    await updateConfigWindow(interaction, session);
                }
                else if (interaction.customId === 'poll_select_remove_role') {
                    const roleId = interaction.values[0];
                    session.roles = session.roles.filter(r => r !== roleId);
                    await updateConfigWindow(interaction, session);
                }
            }
        } catch (err) {
            console.error(err);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'An error occurred while executing this action.', flags: [MessageFlags.Ephemeral] }).catch(() => { });
            }
        }
    }
};

// ---------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------
async function showAnswerModal(interaction, answerNum) {
    const is20th = answerNum === 20;
    const modal = new ModalBuilder()
        .setCustomId(`poll_modal_answer_${is20th ? 'done' : 'next'}`)
        .setTitle(`Answer #${answerNum} ${is20th ? '(20th - Max Limit)' : ''}`);

    const answerInput = new TextInputBuilder()
        .setCustomId('poll_answer_input')
        .setLabel(`Enter text for answer ${answerNum}`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

    modal.addComponents(new ActionRowBuilder().addComponents(answerInput));
    await interaction.showModal(modal);
}

async function updateConfigWindow(interaction, session) {
    let roleListStr = session.roles.length > 0 ? session.roles.map(r => `<@&${r}>`).join(', ') : 'none';

    let configText = `**Poll Config Window**\n` +
        `**Question:** ${session.question}\n` +
        `**Allow Multiple Status:** ${session.allowMultiple}\n` +
        `**Role(s) to Tag:** ${roleListStr}\n\n` +
        `**Answers:**\n`;

    if (session.answers.length === 0) {
        configText += `1. (empty)\n2. (empty)\n`;
    } else {
        session.answers.forEach((ans, idx) => {
            configText += `${idx + 1}. ${ans}\n`;
        });
        if (session.answers.length === 1) {
            configText += `2. (empty)\n`;
        }
    }

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('poll_config_add_answer').setLabel('Add Answer').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('poll_config_remove_answer').setLabel('Remove Answer').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('poll_config_toggle_multi').setLabel('Toggle Allow Multiple').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('poll_config_add_role').setLabel('Add Role').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('poll_config_remove_role').setLabel('Remove Role').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('poll_config_finish').setLabel('Finish').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('poll_config_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
    );

    await interaction.update({
        content: configText,
        components: [row1, row2]
    });
}