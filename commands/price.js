const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const { pool } = require('../utils/db');

const EMOJIS = {
    NQ: '<:NQ:1530597057327399012>',
    HQ: '<:HQ:1530597058661318769>',
    GIL: '<:Gil:1530596982320660500>',
    GLOBE: '🌐'
};

async function getUserDCs(guildId, userId) {
    try {
        const [rows] = await pool.execute(
            // /datacenter is personal: personal setting first, otherwise any one older per-server setting
            'SELECT datacenters FROM user_datacenters WHERE user_id = ? ORDER BY (guild_id = ?) DESC LIMIT 1',
            [userId, 'personal']
        );
        if (rows.length > 0 && rows[0].datacenters) {
            return JSON.parse(rows[0].datacenters);
        }
    } catch (e) {
        console.error('Error fetching user DCs from DB:', e);
    }
    return [];
}

async function handlePriceLookup(interaction, itemName, isFollowUp = false) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    // --- STEP 1: Check saved DCs FIRST ---
    const userDCs = await getUserDCs(guildId, userId);

    if (!userDCs || userDCs.length === 0) {
        const replyPayload = {
            content: '⚠️ **No Data Centers Selected!**\nPlease use the `/datacenter` command first to set your preferred Data Centers.',
            flags: [MessageFlags.Ephemeral]
        };
        if (isFollowUp) return interaction.update(replyPayload);
        return interaction.reply(replyPayload);
    }

    if (!isFollowUp) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    } else {
        await interaction.deferUpdate();
    }

    try {
        const cleanInput = itemName.trim();
        const words = cleanInput.split(/\s+/).filter(Boolean);

        let searchResults = [];

        // ISSUE 3 FIX: Safe API calls with .catch(() => null)
        if (words.length > 1) {
            const multiQuery = words.map(w => `Name~"${encodeURIComponent(w)}"`).join('&');
            const multiSearchUrl = `https://v2.xivapi.com/api/search?sheets=Item&query=${multiQuery}`;
            const multiResponse = await axios.get(multiSearchUrl).catch(() => null);
            if (multiResponse?.data?.results?.length) {
                searchResults = multiResponse.data.results;
            }
        }

        if (searchResults.length === 0) {
            const fallbackQuery = words.length > 0 ? words[0] : cleanInput;
            const searchUrl = `https://v2.xivapi.com/api/search?sheets=Item&query=Name~"${encodeURIComponent(fallbackQuery)}"`;
            const searchResponse = await axios.get(searchUrl).catch(() => null);
            if (searchResponse?.data?.results?.length) {
                searchResults = searchResponse.data.results;
            }
        }

        if (searchResults.length === 0) {
            return interaction.editReply({
                content: `No item name found using **${itemName}**.`,
                embeds: [],
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('price_recommendation_close')
                            .setLabel('Close')
                            .setStyle(ButtonStyle.Danger)
                    )
                ]
            });
        }

        // ISSUE 1 FIX: Check if an exact match exists
        const exactMatch = searchResults.find(
            res => res.fields?.Name?.toLowerCase() === cleanInput.toLowerCase()
        );

        if (exactMatch) {
            // Immediate feedback before fetching market data
            await interaction.editReply({
                content: `🔍 **Looking up prices for ${exactMatch.fields?.Name}... Please wait!**`,
                embeds: [],
                components: []
            });
            return await fetchAndDisplayPrices(interaction, exactMatch.row_id);
        }

        // Fallback to recommendation list if no exact match
        const results = searchResults.slice(0, 10);
        const embed = new EmbedBuilder()
            .setTitle('Item Recommendations')
            .setDescription(`No item name found using **${itemName}**. Do you mean:`)
            .setColor('#ff9900');

        let listContent = '';
        const buttonsRow1 = new ActionRowBuilder();
        const buttonsRow2 = new ActionRowBuilder();
        const closeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('price_recommendation_close')
                .setLabel('Close')
                .setStyle(ButtonStyle.Danger)
        );

        results.forEach((res, index) => {
            const matchedName = res.fields?.Name || 'Unknown Item';
            listContent += `**${index + 1}.** ${matchedName}\n`;

            const button = new ButtonBuilder()
                .setCustomId(`price_select_${res.row_id}`)
                .setLabel(`${index + 1}`)
                .setStyle(ButtonStyle.Secondary);

            if (index < 5) {
                buttonsRow1.addComponents(button);
            } else {
                buttonsRow2.addComponents(button);
            }
        });

        embed.addFields({ name: 'Matching Items', value: listContent });

        const components = [];
        if (buttonsRow1.components.length > 0) components.push(buttonsRow1);
        if (buttonsRow2.components.length > 0) components.push(buttonsRow2);
        components.push(closeRow);

        return interaction.editReply({
            content: `No item name found using **${itemName}**. Do you mean:`,
            embeds: [embed],
            components: components
        });

    } catch (error) {
        console.error('Price command error:', error);
        await interaction.editReply({ content: 'An error occurred during market lookup.', embeds: [], components: [] });
    }
}

async function fetchAndDisplayPrices(interaction, itemId) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const userDCs = await getUserDCs(guildId, userId);

    if (!userDCs || userDCs.length === 0) {
        return interaction.editReply({
            content: '⚠️ **No Data Centers Selected!**\nPlease use the `/datacenter` command first.',
            embeds: [],
            components: []
        });
    }

    try {
        const itemUrl = `https://v2.xivapi.com/api/sheet/Item/${itemId}`;
        const itemResponse = await axios.get(itemUrl, { timeout: 5000 }).catch(() => null);
        const correctItemName = itemResponse?.data?.fields?.Name || 'Unknown Item';

        const embed = new EmbedBuilder()
            .setTitle(`Market Prices: ${correctItemName}`)
            .setURL(`https://universalis.app/market/${itemId}`)
            .setDescription(`${EMOJIS.NQ} = Normal Quality | ${EMOJIS.HQ} = High Quality`)
            .setColor('#ff9900');

        // ISSUE 2 FIX: Query all user Data Centers concurrently via Promise.all
        const dcPromises = userDCs.map(async (dc) => {
            try {
                const priceResponse = await axios.get(`https://universalis.app/api/v2/${dc}/${itemId}`, {
                    params: { listings: 100 },
                    timeout: 5000
                });
                const listings = priceResponse.data?.listings || [];

                let dcContent = '';
                if (listings.length > 0) {
                    const top5NQ = listings.filter(item => !item.hq).slice(0, 5);
                    const top5HQ = listings.filter(item => item.hq).slice(0, 5);

                    if (top5NQ.length > 0) {
                        dcContent += `**${EMOJIS.NQ} Top 5:**\n`;
                        top5NQ.forEach(item => {
                            dcContent += `• ${item.pricePerUnit.toLocaleString()} ${EMOJIS.GIL} - *${item.worldName}*\n`;
                        });
                    }
                    if (top5HQ.length > 0) {
                        dcContent += `**${EMOJIS.HQ} Top 5:**\n`;
                        top5HQ.forEach(item => {
                            dcContent += `• ${item.pricePerUnit.toLocaleString()} ${EMOJIS.GIL} - *${item.worldName}*\n`;
                        });
                    }
                } else {
                    dcContent = 'No listings found.';
                }

                return {
                    name: `${EMOJIS.GLOBE} ${dc}`,
                    value: dcContent.substring(0, 1024),
                    inline: true
                };
            } catch {
                return {
                    name: `${EMOJIS.GLOBE} ${dc}`,
                    value: 'Failed to fetch data.',
                    inline: true
                };
            }
        });

        const fields = await Promise.all(dcPromises);
        embed.addFields(fields);

        // Subtext Footer Credit
        embed.setFooter({ 
            text: 'Use /datacenter to toggle DCs you want to show on your /price.\nPowered by Universalis & XIVAPI' 
        });

        const reminderText = '🔒 *Only you can see this message! This Message will be gone after sometime had passed. Copy / Take screenshot if you dont wanna loose this listing.*';

        await interaction.editReply({
            content: reminderText,
            embeds: [embed],
            components: []
        });
    } catch (error) {
        console.error('Fetch prices error:', error);
        await interaction.editReply({ content: 'An error occurred during market lookup.', embeds: [], components: [] });
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('price')
        .setDescription('Check market board prices for an FFXIV item')
        .addStringOption(option =>
            option.setName('item')
                .setDescription('The name of the item to search for')
                .setRequired(true)
        ),
    async execute(interaction) {
        if (interaction.isChatInputCommand() && interaction.commandName === 'price') {
            const itemName = interaction.options.getString('item');
            await handlePriceLookup(interaction, itemName, false);
        } else if (interaction.isButton()) {
            if (interaction.customId === 'price_recommendation_close') {
                return interaction.deleteReply().catch(() => {});
            } else if (interaction.customId.startsWith('price_select_')) {
                // Immediate feedback when a user clicks a button
                await interaction.update({
                    content: '⏳ **Fetching prices... Please wait!**',
                    embeds: [],
                    components: []
                });
                
                const itemId = interaction.customId.split('_')[2];
                await fetchAndDisplayPrices(interaction, itemId);
            }
        }
    }
};