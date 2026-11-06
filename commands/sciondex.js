const { 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder,
    MessageFlags
} = require('discord.js');
const path = require('path');
const { pool } = require('../utils/db');

// Load NPC Dataset
const npcDex = require(path.join(__dirname, '..', 'data', 'npcdex.json'));
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// In-memory game state store per user across ephemeral transitions
const activeSessions = new Map();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('sciondex')
        .setDescription(t('en', 'sciondex.cmd.description')).setDescriptionLocalizations(discordLocalizations('sciondex.cmd.description')),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        try {
            const userId = String(interaction.user.id);

            // Fetch initial state to check if user is a brand new entry
            const [existingRows] = await pool.execute('SELECT user_id FROM sciondex_users WHERE user_id = ?', [userId]);
            const isFirstTimeUser = existingRows.length === 0;

            // Ensure user exists in MySQL DB with stars defaulted to 0
            await pool.execute(
                `INSERT INTO sciondex_users (user_id, shards, phoenix_downs, stars) 
                 VALUES (?, 0, 0, 0) 
                 ON DUPLICATE KEY UPDATE user_id = user_id`,
                [userId]
            );

            // Initialize user session state
            activeSessions.set(userId, {
                activeBoss: null,
                bossSource: null, // 'duty', 'summon', or 'recruit'
                pendingNpcToReplace: null,
                savedBossHp: 0,
                savedPartyHp: 0,
                maxBossHp: 0,
                lbUses: 0, // Track limit break usage (max 4 per boss encounter)
                lbTriggeredThisFight: false,
                reachedUnder5Percent: false,
                hiddenPhoenixLoot: 0, // Hidden Phoenix Down loot memory pool
                lastBonusRate: 0
            });

            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

            // Send tutorial ephemeral message for first-time users
            if (isFirstTimeUser) {
                const tutorialEmbed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.tutorialTitle'))
                    .setDescription(
                        t(lang, 'sciondex.tutorial')
                    )
                    .setColor('#F1C40F');

                const tutorialRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_tutorial_ok').setLabel(t(lang, 'sciondex.ok')).setStyle(ButtonStyle.Success)
                );

                return await interaction.editReply({ embeds: [tutorialEmbed], components: [tutorialRow] });
            }

            const initialPayload = await renderGameWindow(interaction, null);
            
            if (!initialPayload) {
                return await interaction.editReply({ content: t(lang, 'sciondex.fetchFailedLater') });
            }

            await interaction.editReply(initialPayload);
        } catch (err) {
            console.error('❌ Error executing /sciondex command:', err);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: t(lang, 'sciondex.openError'), flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
        }
    }
};

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

async function getUserData(userId) {
    const cleanUserId = String(userId);
    const [rows] = await pool.execute('SELECT * FROM sciondex_users WHERE user_id = ?', [cleanUserId]);
    return rows[0] || null;
}

async function getUserParty(userId) {
    const cleanUserId = String(userId);
    const [rows] = await pool.execute(
        'SELECT slot, npc_id, star, hp, atk FROM sciondex_user_party WHERE user_id = ? ORDER BY slot ASC',
        [cleanUserId]
    );
    if (!rows || rows.length === 0) return [];

    return rows.map(r => {
        const npc = npcDex.find(n => String(n.id) === String(r.npc_id));
        if (!npc) return null;
        return {
            slot: Number(r.slot),
            ...npc,
            rarity: r.star !== null ? Number(r.star) : Number(npc.rarity),
            hp: r.hp !== null ? Number(r.hp) : Number(npc.hp),
            atk: r.atk !== null ? Number(r.atk) : Number(npc.atk),
            nativeRarity: Number(npc.rarity)
        };
    }).filter(Boolean);
}

// Release party star calculation multiplier formula (4x of current as requested)
function calculateNpcReleaseStars(rarity) {
    const r = Number(rarity);
    let baseStars = 0;
    if (r <= 4) baseStars = r * 1;
    else if (r <= 7) baseStars = r * 2;
    else if (r <= 9) baseStars = r * 3;
    else baseStars = r * 5;
    return baseStars * 4;
}

function calculatePartyStats(party) {
    const totalHp = party.reduce((sum, npc) => sum + (npc && npc.hp ? Number(npc.hp) : 0), 0);
    const totalAtk = party.reduce((sum, npc) => sum + (npc && npc.atk ? Number(npc.atk) : 0), 0);
    const totalReleaseStars = party.reduce((sum, npc) => sum + (npc && npc.rarity ? calculateNpcReleaseStars(npc.rarity) : 0), 0);
    return { totalHp, totalAtk, totalReleaseStars };
}

function getBossHpMultiplier(rarity) {
    const safeRarity = Number(rarity);
    if (safeRarity <= 1) return 100;
    if (safeRarity >= 10) return 300;
    return 100 + ((safeRarity - 1) * (200 / 9));
}

function getRandomNpcByRarity(targetRarity) {
    const poolByRarity = npcDex.filter(n => Number(n.rarity) === Number(targetRarity));
    if (poolByRarity.length === 0) return npcDex[Math.floor(Math.random() * npcDex.length)];
    return poolByRarity[Math.floor(Math.random() * poolByRarity.length)];
}

function getRandomDutyFinderNpc() {
    const rarityTable = [
        { rarity: 10, chance: 0.010 },
        { rarity: 9,  chance: 0.015 },
        { rarity: 8,  chance: 0.020 },
        { rarity: 7,  chance: 0.030 },
        { rarity: 6,  chance: 0.050 },
        { rarity: 5,  chance: 0.080 },
        { rarity: 4,  chance: 0.150 },
        { rarity: 3,  chance: 0.300 },
        { rarity: 2,  chance: 0.520 },
        { rarity: 1,  chance: 0.900 }
    ];

    let targetRarity = 1;
    for (const check of rarityTable) {
        if (Math.random() <= check.chance) {
            targetRarity = check.rarity;
            break;
        }
    }

    return getRandomNpcByRarity(targetRarity);
}

// Recruit Button Roll Logic for players with 4 NPCs (Restricted 4★-10★)
function getRandom4to10StarRecruitNpc() {
    const spawnWeights = [
        { rarity: 4, chance: 0.80 },
        { rarity: 5, chance: 0.60 },
        { rarity: 6, chance: 0.45 },
        { rarity: 7, chance: 0.30 },
        { rarity: 8, chance: 0.20 },
        { rarity: 9, chance: 0.10 },
        { rarity: 10, chance: 0.05 }
    ];

    const rolledRarities = spawnWeights.filter(w => Math.random() <= w.chance);
    
    let selectedRarity = 4;
    if (rolledRarities.length > 0) {
        rolledRarities.sort((a, b) => b.rarity - a.rarity);
        selectedRarity = rolledRarities[0].rarity;
    }

    return getRandomNpcByRarity(selectedRarity);
}

function getRandomSummonNpc() {
    const roll = Math.random() * 100;
    let targetRarity = 8;

    if (roll < 10) targetRarity = 10;
    else if (roll < 40) targetRarity = 9;
    else targetRarity = 8;

    return getRandomNpcByRarity(targetRarity);
}

// Base Recruitment Rates
function getBaseRecruitChance(rarity, source) {
    const safeRarity = Number(rarity);
    if (source === 'summon') {
        if (safeRarity === 10) return 0.15;
        if (safeRarity === 9)  return 0.25;
        return 0.30;                   
    } else if (source === 'recruit') {
        const recruitRates = {
            4: 0.90,
            5: 0.70,
            6: 0.55,
            7: 0.40,
            8: 0.30,
            9: 0.20,
            10: 0.15
        };
        return recruitRates[safeRarity] || 0.50;
    } else {
        const dutyRates = {
            1: 1.00,
            2: 0.90,
            3: 0.77,
            4: 0.60,
            5: 0.44,
            6: 0.35,
            7: 0.27,
            8: 0.20,
            9: 0.15,
            10: 0.10
        };
        return dutyRates[safeRarity] || 0.10;
    }
}

// Random bonus rates
function rollRecruitmentBonus() {
    const roll = Math.random() * 100;
    if (roll < 0.5) return 0.50;  
    if (roll < 10.5) return 0.30; 
    if (roll < 50.0) return 0.10; 
    return 0.00;                  
}

// Updated Star Drop Ranges per Rarity Tier
function calculateMobLootDrops(rarity) {
    const r = Number(rarity);
    let starsDropped = 0;
    let shardsDropped = 0;

    const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    if (r <= 3) {
        starsDropped = getRandomInt(3, 6);
        shardsDropped = Math.random() < 0.60 ? 1 : 2;
    } else if (r <= 6) {
        starsDropped = getRandomInt(5, 10);
        shardsDropped = getRandomInt(1, 3);
    } else if (r <= 9) {
        starsDropped = getRandomInt(12, 30);
        shardsDropped = getRandomInt(3, 5);
    } else { 
        starsDropped = getRandomInt(40, 50);
        shardsDropped = getRandomInt(5, 8);
    }

    return { starsDropped, shardsDropped };
}

function renderLoadingWindow(statusText, lang = 'en') {
    if (statusText === undefined) statusText = t(lang, 'sciondex.loading');
    const embed = new EmbedBuilder()
        .setTitle(t(lang, 'sciondex.loadingTitle'))
        .setDescription(statusText)
        .setColor('#E67E22');

    return { content: null, embeds: [embed], components: [] };
}

async function renderGameWindow(interaction, customText = null, cachedUserData = null, cachedParty = null) {
    const lang = await userLanguage.forInteraction(interaction);
    const userId = String(interaction.user.id);
    const userData = cachedUserData || await getUserData(userId);
    if (!userData) return null;

    const party = cachedParty || await getUserParty(userId);
    const { totalHp, totalAtk } = calculatePartyStats(party);
    const userStars = userData.stars !== null && userData.stars !== undefined ? Number(userData.stars) : 0;
    const currentPhoenix = userData.phoenix_downs !== null && userData.phoenix_downs !== undefined ? Number(userData.phoenix_downs) : 0;
    const shardsCount = userData.shards !== null && userData.shards !== undefined ? Number(userData.shards) : 0;

    const embed = new EmbedBuilder()
        .setTitle(t(lang, 'sciondex.gameTitle', { name: interaction.user.username }))
        .setColor('#2F3136')
        .addFields(
            { name: t(lang, 'sciondex.stars'), value: `${userStars}`, inline: false },
            { name: t(lang, 'sciondex.shards'), value: `${shardsCount}`, inline: true },
            { name: t(lang, 'sciondex.phoenix'), value: `${currentPhoenix}/10`, inline: true },
            { name: '\u200B', value: '\u200B', inline: true }
        );

    let partyDesc = '';
    for (let i = 1; i <= 4; i++) {
        const member = party.find(p => p.slot === i);
        if (member) {
            partyDesc += t(lang, 'sciondex.slot', { i, rarity: member.rarity, name: member.name, hp: member.hp, atk: member.atk });
        } else {
            partyDesc += t(lang, 'sciondex.slotEmpty', { i });
        }
    }
    embed.addFields(
        { name: t(lang, 'sciondex.currentParty'), value: partyDesc || t(lang, 'sciondex.noneParty') },
        { name: t(lang, 'sciondex.totalStatsYour'), value: t(lang, 'sciondex.totalStatsValue', { hp: totalHp, atk: totalAtk }), inline: false }
    );

    if (customText) {
        embed.setDescription(customText);
    }

    const hasNoNpc = party.length === 0;
    const summonDisabled = hasNoNpc || shardsCount < 20;

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_recruit').setLabel(t(lang, 'sciondex.recruit')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('btn_duty').setLabel(t(lang, 'sciondex.dutyFinder')).setStyle(ButtonStyle.Success).setDisabled(hasNoNpc),
        new ButtonBuilder().setCustomId('btn_summon').setLabel(t(lang, 'sciondex.summon')).setStyle(ButtonStyle.Secondary).setDisabled(summonDisabled)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_manage_party').setLabel(t(lang, 'sciondex.manageParty')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_exit').setLabel(t(lang, 'sciondex.exit')).setStyle(ButtonStyle.Danger)
    );

    return { content: null, embeds: [embed], components: [row1, row2] };
}

async function renderPartyManagementWindow(interaction, customText = null) {
    const lang = await userLanguage.forInteraction(interaction);
    const userId = String(interaction.user.id);
    const party = await getUserParty(userId);
    const userData = await getUserData(userId);
    const userStars = userData && userData.stars !== null ? Number(userData.stars) : 0;
    const { totalHp, totalAtk, totalReleaseStars } = calculatePartyStats(party);

    const embed = new EmbedBuilder()
        .setTitle(t(lang, 'sciondex.partyMgmt'))
        .setColor('#3498DB')
        .addFields({ name: t(lang, 'sciondex.stars'), value: `${userStars}`, inline: false });

    let partyDesc = '';
    for (let i = 1; i <= 4; i++) {
        const member = party.find(p => p.slot === i);
        if (member) {
            partyDesc += t(lang, 'sciondex.slot', { i, rarity: member.rarity, name: member.name, hp: member.hp, atk: member.atk });
        } else {
            partyDesc += t(lang, 'sciondex.slotEmpty', { i });
        }
    }

    embed.addFields(
        { name: t(lang, 'sciondex.currentPartyMgmt'), value: partyDesc || t(lang, 'sciondex.noneParty') },
        { name: t(lang, 'sciondex.totalStats'), value: t(lang, 'sciondex.totalStatsValue', { hp: totalHp, atk: totalAtk }) }
    );

    if (customText) {
        embed.setDescription(customText);
    }

    const hasNoNpc = party.length === 0;
    const hasTenStarNpc = party.some(p => p.rarity >= 10);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_show_party_pm').setLabel(t(lang, 'sciondex.showParty')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('btn_release_prompt')
            .setLabel(t(lang, 'sciondex.releaseParty', { stars: totalReleaseStars }))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(totalReleaseStars < 10 || hasNoNpc),
        new ButtonBuilder()
            .setCustomId('btn_levelup_prompt')
            .setLabel(t(lang, 'sciondex.levelUp'))
            .setStyle(ButtonStyle.Primary)
            .setDisabled(hasNoNpc),
        new ButtonBuilder()
            .setCustomId('btn_changestat_prompt')
            .setLabel(t(lang, 'sciondex.changeStat'))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasTenStarNpc)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_back_to_game').setLabel(t(lang, 'sciondex.back')).setStyle(ButtonStyle.Secondary)
    );

    return { content: null, embeds: [embed], components: [row1, row2] };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function transitionEphemeralFlow(interaction, getNewPayloadFn, statusText) {
    const lang = await userLanguage.forInteraction(interaction);
    if (statusText === undefined) statusText = t(lang, 'sciondex.loading');
    try {
        const loadingMessage = await interaction.update({
            ...renderLoadingWindow(statusText, lang),
            withResponse: true
        }).then(res => res?.resource?.message ?? null);

        const newPayload = await getNewPayloadFn();
        if (!newPayload) {
            await interaction.followUp({ content: t(lang, 'sciondex.fetchFailed'), flags: [MessageFlags.Ephemeral] });
            await delay(1000);
            if (loadingMessage) await interaction.webhook.deleteMessage(loadingMessage.id).catch(() => {});
            return false;
        }

        await interaction.followUp({ ...newPayload, flags: [MessageFlags.Ephemeral] });

        await delay(500);
        if (loadingMessage && loadingMessage.id) {
            await interaction.webhook.deleteMessage(loadingMessage.id).catch(() => {});
        }

        return true;
    } catch (err) {
        console.warn(`⚠️ Failed interaction transition (ID: ${interaction.id}):`, err.message);
        return false;
    }
}

function getRandomArrayItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// Level requirement map for dynamic dropdown labels
const levelUpRequirements = {
    1: { stars: 10, failRate: 0.10 },
    2: { stars: 15, failRate: 0.13 },
    3: { stars: 20, failRate: 0.16 },
    4: { stars: 30, failRate: 0.20 },
    5: { stars: 45, failRate: 0.24 },
    6: { stars: 60, failRate: 0.29 },
    7: { stars: 80, failRate: 0.35 },
    8: { stars: 100, failRate: 0.42 },
    9: { stars: 150, failRate: 0.50 }
};

// ==========================================
// --- GLOBAL INTERACTION EVENT LISTENER ---
// ==========================================

module.exports.handleButtonInteraction = async function(interaction) {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    if (!interaction.customId.startsWith('btn_') && !interaction.customId.startsWith('select_')) return;

    const lang = await userLanguage.forInteraction(interaction);
    const glang = userLanguage.forGuild(interaction.guild); // messages everyone in the channel sees: the server's language
    try {
        const userId = String(interaction.user.id);

        // --- TUTORIAL OK BUTTON ---
        if (interaction.customId === 'btn_tutorial_ok') {
            return await transitionEphemeralFlow(interaction, async () => {
                return await renderGameWindow(interaction, t(lang, 'sciondex.welcome'));
            }, t(lang, 'sciondex.openingGame'));
        }

        // --- MANAGE PARTY BUTTON ---
        if (interaction.customId === 'btn_manage_party') {
            return await transitionEphemeralFlow(interaction, async () => {
                return await renderPartyManagementWindow(interaction);
            }, t(lang, 'sciondex.openingParty'));
        }

        // --- BACK TO GAME WINDOW ---
        if (interaction.customId === 'btn_back_to_game') {
            return await transitionEphemeralFlow(interaction, async () => {
                return await renderGameWindow(interaction);
            }, t(lang, 'sciondex.returningGame'));
        }

        // --- SHOW PARTY BUTTON (FROM PARTY MANAGEMENT) ---
        if (interaction.customId === 'btn_show_party_pm') {
            const party = await getUserParty(userId);

            if (!party || party.length === 0) {
                await interaction.channel.send(t(glang, 'sciondex.pub.noNpcs', { userId })).catch(() => {});
                return await interaction.reply({ content: t(lang, 'sciondex.sharedNoNpcs'), flags: [MessageFlags.Ephemeral] });
            }

            const { totalHp, totalAtk } = calculatePartyStats(party);
            
            const embed = new EmbedBuilder()
                .setTitle(t(glang, 'sciondex.pub.partyTitle', { name: interaction.user.username }))
                .setColor('#3498DB')
                .setThumbnail(interaction.user.displayAvatarURL());

            let partyDesc = '';
            for (let i = 1; i <= 4; i++) {
                const member = party.find(p => p.slot === i);
                if (member) {
                    partyDesc += t(glang, 'sciondex.pub.slot', { i, rarity: member.rarity, name: member.name, hp: member.hp, atk: member.atk });
                } else {
                    partyDesc += t(glang, 'sciondex.slotEmpty', { i });
                }
            }

            embed.addFields(
                { name: t(glang, 'sciondex.pub.members'), value: partyDesc },
                { name: t(glang, 'sciondex.totalStatsYour'), value: t(glang, 'sciondex.totalStatsValue', { hp: totalHp, atk: totalAtk }), inline: false }
            );

            await interaction.channel.send({ content: t(glang, 'sciondex.pub.hereIsParty', { userId }), embeds: [embed] }).catch(() => {});
            return await interaction.reply({ content: t(lang, 'sciondex.sharedParty'), flags: [MessageFlags.Ephemeral] });
        }

        // --- LEVEL UP PROMPT ---
        if (interaction.customId === 'btn_levelup_prompt') {
            return await transitionEphemeralFlow(interaction, async () => {
                const party = await getUserParty(userId);
                const eligibleNpcs = party.filter(p => p.rarity < 10);

                if (eligibleNpcs.length === 0) {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.allMaxed'));
                }

                const options = eligibleNpcs.map(p => {
                    const req = levelUpRequirements[p.rarity];
                    return {
                        label: t(lang, 'sciondex.npcOption', { slot: p.slot, name: p.name, rarity: p.rarity }),
                        description: t(lang, 'sciondex.levelCost', { cost: req ? req.stars : 0, hp: p.hp, atk: p.atk }),
                        value: String(p.slot)
                    };
                });

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_levelup_slot')
                    .setPlaceholder(t(lang, 'sciondex.selectLevelUp'))
                    .addOptions(options);

                const row1 = new ActionRowBuilder().addComponents(selectMenu);
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_levelup_cancel').setLabel(t(lang, 'sciondex.cancel')).setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('btn_levelup_ok_dummy').setLabel(t(lang, 'sciondex.okMinusStar')).setStyle(ButtonStyle.Success).setDisabled(true)
                );

                const embed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.levelUpTitle'))
                    .setDescription(t(lang, 'sciondex.levelUpHelp'))
                    .setColor('#3498DB');

                return { content: null, embeds: [embed], components: [row1, row2] };
            }, t(lang, 'sciondex.preparingLevelUp'));
        }

        // --- LEVEL UP SELECT DROPDOWN (CHANGES OK BUTTON DYNAMICALLY) ---
        if (interaction.customId === 'select_levelup_slot' && interaction.isStringSelectMenu()) {
            const chosenSlot = parseInt(interaction.values[0], 10);
            const party = await getUserParty(userId);
            const targetNpc = party.find(p => p.slot === chosenSlot);

            if (!targetNpc || targetNpc.rarity >= 10) {
                return await interaction.update({ content: t(lang, 'sciondex.invalidSelection') });
            }

            const req = levelUpRequirements[targetNpc.rarity];
            const starCost = req ? req.stars : 0;

            // Preserve select menu options
            const eligibleNpcs = party.filter(p => p.rarity < 10);
            const options = eligibleNpcs.map(p => {
                const r = levelUpRequirements[p.rarity];
                return {
                    label: t(lang, 'sciondex.npcOption', { slot: p.slot, name: p.name, rarity: p.rarity }),
                    description: t(lang, 'sciondex.levelCost', { cost: r ? r.stars : 0, hp: p.hp, atk: p.atk }),
                    value: String(p.slot),
                    default: Number(p.slot) === chosenSlot
                };
            });

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_levelup_slot')
                .setPlaceholder(t(lang, 'sciondex.selected', { slot: chosenSlot, name: targetNpc.name }))
                .addOptions(options);

            const row1 = new ActionRowBuilder().addComponents(selectMenu);
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_levelup_cancel').setLabel(t(lang, 'sciondex.cancel')).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`btn_levelup_confirm_${chosenSlot}`).setLabel(t(lang, 'sciondex.okStars', { cost: starCost })).setStyle(ButtonStyle.Success)
            );

            const embed = new EmbedBuilder()
                .setTitle(t(lang, 'sciondex.levelUpTitle'))
                .setDescription(t(lang, 'sciondex.levelUpSelected', { name: targetNpc.name, from: targetNpc.rarity, to: targetNpc.rarity + 1, cost: starCost }))
                .setColor('#3498DB');

            return await interaction.update({ embeds: [embed], components: [row1, row2] });
        }

        // --- LEVEL UP CANCEL ---
        if (interaction.customId === 'btn_levelup_cancel') {
            return await transitionEphemeralFlow(interaction, async () => {
                return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.levelUpCancelled'));
            }, t(lang, 'sciondex.returningParty'));
        }

        // --- LEVEL UP CONFIRM BUTTON ---
        if (interaction.customId.startsWith('btn_levelup_confirm_')) {
            const chosenSlot = parseInt(interaction.customId.split('_')[3], 10);
            return await transitionEphemeralFlow(interaction, async () => {
                const party = await getUserParty(userId);
                const targetNpc = party.find(p => p.slot === chosenSlot);

                if (!targetNpc || targetNpc.rarity >= 10) {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.invalidOrMaxed'));
                }

                const currentRarity = targetNpc.rarity;
                const nextRarity = currentRarity + 1;
                const req = levelUpRequirements[currentRarity];
                
                const userData = await getUserData(userId);
                const userStars = userData && userData.stars !== null ? Number(userData.stars) : 0;

                if (userStars < req.stars) {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.notEnoughStars', { need: req.stars, have: userStars }));
                }

                // Deduct stars
                await pool.execute('UPDATE sciondex_users SET stars = stars - ? WHERE user_id = ?', [req.stars, userId]);

                // Roll success/fail
                const failed = Math.random() < req.failRate;

                if (failed) {
                    await interaction.channel.send(t(glang, 'sciondex.pub.levelFailed', { userId, name: targetNpc.name, rarity: nextRarity })).catch(() => {});
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.levelFailed', { name: targetNpc.name, rarity: nextRarity, lost: req.stars }));
                }

                // Success: Calculate new stats (+19% to +21%)
                const increasePercent = (19 + Math.random() * 2) / 100;
                const newHp = Math.round(targetNpc.hp * (1 + increasePercent));
                const newAtk = Math.round(targetNpc.atk * (1 + increasePercent));

                await pool.execute(
                    `UPDATE sciondex_user_party 
                     SET star = ?, hp = ?, atk = ? 
                     WHERE user_id = ? AND slot = ?`,
                    [nextRarity, newHp, newAtk, userId, chosenSlot]
                );

                await interaction.channel.send(t(glang, 'sciondex.pub.levelOk', { userId, name: targetNpc.name, from: currentRarity, to: nextRarity })).catch(() => {});

                return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.levelOk', { name: targetNpc.name, rarity: nextRarity, hp: newHp, atk: newAtk }));
            }, t(lang, 'sciondex.processingLevelUp'));
        }

        // --- CHANGE STAT PROMPT ---
        if (interaction.customId === 'btn_changestat_prompt') {
            return await transitionEphemeralFlow(interaction, async () => {
                const party = await getUserParty(userId);
                const userData = await getUserData(userId);
                const userStars = userData && userData.stars !== null ? Number(userData.stars) : 0;

                if (userStars < 20) {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.need20'));
                }

                // Exclude Godbert from changing stats
                const eligibleNpcs = party.filter(p => p.rarity >= 10 && p.name.toLowerCase() !== 'godbert manderville');

                if (eligibleNpcs.length === 0) {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.no10Star'));
                }

                const options = eligibleNpcs.map(p => ({
                    label: t(lang, 'sciondex.npcOption10', { slot: p.slot, name: p.name }),
                    description: t(lang, 'sciondex.currentStats', { hp: p.hp, atk: p.atk }),
                    value: String(p.slot)
                }));

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_changestat_slot')
                    .setPlaceholder(t(lang, 'sciondex.select10Star'))
                    .addOptions(options);

                const row1 = new ActionRowBuilder().addComponents(selectMenu);
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_changestat_cancel').setLabel(t(lang, 'sciondex.cancel')).setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('btn_changestat_ok_dummy').setLabel(t(lang, 'sciondex.ok20')).setStyle(ButtonStyle.Success).setDisabled(true)
                );

                const embed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.changeStatTitle'))
                    .setDescription(t(lang, 'sciondex.changeStatHelp'))
                    .setColor('#E67E22');

                return { content: null, embeds: [embed], components: [row1, row2] };
            }, t(lang, 'sciondex.preparingReroll'));
        }

        // --- CHANGE STAT SELECT SLOT MENU ---
        if (interaction.customId === 'select_changestat_slot' && interaction.isStringSelectMenu()) {
            const chosenSlot = parseInt(interaction.values[0], 10);
            const party = await getUserParty(userId);
            const targetNpc = party.find(p => p.slot === chosenSlot);

            if (!targetNpc) {
                return await interaction.update({ content: t(lang, 'sciondex.invalidSelection') });
            }

            const eligibleNpcs = party.filter(p => p.rarity >= 10 && p.name.toLowerCase() !== 'godbert manderville');
            const options = eligibleNpcs.map(p => ({
                label: t(lang, 'sciondex.npcOption10', { slot: p.slot, name: p.name }),
                description: t(lang, 'sciondex.currentStats', { hp: p.hp, atk: p.atk }),
                value: String(p.slot),
                default: Number(p.slot) === chosenSlot
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_changestat_slot')
                .setPlaceholder(t(lang, 'sciondex.selected', { slot: chosenSlot, name: targetNpc.name }))
                .addOptions(options);

            const row1 = new ActionRowBuilder().addComponents(selectMenu);
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('btn_changestat_cancel').setLabel(t(lang, 'sciondex.cancel')).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`btn_changestat_confirm_${chosenSlot}`).setLabel(t(lang, 'sciondex.ok20')).setStyle(ButtonStyle.Success)
            );

            const embed = new EmbedBuilder()
                .setTitle(t(lang, 'sciondex.changeStatTitle'))
                .setDescription(t(lang, 'sciondex.changeStatSelected', { name: targetNpc.name }))
                .setColor('#E67E22');

            return await interaction.update({ embeds: [embed], components: [row1, row2] });
        }

        // --- CHANGE STAT CANCEL ---
        if (interaction.customId === 'btn_changestat_cancel') {
            return await transitionEphemeralFlow(interaction, async () => {
                return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.rerollCancelled'));
            }, t(lang, 'sciondex.returningParty'));
        }

        // --- CHANGE STAT CONFIRM BUTTON ---
        if (interaction.customId.startsWith('btn_changestat_confirm_')) {
            const chosenSlot = parseInt(interaction.customId.split('_')[3], 10);
            return await transitionEphemeralFlow(interaction, async () => {
                const userData = await getUserData(userId);
                const userStars = userData && userData.stars !== null ? Number(userData.stars) : 0;

                if (userStars < 20) {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.notEnough20'));
                }

                const party = await getUserParty(userId);
                const targetNpc = party.find(p => p.slot === chosenSlot);

                if (!targetNpc || targetNpc.rarity < 10 || targetNpc.name.toLowerCase() === 'godbert manderville') {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.invalidSelection'));
                }

                // Deduct 20 stars
                await pool.execute('UPDATE sciondex_users SET stars = stars - 20 WHERE user_id = ?', [userId]);

                // Find lowest and highest HP/ATK among all 10-star NPCs in npcdex.json
                const tenStarDex = npcDex.filter(n => Number(n.rarity) === 10);
                const minHp = Math.min(...tenStarDex.map(n => n.hp));
                const maxHp = Math.max(...tenStarDex.map(n => n.hp));
                const minAtk = Math.min(...tenStarDex.map(n => n.atk));
                const maxAtk = Math.max(...tenStarDex.map(n => n.atk));

                const newHp = Math.floor(Math.random() * (maxHp - minHp + 1)) + minHp;
                const newAtk = Math.floor(Math.random() * (maxAtk - minAtk + 1)) + minAtk;

                const oldHp = targetNpc.hp;
                const oldAtk = targetNpc.atk;

                // Save new stats to database immediately
                await pool.execute(
                    `UPDATE sciondex_user_party 
                     SET hp = ?, atk = ? 
                     WHERE user_id = ? AND slot = ?`,
                    [newHp, newAtk, userId, chosenSlot]
                );

                const hpArrow = newHp > oldHp ? '📈' : (newHp < oldHp ? '📉' : '➡️');
                const atkArrow = newAtk > oldAtk ? '📈' : (newAtk < oldAtk ? '📉' : '➡️');

                const embed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.rerollTitle', { name: targetNpc.name }))
                    .setDescription(
                        t(lang, 'sciondex.rerollText', { name: targetNpc.name, oldHp, newHp, hpArrow, oldAtk, newAtk, atkArrow })
                    )
                    .setColor('#2ECC71');

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_changestat_ok').setLabel(t(lang, 'sciondex.ok')).setStyle(ButtonStyle.Success)
                );

                return { content: null, embeds: [embed], components: [row] };
            }, t(lang, 'sciondex.rerolling'));
        }

        // --- CHANGE STAT OK BUTTON ---
        if (interaction.customId === 'btn_changestat_ok') {
            return await transitionEphemeralFlow(interaction, async () => {
                return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.statsUpdated'));
            }, t(lang, 'sciondex.returningParty'));
        }

        // --- RELEASE PARTY PROMPT ---
        if (interaction.customId === 'btn_release_prompt') {
            return await transitionEphemeralFlow(interaction, async () => {
                const party = await getUserParty(userId);
                if (!party || party.length === 0) {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.noMembersRelease'));
                }

                const { totalReleaseStars } = calculatePartyStats(party);

                if (totalReleaseStars < 10) {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.releaseMin'));
                }

                const embed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.releaseTitle'))
                    .setDescription(t(lang, 'sciondex.releaseConfirm', { stars: totalReleaseStars }))
                    .setColor('#E67E22');

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_confirm_release').setLabel(t(lang, 'sciondex.yesRelease')).setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('btn_cancel_release').setLabel(t(lang, 'sciondex.noCancel')).setStyle(ButtonStyle.Secondary)
                );

                return { content: null, embeds: [embed], components: [row] };
            }, t(lang, 'sciondex.preparingRelease'));
        }

        // --- CONFIRM RELEASE PARTY ---
        if (interaction.customId === 'btn_confirm_release') {
            return await transitionEphemeralFlow(interaction, async () => {
                const party = await getUserParty(userId);
                const { totalReleaseStars } = calculatePartyStats(party);

                if (totalReleaseStars < 10) {
                    return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.releaseDenied'));
                }

                let partyListBlock = '```\n';
                for (let i = 1; i <= 4; i++) {
                    const member = party.find(p => p.slot === i);
                    if (member) {
                        partyListBlock += `${member.name} [${member.rarity}★]\n`;
                    }
                }
                partyListBlock += '```';

                const publicMessage = t(glang, 'sciondex.pub.released', { userId, list: partyListBlock, stars: totalReleaseStars });
                await interaction.channel.send(publicMessage).catch(() => {});

                await pool.execute(
                    `UPDATE sciondex_users 
                     SET stars = COALESCE(stars, 0) + ? 
                     WHERE user_id = ?`,
                    [totalReleaseStars, userId]
                );

                await pool.execute('DELETE FROM sciondex_user_party WHERE user_id = ?', [userId]);

                return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.released', { stars: totalReleaseStars }));
            }, t(lang, 'sciondex.releasing'));
        }

        // --- CANCEL RELEASE PARTY ---
        if (interaction.customId === 'btn_cancel_release') {
            return await transitionEphemeralFlow(interaction, async () => {
                return await renderPartyManagementWindow(interaction, t(lang, 'sciondex.releaseCancelled'));
            }, t(lang, 'sciondex.returningParty'));
        }

        // --- USE STARS FOR RECRUITMENT ---
        if (interaction.customId.startsWith('btn_use_stars_')) {
            return await transitionEphemeralFlow(interaction, async () => {
                const parts = interaction.customId.split('_');
                const starsToUse = parseInt(parts[3], 10);
                const targetBoostChance = parseFloat(parts[4]);

                const gameState = activeSessions.get(userId) || {};
                const targetNpc = gameState.activeBoss;

                if (!targetNpc) {
                    return await renderGameWindow(interaction, t(lang, 'sciondex.encounterExpired'));
                }

                // Confirmation window for use star button
                const embed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.useStarsTitle'))
                    .setDescription(t(lang, 'sciondex.useStarsConfirm', { stars: starsToUse, chance: Math.round(targetBoostChance * 100), name: targetNpc.name }))
                    .setColor('#F1C40F');

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`btn_confirm_usestars_${starsToUse}_${targetBoostChance}`).setLabel(t(lang, 'sciondex.confirm')).setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('btn_cancel_usestars').setLabel(t(lang, 'sciondex.cancel')).setStyle(ButtonStyle.Secondary)
                );

                return { content: null, embeds: [embed], components: [row] };
            }, t(lang, 'sciondex.preparingStars'));
        }

        // --- CANCEL USE STARS (FIXES BUG: PRESERVES VICTORY WINDOW & BONUS WITHOUT RESENDING BOSS DEFEATED) ---
        if (interaction.customId === 'btn_cancel_usestars') {
            return await transitionEphemeralFlow(interaction, async () => {
                const gameState = activeSessions.get(userId) || {};
                if (!gameState.activeBoss) {
                    return await renderGameWindow(interaction, t(lang, 'sciondex.starsCancelled'));
                }
                return await getBossVictoryPayload(interaction, gameState, userId, false);
            }, t(lang, 'sciondex.returningVictory'));
        }

        // --- CONFIRM USE STARS ---
        if (interaction.customId.startsWith('btn_confirm_usestars_')) {
            return await transitionEphemeralFlow(interaction, async () => {
                const parts = interaction.customId.split('_');
                const starsToUse = parseInt(parts[3], 10);
                const targetBoostChance = parseFloat(parts[4]);

                const gameState = activeSessions.get(userId) || {};
                const targetNpc = gameState.activeBoss;

                if (!targetNpc) {
                    return await renderGameWindow(interaction, t(lang, 'sciondex.encounterExpired'));
                }

                await pool.execute(
                    `UPDATE sciondex_users 
                     SET stars = GREATEST(0, COALESCE(stars, 0) - ?) 
                     WHERE user_id = ?`,
                    [starsToUse, userId]
                );

                const success = Math.random() <= targetBoostChance;

                if (!success) {
                    const consolationShards = Math.floor(Number(targetNpc.rarity) / 2);
                    if (consolationShards > 0) {
                        await pool.execute('UPDATE sciondex_users SET shards = shards + ? WHERE user_id = ?', [consolationShards, userId]);
                    }

                    gameState.activeBoss = null;
                    activeSessions.set(userId, gameState);

                    return await renderGameWindow(
                        interaction, 
                        t(lang, 'sciondex.recruitFailedStars', { stars: starsToUse, chance: Math.round(targetBoostChance * 100), name: targetNpc.name }) +
                        t(lang, 'sciondex.consolation', { shards: consolationShards })
                    );
                }

                await interaction.channel.send(t(glang, 'sciondex.pub.recruitedStars', { userId, stars: starsToUse, name: targetNpc.name, rarity: targetNpc.rarity })).catch(() => {});

                const party = await getUserParty(userId);
                gameState.pendingNpcToReplace = targetNpc;

                if (party.length < 4) {
                    const nextSlot = party.length + 1;
                    const safeNpcId = String(targetNpc.id);
                    await pool.execute(
                        `INSERT INTO sciondex_user_party (user_id, slot, npc_id, star, hp, atk) 
                         VALUES (?, ?, ?, ?, ?, ?) 
                         ON DUPLICATE KEY UPDATE npc_id = VALUES(npc_id), star = VALUES(star), hp = VALUES(hp), atk = VALUES(atk)`,
                        [userId, nextSlot, safeNpcId, targetNpc.rarity, targetNpc.hp, targetNpc.atk]
                    );

                    gameState.activeBoss = null;
                    gameState.pendingNpcToReplace = null;
                    activeSessions.set(userId, gameState);

                    return await renderGameWindow(interaction, t(lang, 'sciondex.recruitedStars', { name: targetNpc.name, slot: nextSlot, stars: starsToUse }));
                }

                const shardReward = Number(targetNpc.rarity);
                const options = party.map(p => ({
                    label: t(lang, 'sciondex.npcOption', { slot: p.slot, name: p.name, rarity: p.rarity }),
                    description: t(lang, 'sciondex.npcStats', { hp: p.hp, atk: p.atk }),
                    value: String(p.slot)
                }));

                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_replace_slot')
                    .setPlaceholder(t(lang, 'sciondex.selectReplace'))
                    .addOptions(options);

                const row1 = new ActionRowBuilder().addComponents(selectMenu);
                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`btn_get_shards_${shardReward}`)
                        .setLabel(t(lang, 'sciondex.getShards', { n: shardReward }))
                        .setStyle(ButtonStyle.Secondary)
                );

                const embed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.replaceTitle', { name: targetNpc.name, rarity: targetNpc.rarity }))
                    .setDescription(
                        t(lang, 'sciondex.replaceTextStars', { stars: starsToUse, hp: targetNpc.hp, atk: targetNpc.atk, title: targetNpc.title || t(lang, 'sciondex.none'), expansion: targetNpc.expansion || t(lang, 'sciondex.unknown') })
                    )
                    .setColor('#E67E22');

                return { content: null, embeds: [embed], components: [row1, row2] };
            }, t(lang, 'sciondex.applyingStars'));
        }

        // --- REPLACE MEMBER PROMPT ---
        if (interaction.customId === 'btn_replace_prompt') {
            const gameState = activeSessions.get(userId) || {};
            const targetNpc = gameState.pendingNpcToReplace || gameState.activeBoss;

            if (!targetNpc) {
                return await interaction.reply({ content: t(lang, 'sciondex.encounterExpiredNpc'), flags: [MessageFlags.Ephemeral] });
            }

            if (gameState.activeBoss) {
                const baseChance = getBaseRecruitChance(targetNpc.rarity, gameState.bossSource);
                const bonusChance = gameState.lastBonusRate || 0;
                const totalChance = Math.min(1.0, baseChance + bonusChance);
                
                const success = Math.random() <= totalChance;

                if (!success) {
                    const consolationShards = Math.floor(Number(targetNpc.rarity) / 2);
                    if (consolationShards > 0) {
                        await pool.execute('UPDATE sciondex_users SET shards = shards + ? WHERE user_id = ?', [consolationShards, userId]);
                    }

                    gameState.activeBoss = null;
                    activeSessions.set(userId, gameState);

                    const oldFailMsg = await interaction.update({
                        content: t(lang, 'sciondex.recruitFailed', { name: targetNpc.name, shards: consolationShards }),
                        embeds: [],
                        components: [],
                        withResponse: true
                    }).then(res => res?.resource?.message ?? null);

                    const failGamePayload = await renderGameWindow(interaction, t(lang, 'sciondex.recruitFailedShort', { name: targetNpc.name, shards: consolationShards }));
                    await interaction.followUp({ ...failGamePayload, flags: [MessageFlags.Ephemeral] });

                    await delay(2000);
                    if (oldFailMsg && oldFailMsg.id) {
                        await interaction.webhook.deleteMessage(oldFailMsg.id).catch(() => {});
                    }
                    return;
                }

                await interaction.channel.send(t(glang, 'sciondex.pub.recruitedDefeat', { userId, name: targetNpc.name, rarity: targetNpc.rarity })).catch(() => {});
            }

            const oldMsg = await interaction.update({
                content: t(lang, 'sciondex.saving'),
                embeds: [],
                components: [],
                withResponse: true
            }).then(res => res?.resource?.message ?? null);

            const party = await getUserParty(userId);
            const shardReward = Number(targetNpc.rarity);

            const options = party.map(p => ({
                label: t(lang, 'sciondex.npcOption', { slot: p.slot, name: p.name, rarity: p.rarity }),
                description: t(lang, 'sciondex.npcStats', { hp: p.hp, atk: p.atk }),
                value: String(p.slot)
            }));

            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('select_replace_slot')
                .setPlaceholder(t(lang, 'sciondex.selectReplace'))
                .addOptions(options);

            const row1 = new ActionRowBuilder().addComponents(selectMenu);
            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`btn_get_shards_${shardReward}`)
                    .setLabel(t(lang, 'sciondex.getShards', { n: shardReward }))
                    .setStyle(ButtonStyle.Secondary)
            );

            const embed = new EmbedBuilder()
                .setTitle(t(lang, 'sciondex.replaceTitle', { name: targetNpc.name, rarity: targetNpc.rarity }))
                .setDescription(
                    t(lang, 'sciondex.replaceText', { hp: targetNpc.hp, atk: targetNpc.atk, title: targetNpc.title || t(lang, 'sciondex.none'), expansion: targetNpc.expansion || t(lang, 'sciondex.unknown') })
                )
                .setColor('#E67E22');

            await interaction.followUp({ embeds: [embed], components: [row1, row2], flags: [MessageFlags.Ephemeral] });

            await delay(2000);
            if (oldMsg && oldMsg.id) {
                await interaction.webhook.deleteMessage(oldMsg.id).catch(() => {});
            }
            return;
        }

        // --- SELECT SLOT MENU ---
        if (interaction.customId === 'select_replace_slot' && interaction.isStringSelectMenu()) {
            const chosenSlot = parseInt(interaction.values[0], 10);
            const gameState = activeSessions.get(userId) || {};
            const newNpc = gameState.pendingNpcToReplace || gameState.activeBoss;

            if (!newNpc || chosenSlot < 1 || chosenSlot > 4) {
                return await interaction.update({ content: t(lang, 'sciondex.sessionExpired'), embeds: [], components: [] });
            }

            const dropdownMsg = await interaction.update({
                content: t(lang, 'sciondex.savingSlot'),
                embeds: [],
                components: [],
                withResponse: true
            }).then(res => res?.resource?.message ?? null);

            const safeNpcId = String(newNpc.id);

            await pool.execute(
                `INSERT INTO sciondex_user_party (user_id, slot, npc_id, star, hp, atk) 
                 VALUES (?, ?, ?, ?, ?, ?) 
                 ON DUPLICATE KEY UPDATE npc_id = VALUES(npc_id), star = VALUES(star), hp = VALUES(hp), atk = VALUES(atk)`,
                [userId, chosenSlot, safeNpcId, newNpc.rarity, newNpc.hp, newNpc.atk]
            );

            gameState.pendingNpcToReplace = null;
            gameState.activeBoss = null;
            activeSessions.set(userId, gameState);

            const newGamePayload = await renderGameWindow(interaction, t(lang, 'sciondex.placed', { name: newNpc.name, slot: chosenSlot }));
            await interaction.followUp({ ...newGamePayload, flags: [MessageFlags.Ephemeral] });

            await delay(2000);
            if (dropdownMsg && dropdownMsg.id) {
                await interaction.webhook.deleteMessage(dropdownMsg.id).catch(() => {});
            }
            return;
        }

        // --- EXIT ---
        if (interaction.customId === 'btn_exit') {
            activeSessions.delete(userId);
            await interaction.update({
                content: t(lang, 'sciondex.closed'),
                embeds: [],
                components: []
            }).catch(() => {});

            setTimeout(async () => {
                await interaction.webhook.deleteMessage('@original').catch(() => {});
            }, 1000);
            return;
        }

        // --- RECRUIT ---
        if (interaction.customId === 'btn_recruit') {
            return await transitionEphemeralFlow(interaction, async () => {
                const userData = await getUserData(userId);
                if (!userData) return null;

                const today = new Date().toISOString().split('T')[0];
                const party = await getUserParty(userId);

                if (!party || party.length === 0) {
                    await pool.execute('UPDATE sciondex_users SET phoenix_downs = 10, last_recruit_date = ? WHERE user_id = ?', [today, userId]);

                    const newRecruits = [];
                    const twoStarCount = Math.random() < 0.5 ? 1 : 2;
                    const oneStarCount = 4 - twoStarCount;

                    for (let i = 0; i < twoStarCount; i++) {
                        newRecruits.push(getRandomNpcByRarity(2));
                    }
                    for (let i = 0; i < oneStarCount; i++) {
                        newRecruits.push(getRandomNpcByRarity(1));
                    }

                    for (let slot = 1; slot <= 4; slot++) {
                        const npc = newRecruits[slot - 1];
                        const safeNpcId = String(npc.id);
                        await pool.execute(
                            `INSERT INTO sciondex_user_party (user_id, slot, npc_id, star, hp, atk) 
                             VALUES (?, ?, ?, ?, ?, ?) 
                             ON DUPLICATE KEY UPDATE npc_id = VALUES(npc_id), star = VALUES(star), hp = VALUES(hp), atk = VALUES(atk)`,
                            [userId, slot, safeNpcId, npc.rarity, npc.hp, npc.atk]
                        );
                    }

                    const recruitNames = newRecruits.map(n => `**${n.name}** [${n.rarity}★]`).join(', ');
                    await interaction.channel.send(t(glang, 'sciondex.pub.starter', { userId, names: recruitNames })).catch(() => {});

                    return await renderGameWindow(interaction, t(lang, 'sciondex.starter', { names: recruitNames }));
                }

                if (userData.last_recruit_date === today) {
                    return await renderGameWindow(interaction, t(lang, 'sciondex.alreadyRecruited'), userData);
                }

                await pool.execute('UPDATE sciondex_users SET last_recruit_date = ? WHERE user_id = ?', [today, userId]);

                const gameState = activeSessions.get(userId) || {};
                const rolledNpc = getRandom4to10StarRecruitNpc(); 
                gameState.pendingNpcToReplace = rolledNpc;
                gameState.bossSource = 'recruit';
                gameState.lastBonusRate = rollRecruitmentBonus();
                activeSessions.set(userId, gameState);

                const shardReward = Number(rolledNpc.rarity);

                const embed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.dailyTitle'))
                    .setDescription(t(lang, 'sciondex.dailyText', { name: rolledNpc.name, rarity: rolledNpc.rarity, title: rolledNpc.title || t(lang, 'sciondex.none'), hp: rolledNpc.hp, atk: rolledNpc.atk, effect: rolledNpc.additional_effect || t(lang, 'sciondex.none') }))
                    .setColor('#F1C40F');

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_replace_prompt').setLabel(t(lang, 'sciondex.replaceMember')).setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`btn_get_shards_${shardReward}`).setLabel(t(lang, 'sciondex.getShards', { n: shardReward })).setStyle(ButtonStyle.Secondary)
                );

                await interaction.channel.send(t(glang, 'sciondex.pub.tryingRecruit', { userId, name: rolledNpc.name, rarity: rolledNpc.rarity })).catch(() => {});

                return { content: null, embeds: [embed], components: [row] };
            }, t(lang, 'sciondex.recruiting'));
        }

        // --- DUTY FINDER ENCOUNTER ---
        if (interaction.customId === 'btn_duty') {
            return await transitionEphemeralFlow(interaction, async () => {
                const party = await getUserParty(userId);
                if (party.length === 0) {
                    return await renderGameWindow(interaction, t(lang, 'sciondex.noNpcs'), null, party);
                }

                const gameState = activeSessions.get(userId) || {};
                const boss = getRandomDutyFinderNpc();
                gameState.activeBoss = boss;
                gameState.bossSource = 'duty';
                gameState.lbUses = 0;
                gameState.lbTriggeredThisFight = false;
                gameState.reachedUnder5Percent = false;
                gameState.doubleHpActive = false;
                gameState.tankShieldTurns = 0;
                gameState.hiddenPhoenixLoot = 0; 

                const hpMult = getBossHpMultiplier(boss.rarity);
                const calcHp = Math.round(boss.hp * hpMult);
                
                gameState.savedBossHp = calcHp;
                gameState.maxBossHp = calcHp;
                
                const partyStats = calculatePartyStats(party);
                gameState.savedPartyHp = partyStats.totalHp;

                activeSessions.set(userId, gameState);

                await interaction.channel.send(t(glang, 'sciondex.pub.dutyFinder', { userId, name: boss.name, rarity: boss.rarity })).catch(() => {});

                const embed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.dfTitle'))
                    .setDescription(t(lang, 'sciondex.bossText', { name: boss.name, rarity: boss.rarity, hp: gameState.savedBossHp, mult: Math.round(hpMult), atk: boss.atk, original: boss.hp }))
                    .setColor('#E74C3C')
                    .addFields({ name: t(lang, 'sciondex.totalStatsYour'), value: t(lang, 'sciondex.totalStatsValue', { hp: partyStats.totalHp, atk: partyStats.totalAtk }), inline: false });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_start_fight').setLabel(t(lang, 'sciondex.fight')).setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('btn_leave_duty').setLabel(t(lang, 'sciondex.leave')).setStyle(ButtonStyle.Secondary)
                );

                return { content: null, embeds: [embed], components: [row] };
            }, t(lang, 'sciondex.searchingDf'));
        }

        // --- HIGH-TIER SUMMON ENCOUNTER ---
        if (interaction.customId === 'btn_summon') {
            return await transitionEphemeralFlow(interaction, async () => {
                const party = await getUserParty(userId);
                if (party.length === 0) {
                    return await renderGameWindow(interaction, t(lang, 'sciondex.noNpcs'), null, party);
                }

                const userData = await getUserData(userId);
                if (!userData || Number(userData.shards) < 20) {
                    return await renderGameWindow(interaction, t(lang, 'sciondex.notEnoughShards', { have: userData.shards }), userData, party);
                }

                const gameState = activeSessions.get(userId) || {};
                await pool.execute('UPDATE sciondex_users SET shards = shards - 20 WHERE user_id = ?', [userId]);

                const boss = getRandomSummonNpc();
                gameState.activeBoss = boss;
                gameState.bossSource = 'summon';
                gameState.lbUses = 0;
                gameState.lbTriggeredThisFight = false;
                gameState.reachedUnder5Percent = false;
                gameState.doubleHpActive = false;
                gameState.tankShieldTurns = 0;
                gameState.hiddenPhoenixLoot = 0; 

                const hpMult = getBossHpMultiplier(boss.rarity);
                const calcHp = Math.round(boss.hp * hpMult);

                gameState.savedBossHp = calcHp;
                gameState.maxBossHp = calcHp;

                const partyStats = calculatePartyStats(party);
                gameState.savedPartyHp = partyStats.totalHp;

                activeSessions.set(userId, gameState);

                await interaction.channel.send(t(glang, 'sciondex.pub.summoned', { userId, name: boss.name, rarity: boss.rarity })).catch(() => {});

                const embed = new EmbedBuilder()
                    .setTitle(t(lang, 'sciondex.summonTitle'))
                    .setDescription(t(lang, 'sciondex.bossText', { name: boss.name, rarity: boss.rarity, hp: gameState.savedBossHp, mult: Math.round(hpMult), atk: boss.atk, original: boss.hp }))
                    .setColor('#9B59B6')
                    .addFields({ name: t(lang, 'sciondex.totalStatsYour'), value: t(lang, 'sciondex.totalStatsValue', { hp: partyStats.totalHp, atk: partyStats.totalAtk }), inline: false });

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('btn_start_fight').setLabel(t(lang, 'sciondex.fight')).setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('btn_leave_duty').setLabel(t(lang, 'sciondex.leave')).setStyle(ButtonStyle.Secondary)
                );

                return { content: null, embeds: [embed], components: [row] };
            }, t(lang, 'sciondex.summoning'));
        }

        // --- LEAVE FIGHT ---
        if (interaction.customId === 'btn_leave_duty') {
            return await transitionEphemeralFlow(interaction, async () => {
                const gameState = activeSessions.get(userId) || {};
                const boss = gameState.activeBoss;
                const rarityTag = boss && boss.rarity ? ` [${boss.rarity}★]` : '';
                const bossName = boss ? boss.name : t(lang, 'sciondex.theBoss');
                
                gameState.activeBoss = null;
                activeSessions.set(userId, gameState);

                await interaction.channel.send(t(glang, 'sciondex.pub.ranAway', { userId, boss: bossName, rarity: rarityTag })).catch(() => {});

                return await renderGameWindow(interaction, t(lang, 'sciondex.ranAway', { boss: bossName }));
            }, t(lang, 'sciondex.leaving'));
        }

        // --- COMBAT HANDLER ---
        if (interaction.customId === 'btn_start_fight' || interaction.customId === 'btn_use_phoenix' || interaction.customId === 'btn_execute_lb') {
            return await transitionEphemeralFlow(interaction, async () => {
                const gameState = activeSessions.get(userId) || {};
                const boss = gameState.activeBoss;

                if (!boss) {
                    return await renderGameWindow(interaction, t(lang, 'sciondex.noEncounter'));
                }

                const party = await getUserParty(userId);
                const partyStats = calculatePartyStats(party);
                
                let currentPartyHp = gameState.savedPartyHp || partyStats.totalHp;
                let currentBossHp = gameState.savedBossHp;
                const maxBossHp = gameState.maxBossHp || currentBossHp;

                if (interaction.customId === 'btn_use_phoenix') {
                    await pool.execute(
                        `UPDATE sciondex_users 
                         SET phoenix_downs = GREATEST(0, COALESCE(phoenix_downs, 0) - 1) 
                         WHERE user_id = ?`,
                        [userId]
                    );
                    
                    if (Math.random() <= 0.50) {
                        gameState.hiddenPhoenixLoot = (gameState.hiddenPhoenixLoot || 0) + 1;
                    }

                    currentPartyHp = partyStats.totalHp; 
                    gameState.doubleHpActive = false;    
                    gameState.tankShieldTurns = 0;
                    
                    await interaction.channel.send(t(glang, 'sciondex.pub.phoenix', { userId })).catch(() => {});
                }

                if (interaction.customId === 'btn_execute_lb') {
                    if ((gameState.lbUses || 0) < 4) {
                        gameState.lbUses = (gameState.lbUses || 0) + 1;
                        
                        for (const member of party) {
                            if (member && member.additional_effect && Math.random() <= 0.40) {
                                const hiddenDamage = Math.round(maxBossHp * 0.08);
                                currentBossHp -= hiddenDamage;

                                await interaction.channel.send(t(glang, 'sciondex.pub.ability', { userId, name: member.name, effect: member.additional_effect })).catch(() => {});
                            }
                        }

                        if (currentBossHp <= 0) {
                            return await getBossVictoryPayload(interaction, gameState, userId, true);
                        }

                        const lbRoll = Math.random() * 100;

                        if (lbRoll < 10) { 
                            const meleeNames = ['Final Heaven', 'Dragonsong Dive', 'Chimatsuri', 'Doom of the Living', 'The End', 'World-swallower'];
                            const chosenSkill = getRandomArrayItem(meleeNames);
                            
                            await interaction.channel.send(t(glang, 'sciondex.pub.meleeLb', { userId, skill: chosenSkill, boss: boss.name })).catch(() => {});
                            return await getBossVictoryPayload(interaction, gameState, userId, true);
                        } else if (lbRoll < 50) { 
                            const lbDamage = partyStats.totalAtk * 50;
                            currentBossHp -= lbDamage;

                            await interaction.channel.send(t(glang, 'sciondex.pub.lb1', { userId, boss: boss.name, damage: lbDamage })).catch(() => {});

                            if (currentBossHp <= 0) {
                                return await getBossVictoryPayload(interaction, gameState, userId, true);
                            }
                        } else if (lbRoll < 75) { 
                            const isRange = Math.random() < 0.50;
                            const lbDamage = partyStats.totalAtk * 250;
                            currentBossHp -= lbDamage;

                            if (isRange) {
                                const rangeNames = ['Sagittarius Arrow', 'Satellite Beam', 'Crimson Lotus'];
                                const chosenSkill = getRandomArrayItem(rangeNames);
                                await interaction.channel.send(t(glang, 'sciondex.pub.rangeLb', { userId, skill: chosenSkill, boss: boss.name, damage: lbDamage })).catch(() => {});
                            } else {
                                const casterNames = ['Meteor', 'Teraflare', 'Vermillion Scourge', 'Chromatic Fantasy'];
                                const chosenSkill = getRandomArrayItem(casterNames);
                                await interaction.channel.send(t(glang, 'sciondex.pub.casterLb', { userId, skill: chosenSkill, boss: boss.name, damage: lbDamage })).catch(() => {});
                            }

                            if (currentBossHp <= 0) {
                                return await getBossVictoryPayload(interaction, gameState, userId, true);
                            }
                        } else { 
                            const subRoll = Math.random();

                            if (subRoll < (1 / 3)) {
                                const healerNames = ['Pulse of Life', 'Angel Feathers', 'Astral Stasis', 'Techne Makre'];
                                const chosenSkill = getRandomArrayItem(healerNames);

                                currentPartyHp = partyStats.totalHp * 2;
                                gameState.doubleHpActive = true;

                                await interaction.channel.send(t(glang, 'sciondex.pub.healerLb', { userId, skill: chosenSkill })).catch(() => {});
                            } else if (subRoll < (2 / 3)) {
                                const lbDamage = partyStats.totalAtk * 150;
                                currentBossHp -= lbDamage;

                                await interaction.channel.send(t(glang, 'sciondex.pub.lb2', { userId, boss: boss.name, damage: lbDamage })).catch(() => {});

                                if (currentBossHp <= 0) {
                                    return await getBossVictoryPayload(interaction, gameState, userId, true);
                                }
                            } else {
                                const tankNames = ['Land Waker', 'Last Bastion', 'Dark Force', 'Gunmetal Soul'];
                                const chosenSkill = getRandomArrayItem(tankNames);

                                gameState.tankShieldTurns = 30;
                                await interaction.channel.send(t(glang, 'sciondex.pub.tankLb', { userId, skill: chosenSkill })).catch(() => {});
                            }
                        }
                    } else {
                        await interaction.channel.send(t(glang, 'sciondex.pub.maxLb', { userId })).catch(() => {});
                    }
                }

                let limitBreakTriggered = false;
                let partyDied = false;
                const effectiveMaxHp = gameState.doubleHpActive ? (partyStats.totalHp * 2) : partyStats.totalHp;

                for (let turn = 1; turn <= 50; turn++) {
                    if (Math.random() > 0.10) {
                        currentBossHp -= partyStats.totalAtk;
                    }

                    if (currentBossHp <= 0) break;

                    if (Math.random() > 0.10) {
                        if ((gameState.tankShieldTurns || 0) > 0) {
                            gameState.tankShieldTurns -= 1;
                        } else {
                            currentPartyHp -= boss.atk;
                        }
                    }

                    if (currentPartyHp > 0 && currentPartyHp <= effectiveMaxHp * 0.25) {
                        gameState.lbTriggeredThisFight = true;

                        if (currentPartyHp <= effectiveMaxHp * 0.05) {
                            gameState.reachedUnder5Percent = true;
                        }

                        if ((gameState.lbUses || 0) < 4 && Math.random() <= 0.10) {
                            limitBreakTriggered = true;
                            gameState.savedBossHp = currentBossHp;
                            gameState.savedPartyHp = currentPartyHp;
                            break;
                        }
                    }

                    if (currentPartyHp <= 0) {
                        partyDied = true;
                        gameState.savedBossHp = currentBossHp;
                        gameState.savedPartyHp = 0;
                        gameState.doubleHpActive = false;
                        break;
                    }
                }

                gameState.savedPartyHp = currentPartyHp;
                gameState.savedBossHp = currentBossHp;
                activeSessions.set(userId, gameState);

                if (limitBreakTriggered) {
                    const embed = new EmbedBuilder()
                        .setTitle(t(lang, 'sciondex.dangerTitle'))
                        .setDescription(t(lang, 'sciondex.dangerText'))
                        .setColor('#F1C40F');

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('btn_execute_lb').setLabel(t(lang, 'sciondex.lbButton')).setStyle(ButtonStyle.Danger)
                    );

                    return { content: null, embeds: [embed], components: [row] };
                }

                if (partyDied) {
                    gameState.hiddenPhoenixLoot = 0;
                    activeSessions.set(userId, gameState);

                    const latestUserData = await getUserData(userId);
                    const rarityTag = boss.rarity ? ` [${boss.rarity}★]` : '';
                    const remainingHpPercent = Math.max(0, Math.round((gameState.savedBossHp / maxBossHp) * 100));

                    if (latestUserData && Number(latestUserData.phoenix_downs) > 0) {
                        const embed = new EmbedBuilder()
                            .setTitle(t(lang, 'sciondex.wipedTitle'))
                            .setDescription(t(lang, 'sciondex.wipedText', { boss: boss.name, rarity: rarityTag, hp: gameState.savedBossHp, percent: remainingHpPercent, phoenix: latestUserData.phoenix_downs }))
                            .setColor('#C0392B');

                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId('btn_use_phoenix').setLabel(t(lang, 'sciondex.usePhoenix')).setStyle(ButtonStyle.Danger),
                            new ButtonBuilder().setCustomId('btn_give_up').setLabel(t(lang, 'sciondex.giveUp')).setStyle(ButtonStyle.Secondary)
                        );

                        return { content: null, embeds: [embed], components: [row] };
                    } else {
                        gameState.activeBoss = null;
                        activeSessions.set(userId, gameState);

                        await interaction.channel.send(t(glang, 'sciondex.pub.wiped', { userId, boss: boss.name, rarity: rarityTag })).catch(() => {});
                        return await renderGameWindow(interaction, t(lang, 'sciondex.wiped', { boss: boss.name, rarity: rarityTag }));
                    }
                }

                return await getBossVictoryPayload(interaction, gameState, userId, true);
            }, t(lang, 'sciondex.processingCombat'));
        }

        // --- GIVE UP ---
        if (interaction.customId === 'btn_give_up') {
            return await transitionEphemeralFlow(interaction, async () => {
                const gameState = activeSessions.get(userId) || {};
                const boss = gameState.activeBoss;
                const bossName = boss ? boss.name : t(lang, 'sciondex.theBoss');

                gameState.hiddenPhoenixLoot = 0;
                gameState.activeBoss = null;
                activeSessions.set(userId, gameState);

                return await renderGameWindow(interaction, t(lang, 'sciondex.gaveUp', { boss: bossName }));
            }, t(lang, 'sciondex.givingUp'));
        }

        // --- GET SHARDS ---
        if (interaction.customId.startsWith('btn_get_shards_')) {
            return await transitionEphemeralFlow(interaction, async () => {
                const shardsEarned = parseInt(interaction.customId.split('_')[3], 10);

                await pool.execute('UPDATE sciondex_users SET shards = shards + ? WHERE user_id = ?', [shardsEarned, userId]);

                const gameState = activeSessions.get(userId) || {};
                const targetNpc = gameState.pendingNpcToReplace || gameState.activeBoss;
                
                gameState.pendingNpcToReplace = null;
                gameState.activeBoss = null;
                activeSessions.set(userId, gameState);

                const npcName = targetNpc ? targetNpc.name : t(lang, 'sciondex.encounter');
                return await renderGameWindow(interaction, t(lang, 'sciondex.claimed', { shards: shardsEarned, name: npcName }));
            }, t(lang, 'sciondex.claiming'));
        }
    } catch (err) {
        console.error('❌ Error handling ScionDex button interaction:', err);
    }
};

// ==========================================
// --- VICTORY HELPER ---
// ==========================================

async function getBossVictoryPayload(interaction, gameState, userId, isFirstVictoryRoll = true) {
    const lang = await userLanguage.forInteraction(interaction);
    const glang = userLanguage.forGuild(interaction.guild);
    const boss = gameState.activeBoss;
    let starsDropped = 0;
    let shardsDropped = 0;
    let totalRawPhoenixDrops = 0;
    let actualAcquiredPhoenix = 0;
    let currentHeld = 0;

    if (isFirstVictoryRoll) {
        let droppedPhoenix = 0;
        if (Math.random() <= 0.90) droppedPhoenix += 1;
        if (Math.random() <= 0.40) droppedPhoenix += 1;
        if (Math.random() <= 0.15) droppedPhoenix += 1;

        const hiddenLootAcquired = gameState.hiddenPhoenixLoot || 0;
        totalRawPhoenixDrops = droppedPhoenix + hiddenLootAcquired;

        const mobLoot = calculateMobLootDrops(boss.rarity);
        starsDropped = mobLoot.starsDropped;
        shardsDropped = mobLoot.shardsDropped;

        await pool.execute(
            `UPDATE sciondex_users 
             SET stars = COALESCE(stars, 0) + ?, 
                 shards = COALESCE(shards, 0) + ? 
             WHERE user_id = ?`,
            [starsDropped, shardsDropped, String(userId)]
        );

        const userData = await getUserData(userId);
        currentHeld = userData && userData.phoenix_downs !== null ? Number(userData.phoenix_downs) : 0;
        const availableSpace = Math.max(0, 10 - currentHeld);
        actualAcquiredPhoenix = Math.min(totalRawPhoenixDrops, availableSpace);

        if (actualAcquiredPhoenix > 0) {
            await pool.execute(
                `UPDATE sciondex_users 
                 SET phoenix_downs = LEAST(10, COALESCE(phoenix_downs, 0) + ?) 
                 WHERE user_id = ?`,
                [actualAcquiredPhoenix, String(userId)]
            );
        }

        gameState.hiddenPhoenixLoot = 0;
        gameState.lastDroppedStars = starsDropped;
        gameState.lastDroppedShards = shardsDropped;
        gameState.lastPhoenixDrops = totalRawPhoenixDrops;
        gameState.lastAcquiredPhoenix = actualAcquiredPhoenix;
        gameState.lastBonusRate = rollRecruitmentBonus();

        await interaction.channel.send(t(glang, 'sciondex.pub.defeated', { userId, name: boss.name, rarity: boss.rarity })).catch(() => {});
    } else {
        starsDropped = gameState.lastDroppedStars || 0;
        shardsDropped = gameState.lastDroppedShards || 0;
        totalRawPhoenixDrops = gameState.lastPhoenixDrops || 0;
        actualAcquiredPhoenix = gameState.lastAcquiredPhoenix || 0;
    }

    const userData = await getUserData(userId);
    currentHeld = userData && userData.phoenix_downs !== null ? Number(userData.phoenix_downs) : 0;
    const userStars = userData && userData.stars !== null ? Number(userData.stars) : 0;

    let phoenixMessage = '';
    if (totalRawPhoenixDrops === 0) {
        phoenixMessage = t(lang, 'sciondex.phoenixNone');
    } else if (currentHeld >= 10 && isFirstVictoryRoll) {
        phoenixMessage = t(lang, 'sciondex.phoenixFull', { n: totalRawPhoenixDrops });
    } else if (actualAcquiredPhoenix < totalRawPhoenixDrops && isFirstVictoryRoll) {
        phoenixMessage = t(lang, 'sciondex.phoenixCapped', { n: totalRawPhoenixDrops, got: actualAcquiredPhoenix });
    } else {
        phoenixMessage = t(lang, 'sciondex.phoenixGot', { got: actualAcquiredPhoenix });
    }

    const bonusRate = gameState.lastBonusRate || 0;
    const baseChance = getBaseRecruitChance(boss.rarity, gameState.bossSource);
    const currentTotalChance = Math.min(1.0, baseChance + bonusRate);
    const baseChancePercent = Math.min(100, Math.round(currentTotalChance * 100));

    const neededStarsForMax = Math.max(0, 100 - baseChancePercent);

    let starsToUse = 0;
    let boostFinalPercent = baseChancePercent;

    if (userStars > 0 && neededStarsForMax > 0) {
        starsToUse = Math.min(userStars, neededStarsForMax);
        boostFinalPercent = Math.min(100, baseChancePercent + starsToUse);
    }

    const shardReward = Number(boss.rarity);

    const embed = new EmbedBuilder()
        .setTitle(t(lang, 'sciondex.victoryTitle', { name: boss.name }))
        .setDescription(
            t(lang, 'sciondex.victoryText', { stars: userStars, name: boss.name, rarity: boss.rarity, hp: boss.hp, atk: boss.atk, title: boss.title || t(lang, 'sciondex.none'), expansion: boss.expansion || t(lang, 'sciondex.unknown'), phoenix: phoenixMessage, shards: shardsDropped, starsDropped, chance: baseChancePercent, base: Math.round(baseChance * 100), bonus: Math.round(bonusRate * 100) })
        )
        .setColor('#2ECC71');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('btn_replace_prompt')
            .setLabel(t(lang, 'sciondex.recruitChance', { chance: baseChancePercent }))
            .setStyle(ButtonStyle.Success)
    );

    if (starsToUse > 0) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`btn_use_stars_${starsToUse}_${(boostFinalPercent / 100).toFixed(2)}`)
                .setLabel(t(lang, 'sciondex.useStars', { stars: starsToUse, chance: boostFinalPercent }))
                .setStyle(ButtonStyle.Primary)
        );
    }

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`btn_get_shards_${shardReward}`)
            .setLabel(t(lang, 'sciondex.getShards', { n: shardReward }))
            .setStyle(ButtonStyle.Secondary)
    );

    return { content: null, embeds: [embed], components: [row] };
}