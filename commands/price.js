const { SlashCommandBuilder, EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const { pool } = require('../utils/db');
const { t, discordLocalizations, localeOf } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

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

// Item search and names use the reader's language (XIVAPI: en, fr, de, ja); a search with no result
// in that language is tried again in English.
const langParam = lang => (lang && lang !== 'en' ? '&language=' + lang : '');
const num = (n, lang) => n.toLocaleString(lang === 'en' ? undefined : localeOf(lang));

async function handlePriceLookup(interaction, itemName, isFollowUp = false, lang = 'en') {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    // --- STEP 1: Check saved DCs FIRST ---
    const userDCs = await getUserDCs(guildId, userId);

    if (!userDCs || userDCs.length === 0) {
        const replyPayload = {
            content: t(lang, 'price.noDcs'),
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

        for (const searchLang of [...new Set([lang, 'en'])]) {
        if (searchResults.length) break;
        // ISSUE 3 FIX: Safe API calls with .catch(() => null)
        if (words.length > 1) {
            const multiQuery = words.map(w => `Name~"${encodeURIComponent(w)}"`).join('&');
            const multiSearchUrl = `https://v2.xivapi.com/api/search?sheets=Item&query=${multiQuery}` + langParam(searchLang);
            const multiResponse = await axios.get(multiSearchUrl).catch(() => null);
            if (multiResponse?.data?.results?.length) {
                searchResults = multiResponse.data.results;
            }
        }

        if (searchResults.length === 0) {
            const fallbackQuery = words.length > 0 ? words[0] : cleanInput;
            const searchUrl = `https://v2.xivapi.com/api/search?sheets=Item&query=Name~"${encodeURIComponent(fallbackQuery)}"` + langParam(searchLang);
            const searchResponse = await axios.get(searchUrl).catch(() => null);
            if (searchResponse?.data?.results?.length) {
                searchResults = searchResponse.data.results;
            }
        }
        }

        if (searchResults.length === 0) {
            return interaction.editReply({
                content: t(lang, 'price.notFound', { item: itemName }),
                embeds: [],
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('price_recommendation_close')
                            .setLabel(t(lang, 'price.close'))
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
                content: t(lang, 'price.lookingUp', { name: exactMatch.fields?.Name }),
                embeds: [],
                components: []
            });
            return await fetchAndDisplayPrices(interaction, exactMatch.row_id, lang);
        }

        // Fallback to recommendation list if no exact match
        const results = searchResults.slice(0, 10);
        const embed = new EmbedBuilder()
            .setTitle(t(lang, 'price.recommendations'))
            .setDescription(t(lang, 'price.didYouMean', { item: itemName }))
            .setColor('#ff9900');

        let listContent = '';
        const buttonsRow1 = new ActionRowBuilder();
        const buttonsRow2 = new ActionRowBuilder();
        const closeRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('price_recommendation_close')
                .setLabel(t(lang, 'price.close'))
                .setStyle(ButtonStyle.Danger)
        );

        results.forEach((res, index) => {
            const matchedName = res.fields?.Name || t(lang, 'price.unknownItem');
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

        embed.addFields({ name: t(lang, 'price.matching'), value: listContent });

        const components = [];
        if (buttonsRow1.components.length > 0) components.push(buttonsRow1);
        if (buttonsRow2.components.length > 0) components.push(buttonsRow2);
        components.push(closeRow);

        return interaction.editReply({
            content: t(lang, 'price.didYouMean', { item: itemName }),
            embeds: [embed],
            components: components
        });

    } catch (error) {
        console.error('Price command error:', error);
        await interaction.editReply({ content: t(lang, 'price.error'), embeds: [], components: [] });
    }
}

async function fetchAndDisplayPrices(interaction, itemId, lang = 'en') {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const userDCs = await getUserDCs(guildId, userId);

    if (!userDCs || userDCs.length === 0) {
        return interaction.editReply({
            content: t(lang, 'price.noDcsShort'),
            embeds: [],
            components: []
        });
    }

    try {
        const itemUrl = `https://v2.xivapi.com/api/sheet/Item/${itemId}` + (lang !== 'en' ? '?language=' + lang : '');
        const itemResponse = await axios.get(itemUrl, { timeout: 5000 }).catch(() => null);
        const correctItemName = itemResponse?.data?.fields?.Name || t(lang, 'price.unknownItem');

        const embed = new EmbedBuilder()
            .setTitle(t(lang, 'price.title', { name: correctItemName }))
            .setURL(`https://universalis.app/market/${itemId}`)
            .setDescription(t(lang, 'price.legend', { nq: EMOJIS.NQ, hq: EMOJIS.HQ }))
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
                        dcContent += t(lang, 'price.top5', { icon: EMOJIS.NQ });
                        top5NQ.forEach(item => {
                            dcContent += `• ${num(item.pricePerUnit, lang)} ${EMOJIS.GIL} - *${item.worldName}*\n`;
                        });
                    }
                    if (top5HQ.length > 0) {
                        dcContent += t(lang, 'price.top5', { icon: EMOJIS.HQ });
                        top5HQ.forEach(item => {
                            dcContent += `• ${num(item.pricePerUnit, lang)} ${EMOJIS.GIL} - *${item.worldName}*\n`;
                        });
                    }
                } else {
                    dcContent = t(lang, 'price.noListings');
                }

                return {
                    name: `${EMOJIS.GLOBE} ${dc}`,
                    value: dcContent.substring(0, 1024),
                    inline: true
                };
            } catch {
                return {
                    name: `${EMOJIS.GLOBE} ${dc}`,
                    value: t(lang, 'price.fetchFailed'),
                    inline: true
                };
            }
        });

        const fields = await Promise.all(dcPromises);
        embed.addFields(fields);

        // Subtext Footer Credit
        embed.setFooter({ 
            text: t(lang, 'price.footer') 
        });

        const reminderText = t(lang, 'price.reminder');

        await interaction.editReply({
            content: reminderText,
            embeds: [embed],
            components: []
        });
    } catch (error) {
        console.error('Fetch prices error:', error);
        await interaction.editReply({ content: t(lang, 'price.error'), embeds: [], components: [] });
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('price')
        .setDescription(t('en', 'price.cmd.description')).setDescriptionLocalizations(discordLocalizations('price.cmd.description'))
        .addStringOption(option =>
            option.setName('item')
                .setDescription(t('en', 'price.cmd.item')).setDescriptionLocalizations(discordLocalizations('price.cmd.item'))
                .setRequired(true)
        ),
    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        if (interaction.isChatInputCommand() && interaction.commandName === 'price') {
            const itemName = interaction.options.getString('item');
            await handlePriceLookup(interaction, itemName, false, lang);
        } else if (interaction.isButton()) {
            if (interaction.customId === 'price_recommendation_close') {
                return interaction.deleteReply().catch(() => {});
            } else if (interaction.customId.startsWith('price_select_')) {
                // Immediate feedback when a user clicks a button
                await interaction.update({
                    content: t(lang, 'price.fetching'),
                    embeds: [],
                    components: []
                });
                
                const itemId = interaction.customId.split('_')[2];
                await fetchAndDisplayPrices(interaction, itemId, lang);
            }
        }
    }
};