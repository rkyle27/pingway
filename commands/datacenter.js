const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');

// /datacenter is personal: one setting per user, used in every server
const PERSONAL_DC_KEY = 'personal';
const fs = require('fs');
const path = require('path');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

const DC_JSON_PATH = path.join(__dirname, '..', 'data', 'datacenter.json');

function getDatacenterData() {
    try {
        if (fs.existsSync(DC_JSON_PATH)) {
            const raw = fs.readFileSync(DC_JSON_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.regions) return parsed.regions;
        }
    } catch (e) {
        console.error('Failed to load datacenter.json:', e);
    }
    return {
        "North America (NA)": {
            "Aether": ["Adamantoise", "Cactuar", "Faerie", "Gilgamesh", "Jenova", "Sargatanas", "Siren", "Midgardsormr"]
        }
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('datacenter')
        .setDescription(t('en', 'datacenter.cmd.description')).setDescriptionLocalizations(discordLocalizations('datacenter.cmd.description')),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        const guildId = interaction.guildId;
        const userId = interaction.user.id;

        let userDCs = [];
        try {
            const [rows] = await pool.execute(
                // Personal setting first; otherwise any one older per-server setting
                'SELECT datacenters FROM user_datacenters WHERE user_id = ? ORDER BY (guild_id = ?) DESC LIMIT 1',
                [userId, PERSONAL_DC_KEY]
            );
            if (rows.length > 0 && rows[0].datacenters) {
                userDCs = JSON.parse(rows[0].datacenters);
            }
        } catch (e) {
            console.error('Error fetching datacenters from MySQL:', e);
        }

        const regions = getDatacenterData();
        const options = [];

        for (const [regionName, dcs] of Object.entries(regions)) {
            for (const dcName of Object.keys(dcs)) {
                options.push(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(`${dcName}`)
                        .setValue(dcName)
                        .setDescription(t(lang, 'datacenter.region', { region: regionName }))
                        .setDefault(userDCs.includes(dcName))
                );
            }
        }

        if (options.length === 0) {
            return interaction.reply({
                content: t(lang, 'datacenter.noneConfigured'),
                flags: [MessageFlags.Ephemeral]
            });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('dc_select_menu')
            .setPlaceholder(t(lang, 'datacenter.placeholder'))
            .setMinValues(1)
            .setMaxValues(Math.min(options.length, 25))
            .addOptions(options);

        const selectRow = new ActionRowBuilder().addComponents(selectMenu);

        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('dc_btn_done')
                .setLabel(t(lang, 'datacenter.done'))
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('dc_btn_clear')
                .setLabel(t(lang, 'datacenter.clear'))
                .setStyle(ButtonStyle.Danger)
        );

        return interaction.reply({
            content: t(lang, 'datacenter.intro'),
            components: [selectRow, buttonRow],
            flags: [MessageFlags.Ephemeral]
        });
    },

    async handleInteraction(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        const guildId = interaction.guildId;
        const userId = interaction.user.id;

        if (interaction.isStringSelectMenu() && interaction.customId === 'dc_select_menu') {
            const selectedDCs = interaction.values;

            try {
                await pool.execute(
                    `INSERT INTO user_datacenters (guild_id, user_id, datacenters) VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE datacenters = VALUES(datacenters)`,
                    [PERSONAL_DC_KEY, userId, JSON.stringify(selectedDCs)]
                );

                return interaction.update({
                    content: t(lang, 'datacenter.updated', { list: selectedDCs.join(', ') }),
                    components: interaction.message.components
                });
            } catch (error) {
                console.error('Error saving datacenters to MySQL:', error);
                return interaction.reply({
                    content: t(lang, 'datacenter.saveFailed'),
                    flags: [MessageFlags.Ephemeral]
                });
            }
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'dc_btn_done') {
                await interaction.deferUpdate().catch(() => {});
                return interaction.deleteReply().catch(() => {});
            } 
            
            if (interaction.customId === 'dc_btn_clear') {
                try {
                    await pool.execute(
                        // Save an empty personal list (no deletes; old per-server rows are ignored from now on)
                        "INSERT INTO user_datacenters (guild_id, user_id, datacenters) VALUES (?, ?, '[]') ON DUPLICATE KEY UPDATE datacenters = '[]'",
                        [PERSONAL_DC_KEY, userId]
                    );

                    return interaction.update({
                        content: t(lang, 'datacenter.cleared'),
                        components: []
                    });
                } catch (error) {
                    console.error('Error clearing datacenters from MySQL:', error);
                    return interaction.reply({
                        content: t(lang, 'datacenter.clearFailed'),
                        flags: [MessageFlags.Ephemeral]
                    });
                }
            }
        }
    }
};