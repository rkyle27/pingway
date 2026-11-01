const { 
    SlashCommandBuilder, 
    MessageFlags, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} = require('discord.js');
const { pool } = require('../utils/db');
const { isMaintenance } = require('../maintenance');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Load Data Centers and Worlds directly from data/datacenter.json
let DATA_CENTERS = {};
let REGIONS_DATA = {};

try {
    const jsonPath = path.join(__dirname, '../data/datacenter.json');
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(rawData);
    
    if (parsed && parsed.regions) {
        REGIONS_DATA = parsed.regions;
        for (const regionName of Object.keys(REGIONS_DATA)) {
            const dcs = REGIONS_DATA[regionName];
            for (const dcName of Object.keys(dcs)) {
                DATA_CENTERS[dcName] = dcs[dcName];
            }
        }
    }
} catch (e) {
    console.error('Failed to load data/datacenter.json:', e.message);
}

async function fetchWorldStatuses() {
    try {
        const response = await axios.get('https://is.xivup.com/v2indexdata', {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json'
            },
            timeout: 6000
        });

        const data = response.data;
        const statuses = {};

        const regionMapping = {
            "North America (NA)": data.NARegion,
            "Europe (EU)": data.EURegion,
            "Oceania (OCE)": data.AURegion,
            "Japan (JP)": data.JPRegion
        };

        for (const [regionName, regionData] of Object.entries(REGIONS_DATA)) {
            const apiRegionObj = regionMapping[regionName];
            if (!apiRegionObj || !apiRegionObj.DCs) continue;

            for (const [dcName, worldsList] of Object.entries(regionData)) {
                const apiDc = apiRegionObj.DCs.find(d => (d.Name || '').toLowerCase() === dcName.toLowerCase());
                if (!apiDc || !apiDc.Servers) continue;

                for (const targetWorld of worldsList) {
                    const apiServer = apiDc.Servers.find(s => (s.Name || '').toLowerCase() === targetWorld.toLowerCase());
                    if (apiServer) {
                        const isUp = apiServer.Status === 4;
                        statuses[targetWorld] = isUp ? 'UP' : 'DOWN';
                    }
                }
            }
        }

        return { statuses, isFallback: false };
    } catch (e) {
        console.error('Failed to fetch from v2indexdata:', e.message);
        return { statuses: {}, isFallback: true };
    }
}

function getStatusDisplay(worldStatus) {
    if (worldStatus === 'UP') return { icon: '🟢', text: 'Online' };
    if (worldStatus === 'DOWN') return { icon: '🔧', text: 'Offline / Maintenance' };
    return { icon: '➖', text: 'No Data' };
}

async function getSubscription(userId) {
    const [rows] = await pool.execute('SELECT * FROM user_server_subscriptions WHERE user_id = ?', [userId]);
    return rows.length > 0 ? rows[0] : null;
}

function findDcForWorld(world) {
    for (const dc of Object.keys(DATA_CENTERS)) {
        if ((DATA_CENTERS[dc] || []).includes(world)) return dc;
    }
    return null;
}

// The Data Center currently being viewed = the selected option in the message's DC dropdown
function getViewedDc(interaction) {
    const rows = interaction.message && interaction.message.components ? interaction.message.components : [];
    for (const row of rows) {
        for (const comp of row.components || []) {
            if (comp.customId === 'status_select_dc') {
                const selected = (comp.options || []).find(o => o.default);
                if (selected) return selected.value;
            }
        }
    }
    return null;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('status')
        .setDescription('🔍 Check FFXIV server status and toggle alert notifications.'),

    async execute(interaction) {
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!',
                flags: [MessageFlags.Ephemeral]
            });
        }

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        // Open straight on the user's saved Data Center (nothing is saved until they pick a world)
        const payload = await getDashboardPayload(interaction.user.id, null);
        return interaction.editReply(payload);
    },

    async handleButton(interaction) {
        if (interaction.customId === 'status_exit') {
            await interaction.deferUpdate().catch(() => {});
            return interaction.deleteReply().catch(() => {});
        }

        if (interaction.customId === 'status_toggle_notif') {
            await interaction.deferUpdate();
            const userId = interaction.user.id;
            const sub = await getSubscription(userId);

            if (!sub || !sub.world) {
                return interaction.followUp({
                    content: '⚠️ Please select a World to track first before enabling notifications!',
                    flags: [MessageFlags.Ephemeral]
                });
            }

            const newState = !Boolean(sub.notifications_enabled);
            await pool.execute('UPDATE user_server_subscriptions SET notifications_enabled = ? WHERE user_id = ?', [newState ? 1 : 0, userId]);

            const payload = await getDashboardPayload(userId, getViewedDc(interaction));
            return interaction.editReply(payload);
        }
    },

    async handleSelect(interaction) {
        await interaction.deferUpdate();
        const userId = interaction.user.id;

        // Picking a Data Center only changes what is shown. The tracked world is NOT changed.
        if (interaction.customId === 'status_select_dc') {
            const payload = await getDashboardPayload(userId, interaction.values[0]);
            return interaction.editReply(payload);
        }

        // Picking a World saves it as the tracked world
        if (interaction.customId === 'status_select_world') {
            const selectedWorld = interaction.values[0];
            const dc = findDcForWorld(selectedWorld) || getViewedDc(interaction) || Object.keys(DATA_CENTERS)[0];
            const sub = await getSubscription(userId);

            if (sub) {
                await pool.execute('UPDATE user_server_subscriptions SET datacenter = ?, world = ? WHERE user_id = ?', [dc, selectedWorld, userId]);
            } else {
                // New users start with DM alerts OFF
                await pool.execute(
                    'INSERT INTO user_server_subscriptions (user_id, datacenter, world, notifications_enabled) VALUES (?, ?, ?, 0)',
                    [userId, dc, selectedWorld]
                );
            }

            const payload = await getDashboardPayload(userId, dc);
            return interaction.editReply(payload);
        }
    }
};

async function getDashboardPayload(userId, viewDc) {
    const sub = await getSubscription(userId);
    const trackedWorld = sub && sub.world ? sub.world : null;
    const trackedDc = trackedWorld ? (findDcForWorld(trackedWorld) || sub.datacenter) : null;
    const notifEnabled = sub ? Boolean(sub.notifications_enabled) : false;

    const dcKeys = Object.keys(DATA_CENTERS);
    let activeDc = viewDc && DATA_CENTERS[viewDc] ? viewDc : null;
    if (!activeDc) activeDc = trackedDc && DATA_CENTERS[trackedDc] ? trackedDc : dcKeys[0];
    const worlds = DATA_CENTERS[activeDc] || [];

    const { statuses, isFallback } = await fetchWorldStatuses();

    let description = '### 🌍 FFXIV Status: **' + activeDc + '** Data Center\n';

    if (isFallback) {
        description += '⚠️ **Warning:** Could not retrieve live data from xivup API. Statuses shown as no data (-).\n';
    }

    if (trackedWorld) {
        description += 'Selected World Tracking: **' + trackedWorld + '** (DM Alerts: **' + (notifEnabled ? 'Enabled' : 'Disabled') + '**)\n';
        // Tracked world is on another Data Center: still show its status
        if (!worlds.includes(trackedWorld)) {
            const tracked = getStatusDisplay(statuses[trackedWorld]);
            description += tracked.icon + ' **' + trackedWorld + '** (' + trackedDc + ') — *' + tracked.text + '*\n';
        }
    } else {
        description += 'Selected World Tracking: **None** — pick a World below to track it.\n';
    }
    description += '\n';

    for (const w of worlds) {
        const display = getStatusDisplay(statuses[w]);
        description += display.icon + ' **' + w + '** — *' + display.text + '*\n';
    }

    const dcRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('status_select_dc')
            .setPlaceholder('Switch Data Center')
            .addOptions(
                dcKeys.slice(0, 25).map(dc => ({
                    label: dc,
                    value: dc,
                    default: dc === activeDc
                }))
            )
    );

    const worldRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('status_select_world')
            .setPlaceholder('Select World to Track')
            .addOptions(worlds.slice(0, 25).map(w => ({ label: w, value: w, default: w === trackedWorld })))
    );

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('status_toggle_notif')
            .setLabel(notifEnabled ? '🔕 Disable DM Alerts' : '🔔 Enable DM Alerts')
            .setStyle(notifEnabled ? ButtonStyle.Danger : ButtonStyle.Success)
            .setDisabled(!trackedWorld),
        new ButtonBuilder()
            .setCustomId('status_exit')
            .setLabel('Exit')
            .setStyle(ButtonStyle.Secondary)
    );

    return {
        content: description,
        components: [dcRow, worldRow, buttonRow]
    };
}
