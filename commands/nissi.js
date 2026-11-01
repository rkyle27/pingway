const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { pool } = require('../utils/db');

function getWhitelistedGuilds() {
    const filePath = path.join(__dirname, '..', 'data', 'nissi.txt');
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
}

function loadQuestions() {
    const filePath = path.join(__dirname, '..', 'data', 'questions.json');
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
}

function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function buildMainInterface() {
    const embed = new EmbedBuilder()
        .setTitle('Nissi Quiz (Elemental / Tuffless Strat)')
        .setColor('#3498db')
        .setDescription('Test your knowledge for TEA Nissi mechanics!');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nissi_take_quiz').setLabel('Take Quiz').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('nissi_show_results').setLabel('Show Results').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('nissi_exit').setLabel('Exit').setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row] };
}

async function renderResultsView(guildId) {
    const [rows] = await pool.execute(
        'SELECT username, score FROM nissi_quiz_results WHERE server_id = ? ORDER BY score DESC, username ASC',
        [guildId]
    );

    let description = 'Current Scores:\n\n';
    if (rows.length === 0) {
        description += 'No scores recorded yet!';
    } else {
        rows.forEach(row => {
            description += `${row.username} ${row.score}/10\n`;
        });
    }

    const embed = new EmbedBuilder()
        .setTitle('Current Scores:')
        .setColor('#2ecc71')
        .setDescription(description);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nissi_back_main').setLabel('Back').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row] };
}

async function startQuizSession(interaction) {
    const rawQuestions = loadQuestions();
    if (rawQuestions.length < 10) {
        return interaction.editReply({
            content: '❌ Not enough questions available in the question bank.',
            embeds: [],
            components: []
        });
    }

    const selectedQuestions = shuffleArray(rawQuestions).slice(0, 10);
    const preparedQuiz = selectedQuestions.map(q => {
        const choiceObjects = q.choices.map((text, index) => ({
            text,
            isCorrect: index === q.correctIndex
        }));
        const shuffledChoices = shuffleArray(choiceObjects);
        return {
            question: q.question,
            imageUrl: q.imageUrl,
            choices: shuffledChoices
        };
    });

    let currentQuestionIndex = 0;
    let score = 0;

    async function displayQuestion() {
        if (currentQuestionIndex >= 10) {
            const guildId = interaction.guildId;
            const userId = interaction.user.id;
            const username = interaction.user.username;

            await pool.execute(
                `INSERT INTO nissi_quiz_results (server_id, user_id, username, score)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE username = VALUES(username), score = GREATEST(score, VALUES(score))`,
                [guildId, userId, username, score]
            );

            const resultEmbed = new EmbedBuilder()
                .setTitle('Your Score:')
                .setColor('#f1c40f')
                .setDescription(`${score} / 10 !`);

            const resultRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('nissi_back_main').setLabel('back').setStyle(ButtonStyle.Primary)
            );

            const finalMessage = await interaction.editReply({
                embeds: [resultEmbed],
                components: [resultRow]
            });

            const finalCollector = finalMessage.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id,
                time: 60000
            });

            finalCollector.on('collect', async i => {
                await i.deferUpdate().catch(() => {});
                if (i.customId === 'nissi_back_main') {
                    finalCollector.stop();
                    const mainView = buildMainInterface();
                    await interaction.editReply(mainView);
                }
            });

            return;
        }

        const qData = preparedQuiz[currentQuestionIndex];
        let timeLeft = 30;
        let answered = false;

        const generateQuestionPayload = (seconds) => {
            const embed = new EmbedBuilder()
                .setTitle(`Question ${currentQuestionIndex + 1} of 10 (Time Remaining: ${seconds}s)`)
                .setDescription(qData.question)
                .setColor('#e67e22');

            if (qData.imageUrl) {
                embed.setImage(qData.imageUrl);
            }

            const buttons = qData.choices.map((choice, idx) =>
                new ButtonBuilder()
                    .setCustomId(`quiz_ans_${idx}`)
                    .setLabel(`${idx + 1}. ${choice.text}`.substring(0, 80))
                    .setStyle(ButtonStyle.Primary)
            );

            const row = new ActionRowBuilder().addComponents(buttons);
            return { embeds: [embed], components: [row] };
        };

        const questionMessage = await interaction.editReply(generateQuestionPayload(timeLeft));

        const timerInterval = setInterval(async () => {
            if (answered) {
                clearInterval(timerInterval);
                return;
            }

            timeLeft--;

            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                collector.stop('time_out');
            } else {
                await interaction.editReply(generateQuestionPayload(timeLeft)).catch(() => {});
            }
        }, 1000);

        const collector = questionMessage.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId.startsWith('quiz_ans_'),
            time: 30000
        });

        collector.on('collect', async i => {
            answered = true;
            clearInterval(timerInterval);
            await i.deferUpdate().catch(() => {});

            const chosenIdx = parseInt(i.customId.replace('quiz_ans_', ''), 10);
            if (qData.choices[chosenIdx].isCorrect) {
                score++;
            }

            collector.stop('answered');
        });

        collector.on('end', async (collected, reason) => {
            clearInterval(timerInterval);
            currentQuestionIndex++;
            await displayQuestion();
        });
    }

    await displayQuestion();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nissi')
        .setDescription('Practice quiz for TEA Nissi mechanics.'),

    async execute(interaction) {
        const whitelistedGuilds = getWhitelistedGuilds();
        if (!interaction.guildId || !whitelistedGuilds.includes(interaction.guildId)) {
            return interaction.reply({
                content: "Sorry, this command isn't available for you. Please contact the developer if you want access.\nThis is for practicing TEA's Nissi 3rd & 4th pass/take for DPS using Tuufless Strat.",
                flags: [MessageFlags.Ephemeral]
            });
        }

        const mainView = buildMainInterface();
        const mainMessage = await interaction.reply({ ...mainView, flags: [MessageFlags.Ephemeral] });

        const mainCollector = mainMessage.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id
        });

        mainCollector.on('collect', async i => {
            const cid = i.customId;

            if (cid === 'nissi_take_quiz') {
                await i.deferUpdate().catch(() => {});
                await startQuizSession(interaction);
            } else if (cid === 'nissi_show_results') {
                await i.deferUpdate().catch(() => {});
                const resultsView = await renderResultsView(interaction.guildId);
                await interaction.editReply(resultsView);
            } else if (cid === 'nissi_back_main') {
                await i.deferUpdate().catch(() => {});
                await interaction.editReply(buildMainInterface());
            } else if (cid === 'nissi_exit') {
                await i.deferUpdate().catch(() => {});
                await interaction.editReply({
                    content: 'Exiting...',
                    embeds: [],
                    components: []
                });

                setTimeout(async () => {
                    await interaction.deleteReply().catch(() => {});
                }, 3000);
            }
        });
    }
};