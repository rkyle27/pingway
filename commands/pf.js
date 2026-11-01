const {
    SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, StringSelectMenuBuilder, MessageFlags, PermissionFlagsBits
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { toDiscordTimestamp } = require('../utils/hammertime');
const { isMaintenance } = require('../maintenance');

// --- DATABASE POOL (shared with the rest of the bot) ---
const { pool: db } = require('../utils/db');

// --- JOBS.JSON LOADER ---
function loadJobsJSON() {
    try {
        const filePath = path.join(__dirname, '..', 'data', 'jobs.json');
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error("Failed to load jobs.json:", e);
    }
    return { tanks: [], healers: [], dps: [], meleedps: [], physicalrangeddps: [], magicalrangeddps: [], other: [] };
}

// --- PRESET IMAGE LOADER ---
function loadPresetImage(size) {
    try {
        const fileName = size === 4 ? '4.json' : '8.json';
        const filePath = path.join(__dirname, '..', 'data', fileName);
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(raw);
            const urls = Array.isArray(data) ? data : (data.urls || []);
            if (urls.length > 0) {
                const randomIndex = Math.floor(Math.random() * urls.length);
                return urls[randomIndex];
            }
        }
    } catch (e) {
        console.error("Failed to load preset image:", e);
    }
    return null;
}

// --- IMAGE URL VALIDATOR ---
async function isValidImageUrl(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;

        const ext = path.extname(parsed.pathname).toLowerCase();
        const validExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
        if (validExts.includes(ext)) return true;

        const res = await fetch(url, {
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        if (res.ok) {
            const contentType = res.headers.get('content-type');
            if (contentType && contentType.startsWith('image/')) return true;
        }

        if (parsed.hostname.includes('imgur.com') || parsed.hostname.includes('discordapp.com') || parsed.hostname.includes('discord.com')) {
            return true;
        }

        return false;
    } catch (e) {
        return false;
    }
}

async function loadDB() {
    try {
        const [rows] = await db.query('SELECT * FROM party_finders');
        const pfDatabase = rows.map(row => {
            const rawData = row.data ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : {};
            const listing = {
                id: String(rawData.id || row.id),
                userId: String(rawData.userId || row.user_id),
                guildId: String(rawData.guildId || row.guild_id),
                channelId: rawData.channelId || row.channel_id,
                messageId: rawData.messageId || row.message_id,
                name: rawData.name || row.name,
                size: rawData.size || row.size,
                tanks: rawData.tanks ?? row.tanks ?? 0,
                healers: rawData.healers ?? row.healers ?? 0,
                dps: rawData.dps ?? row.dps ?? 0,
                meleedps: rawData.meleedps ?? row.meleedps ?? 0,
                range: rawData.range ?? rawData.physicalrangeddps ?? rawData.range ?? 0,
                caster: rawData.caster ?? rawData.magicalrangeddps ?? rawData.caster ?? 0,
                date: rawData.date || row.date,
                imageUrl: rawData.imageUrl || row.cover_image || row.image_url || null,
                status: rawData.status || row.status || 'active',
                claims: rawData.claims || { tanks: [], healers: [], dps: [], meleedps: [], range: [], caster: [], other: [], reserves: [] },
                notified30Min: rawData.notified30Min ?? row.notified30Min ?? false,
                notifiedExact: rawData.notifiedExact ?? row.notifiedExact ?? false
            };
            ensureListingClaims(listing);
            migrateOldJobCodes(listing);
            return listing;
        });
        return { pfDatabase };
    } catch (e) {
        console.error("Failed to load PF database from MySQL:", e);
        return { pfDatabase: [] };
    }
}

async function saveListingToDB(listing) {
    try {
        ensureListingClaims(listing);
        migrateOldJobCodes(listing);
        const dataJson = JSON.stringify(listing);
        await db.query(
            `INSERT INTO party_finders (id, guild_id, user_id, status, cover_image, data) 
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
             status = VALUES(status), cover_image = VALUES(cover_image), data = VALUES(data)`,
            [
                listing.id,
                listing.guildId,
                listing.userId,
                listing.status || 'active',
                listing.imageUrl || null,
                dataJson
            ]
        );
    } catch (e) {
        console.error("Failed to save PF listing to MySQL:", e);
    }
}

async function deleteListingFromDB(listingId) {
    try {
        await db.query('DELETE FROM party_finders WHERE id = ?', [listingId]);
    } catch (e) {
        console.error("Failed to delete PF listing from MySQL:", e);
    }
}

function migrateOldJobCodes(listing) {
    if (listing.claims) {
        if (listing.claims.physicalrangeddps && !listing.claims.range) {
            listing.claims.range = listing.claims.physicalrangeddps;
            delete listing.claims.physicalrangeddps;
        }
        if (listing.claims.magicalrangeddps && !listing.claims.caster) {
            listing.claims.caster = listing.claims.magicalrangeddps;
            delete listing.claims.magicalrangeddps;
        }
    }
    if (listing.physicalrangeddps !== undefined && listing.range === undefined) {
        listing.range = listing.physicalrangeddps;
        delete listing.physicalrangeddps;
    }
    if (listing.magicalrangeddps !== undefined && listing.caster === undefined) {
        listing.caster = listing.magicalrangeddps;
        delete listing.magicalrangeddps;
    }

    const categories = ['tanks', 'healers', 'dps', 'meleedps', 'range', 'caster', 'other', 'reserves'];
    for (const cat of categories) {
        if (listing.claims && Array.isArray(listing.claims[cat])) {
            listing.claims[cat].forEach(entry => {
                if (entry && entry.job) {
                    entry.job = entry.job
                        .replace('magicalrangeddps_', '')
                        .replace('physicalrangeddps_', '')
                        .replace('meleedps_', '')
                        .replace('range_', '')
                        .replace('caster_', '')
                        .replace('magical_ranged_dps_', '')
                        .replace('physical_ranged_dps_', '')
                        .replace('melee_dps_', '')
                        .replace('ranged_dps_', '')
                        .replace('dps_', '');
                }
            });
        }
    }
}

function ensureListingClaims(listing) {
    if (!listing.claims) listing.claims = {};
    const categories = ['tanks', 'healers', 'dps', 'meleedps', 'range', 'caster', 'other', 'reserves'];
    for (const cat of categories) {
        if (!listing.claims[cat]) listing.claims[cat] = [];
        if (listing[cat] === undefined && cat !== 'reserves') listing[cat] = 0;
    }
}

function parseListingTimestamp(dateStr) {
    if (!dateStr) return null;
    const matchGMT = dateStr.match(/GMT([+-]\d+)/);
    const isJST = dateStr.includes('JST');
    const offsetHours = matchGMT ? parseInt(matchGMT[1], 10) : (isJST ? 9 : 0);
    const cleanDateStr = dateStr.replace(/ (GMT[+-]\d+|JST)/, '').trim();
    const [datePart, timePart] = cleanDateStr.split(' ');
    if (!datePart || !timePart) return null;

    const [year, month, day] = datePart.split('-').map(Number);
    const [hours, minutes] = timePart.split(':').map(Number);

    const sign = offsetHours >= 0 ? '+' : '-';
    const absOffset = String(Math.abs(offsetHours)).padStart(2, '0');
    const isoString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00${sign}${absOffset}:00`;
    return new Date(isoString).getTime();
}

function isTimeInPast(dateStr, timeStr, gmtOffset = 9) {
    const targetMs = parseListingTimestamp(`${dateStr} ${timeStr} GMT${gmtOffset >= 0 ? '+' + gmtOffset : gmtOffset}`);
    return targetMs ? targetMs <= Date.now() : false;
}

function getSafeEmote(guild, rawInput) {
    if (!rawInput) return '';
    if (rawInput.startsWith('<:') || rawInput.startsWith('<a:') || !rawInput.includes(':')) {
        return rawInput;
    }
    const cleanName = rawInput.replace(/:/g, '').trim().toLowerCase();
    if (!guild) return rawInput;

    let found = guild.emojis.cache.find(e =>
        e.name.toLowerCase() === cleanName || e.name.toLowerCase().includes(cleanName)
    );

    if (!found && guild.client) {
        found = guild.client.emojis.cache.find(e =>
            e.name.toLowerCase() === cleanName || e.name.toLowerCase().includes(cleanName)
        );
    }

    return found ? found.toString() : rawInput;
}

function getDynamicCounts(listing) {
    ensureListingClaims(listing);
    const maxDpsPool = (listing.meleedps || 0) + (listing.range || 0) + (listing.caster || 0);
    const currentDpsUsed = listing.claims.dps.length + listing.claims.meleedps.length + listing.claims.range.length + listing.claims.caster.length;

    const totalCurrentSignedUsers =
        listing.claims.tanks.length +
        listing.claims.healers.length +
        currentDpsUsed +
        listing.claims.other.length;

    let maxOtherPool = Math.max(0, listing.size - totalCurrentSignedUsers + listing.claims.other.length);

    return {
        maxDpsPool,
        currentDpsUsed,
        maxOtherPool,
        currentOtherUsed: listing.claims.other.length,
        totalMainSigned: totalCurrentSignedUsers
    };
}

async function buildPFEmbedAndRows(listing, guild, authorTag) {
    ensureListingClaims(listing);
    migrateOldJobCodes(listing);
    const jobsDB = loadJobsJSON();
    const dyn = getDynamicCounts(listing);

    const formatSlotEntries = (entries) => {
        if (!entries || entries.length === 0) return '*None*';
        return entries.map((e, idx) => {
            let jobDisplay = '🎭';
            if (e && e.job) {
                let foundJob = null;
                for (const cat of ['tanks', 'healers', 'dps', 'meleedps', 'physicalrangeddps', 'magicalrangeddps', 'other']) {
                    const match = jobsDB[cat]?.find(j => j.code === e.job);
                    if (match) { foundJob = match; break; }
                }
                if (foundJob && foundJob.emote) {
                    jobDisplay = getSafeEmote(guild, foundJob.emote);
                } else if (foundJob) {
                    jobDisplay = foundJob.code;
                } else {
                    jobDisplay = e.job;
                }
            }
            const userIdTag = e?.userId ? `<@${e.userId}>` : 'Unknown';
            return `[${idx + 1}] ${jobDisplay} ${userIdTag}`;
        }).join('\n');
    };

    const fieldsArr = [];

    fieldsArr.push({ name: `🛡️ Tanks (${listing.claims.tanks.length}/${listing.tanks})`, value: formatSlotEntries(listing.claims.tanks), inline: true });
    fieldsArr.push({ name: `💚 Healers (${listing.claims.healers.length}/${listing.healers})`, value: formatSlotEntries(listing.claims.healers), inline: true });
    fieldsArr.push({ name: `⚔️ DPS (${dyn.currentDpsUsed}/${dyn.maxDpsPool})`, value: formatSlotEntries([...listing.claims.dps, ...listing.claims.meleedps, ...listing.claims.range, ...listing.claims.caster]), inline: true });

    fieldsArr.push({ name: `🗡️ MeleeDPS (${listing.claims.meleedps.length}/${listing.meleedps})`, value: formatSlotEntries(listing.claims.meleedps), inline: true });
    fieldsArr.push({ name: `🏹 RangeDPS (${listing.claims.range.length}/${listing.range})`, value: formatSlotEntries(listing.claims.range), inline: true });
    fieldsArr.push({ name: `✨ CasterDPS (${listing.claims.caster.length}/${listing.caster})`, value: formatSlotEntries(listing.claims.caster), inline: true });

    fieldsArr.push({ name: `📌 Other (${dyn.currentOtherUsed}/${dyn.maxOtherPool})`, value: formatSlotEntries(listing.claims.other), inline: false });
    fieldsArr.push({ name: `📥 Reserves / Bench (${listing.claims.reserves.length})`, value: formatSlotEntries(listing.claims.reserves), inline: false });

    const targetMs = parseListingTimestamp(listing.date);
    const hammertimeDisplay = targetMs ? ` (${toDiscordTimestamp(targetMs, 'f')} / ${toDiscordTimestamp(targetMs, 'R')})` : '';

    const embed = new EmbedBuilder()
        .setTitle(`⚔️ Party Finder: ${listing.name}`)
        .setDescription(`Hosted by <@${listing.userId}>\nScheduled for: **${listing.date}**${hammertimeDisplay}\n\nParty Size: **${listing.size}**\n\nClick **Join** below to pick your role and job, or manage your listing!`)
        .setColor('#f1c40f')
        .addFields(fieldsArr)
        .setFooter({ text: `ID: ${listing.id}` });

    if (listing.imageUrl) {
        embed.setImage(listing.imageUrl);
    }

    const actionRowComps = [
        new ButtonBuilder().setCustomId(`pf_join_modal_${listing.id}`).setLabel('Join [📝]').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`pf_leave_${listing.id}`).setLabel('Leave / Cancel [🚪]').setStyle(ButtonStyle.Secondary)
    ];

    const actionRowAdminComps = [
        new ButtonBuilder().setCustomId(`pf_pub_edit_${listing.id}`).setLabel('Edit Date & Time 📅').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`pf_pub_delete_${listing.id}`).setLabel('Delete Listing 🗑️').setStyle(ButtonStyle.Danger)
    ];

    const components = [
        new ActionRowBuilder().addComponents(actionRowComps),
        new ActionRowBuilder().addComponents(actionRowAdminComps)
    ];

    return { embed, components };
}

async function updateChannelListingEmbed(interaction, listing) {
    if (!listing.messageId || !listing.channelId) return;
    try {
        const channel = await interaction.client.channels.fetch(listing.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        const channelMsg = await channel.messages.fetch(listing.messageId).catch(() => null);
        if (channelMsg) {
            const { embed, components } = await buildPFEmbedAndRows(listing, interaction.guild, interaction.user.tag);
            await channelMsg.edit({ embeds: [embed], components });
        }
    } catch (e) {
        console.error("Failed to update public channel embed:", e);
    }
}

async function sendTimezoneSelectEphemeral(interaction, session, update = false) {
    session.step = 'sel_timezone';
    if (session.data.gmt === undefined) session.data.gmt = 9;

    const gmtOptions = Array.from({ length: 25 }, (_, i) => {
        const offset = i - 12;
        const label = `GMT ${offset >= 0 ? '+' + offset : offset}`;
        return { label, value: String(offset), default: offset === session.data.gmt };
    });

    const gmtMenu = new StringSelectMenuBuilder()
        .setCustomId('pf_sel_gmt_menu')
        .setPlaceholder(`Select Timezone (Current: GMT${session.data.gmt >= 0 ? '+' + session.data.gmt : session.data.gmt})`)
        .addOptions(gmtOptions);

    const row1 = new ActionRowBuilder().addComponents(gmtMenu);
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pf_timezone_done').setLabel('Confirm Timezone ✅').setStyle(ButtonStyle.Success)
    );

    const payload = { content: "🌍 **Step 3:** Select your **Timezone / GMT Offset** first so we can calculate your local date and time accurately:", components: [row1, row2], embeds: [], flags: [MessageFlags.Ephemeral] };

    if (update) {
        return await interaction.update(payload);
    } else {
        return await interaction.reply(payload);
    }
}

async function sendDateModal(interaction, session) {
    session.step = 'modal_date';

    const gmtOffset = session.data.gmt ?? 9;
    const targetDate = new Date(Date.now() + (gmtOffset * 3600 * 1000) + (10 * 60 * 1000));
    const currentYear = targetDate.getUTCFullYear().toString();
    const currentMonth = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
    const currentDay = String(targetDate.getUTCDate()).padStart(2, '0');

    const modal = new ModalBuilder()
        .setCustomId('pf_modal_date')
        .setTitle('Date Setup')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('year_input')
                    .setLabel('Year (YYYY)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(session.data.year || currentYear)
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('month_input')
                    .setLabel('Month (1-12)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(session.data.month || currentMonth)
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('day_input')
                    .setLabel('Day (1-31)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(session.data.day || currentDay)
                    .setRequired(true)
            )
        );

    try {
        return await interaction.showModal(modal);
    } catch (e) {
        console.error("Error showing date modal:", e);
    }
}

async function sendImageModal(interaction, session) {
    session.step = 'modal_image';

    const modal = new ModalBuilder()
        .setCustomId('pf_modal_image')
        .setTitle('PF Cover Photo Setup')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('image_url_input')
                    .setLabel('Cover Photo URL')
                    .setStyle(TextInputStyle.Short)
                    .setValue(session.data.imageUrl || '')
                    .setPlaceholder('can leave blank to use random preset image')
                    .setRequired(false)
            )
        );

    try {
        return await interaction.showModal(modal);
    } catch (e) {
        console.error("Error showing image modal:", e);
    }
}

async function sendRoleConfigEphemeral(interaction, session, update = false) {
    session.step = 'config_roles';
    const partySize = session.data.size;
    const tanks = session.data.tanks ?? (partySize === 4 ? 1 : 2);
    const healers = session.data.healers ?? (partySize === 4 ? 1 : 2);
    const melee = session.data.meleedps ?? (partySize === 4 ? 1 : 2);
    const range = session.data.range ?? (partySize === 4 ? 0 : 1);
    const caster = session.data.caster ?? (partySize === 4 ? 1 : 1);

    session.data.tanks = tanks;
    session.data.healers = healers;
    session.data.meleedps = melee;
    session.data.range = range;
    session.data.caster = caster;

    const totalAssigned = tanks + healers + melee + range + caster;
    const isMismatch = totalAssigned !== partySize;

    let warningText = "";
    if (totalAssigned > partySize) {
        warningText = `⚠️ **Warning:** Selected role total (**${totalAssigned}**) exceeds party size (**${partySize}**)!\n\n`;
    } else if (totalAssigned < partySize) {
        warningText = `⚠️ **Warning:** Selected role total (**${totalAssigned}**) is less than party size (**${partySize}**)! Must be equal.\n\n`;
    } else {
        warningText = `✅ Total assigned roles: **${totalAssigned} / ${partySize}** (Equal to party size).\n\n`;
    }

    const description = warningText +
        `👉 **Click the role buttons below to change slot counts:**\n` +
        `• **Tanks:** ${tanks}\n` +
        `• **Healers:** ${healers}\n` +
        `• **MeleeDPS:** ${melee}\n` +
        `• **RangeDPS:** ${range}\n` +
        `• **CasterDPS:** ${caster}`;

    const embed = new EmbedBuilder()
        .setTitle('⚙️ Configure Role Slots')
        .setDescription(description)
        .setColor(isMismatch ? '#e74c3c' : '#3498db');

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pf_cfg_tanks').setLabel('Tank').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pf_cfg_healers').setLabel('Healer').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pf_cfg_meleedps').setLabel('MeleeDPS').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pf_cfg_range').setLabel('RangeDPS').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pf_cfg_caster').setLabel('CasterDPS').setStyle(ButtonStyle.Secondary)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pf_cfg_confirm').setLabel('Confirm Roles ✅').setStyle(ButtonStyle.Success).setDisabled(isMismatch)
    );

    const payload = { content: "Configure the slots for your Party Finder via ephemeral message:", embeds: [embed], components: [row1, row2, row3], flags: [MessageFlags.Ephemeral] };

    if (update) {
        return await interaction.update(payload);
    } else {
        return await interaction.reply(payload);
    }
}

async function sendConfirmationDashboard(interaction, session, isUpdate = false) {
    session.step = 'confirmation';

    const gmtOffsetVal = session.data.gmt ?? 9;
    const isPast = isTimeInPast(session.data.dateStr, session.data.time, gmtOffsetVal);
    const fullDateStr = `${session.data.dateStr} ${session.data.time} GMT${gmtOffsetVal >= 0 ? '+' + gmtOffsetVal : gmtOffsetVal}`;
    const parsedTargetMs = parseListingTimestamp(fullDateStr);
    const previewHammertime = parsedTargetMs ? ` (${toDiscordTimestamp(parsedTargetMs, 'f')} / ${toDiscordTimestamp(parsedTargetMs, 'R')})` : '';

    const embed = new EmbedBuilder()
        .setTitle('📋 Party Finder Preview Dashboard')
        .setDescription('Review your event configuration below. Click any button to edit specific fields or finish publishing!')
        .setColor(isPast ? '#e74c3c' : '#3498db')
        .addFields(
            { name: 'Duty & Size', value: `• Name: **${session.data.name}**\n• Size: **${session.data.size} Players**`, inline: false },
            { name: 'Role Breakdown', value: `• Tanks: **${session.data.tanks}**\n• Healers: **${session.data.healers}**\n• MeleeDPS: **${session.data.meleedps}**\n• RangeDPS: **${session.data.range}**\n• CasterDPS: **${session.data.caster}**\n*(DPS & Other slots are dynamically handled)*`, inline: false },
            { name: 'Scheduled Date & Time', value: `• **${session.data.dateStr} at ${session.data.time} (GMT${gmtOffsetVal >= 0 ? '+' + gmtOffsetVal : gmtOffsetVal})**${previewHammertime}`, inline: false },
            { name: 'Cover Photo', value: session.data.imageUrl ? `[View Image URL](${session.data.imageUrl})` : '*Using Random Preset Image*', inline: false }
        );

    let contentMsg = "✅ Configuration generated successfully!";
    if (isPast) {
        contentMsg = "⚠️ **Cannot make PF for the past!**";
    }

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pf_edit_name_size').setLabel('Edit Duty/Size').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pf_edit_roles').setLabel('Edit Roles').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pf_edit_date').setLabel('Edit Date/Time').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pf_edit_image').setLabel('Change Photo 🖼️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pf_finish').setLabel('🚀 Finish & Announce').setStyle(ButtonStyle.Success).setDisabled(isPast)
    );

    if (isUpdate) {
        return await interaction.update({ content: contentMsg, embeds: [embed], components: [row1, row2] });
    } else {
        return await interaction.reply({ content: contentMsg, embeds: [embed], components: [row1, row2], flags: [MessageFlags.Ephemeral] });
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pf')
        .setDescription('Open the party finder wizard interface.'),

    async execute(interaction) {
        if (!global.pfSessions) global.pfSessions = new Map();
        global.pfSessions.set(interaction.user.id, { step: 'idle', data: {} });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pf_create').setLabel('Create New').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('pf_check').setLabel('Check My PF(s)').setStyle(ButtonStyle.Secondary)
        );

        return await interaction.reply({
            content: "Welcome to party finder wizard interface!\nPlease select your request:",
            components: [row],
            flags: [MessageFlags.Ephemeral]
        });
    },

    async handleInteraction(interaction) {
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!',
                flags: [MessageFlags.Ephemeral]
            });
        }

        const userId = String(interaction.user.id);
        const guildId = String(interaction.guildId);
        if (!global.pfSessions) global.pfSessions = new Map();

        if (interaction.isButton() || interaction.isStringSelectMenu()) {
            const cid = interaction.customId;

            if (cid.startsWith('pf_pub_edit_')) {
                const listingId = cid.replace('pf_pub_edit_', '');
                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);

                if (!listing) return interaction.reply({ content: "⚠️ This listing no longer exists.", flags: [MessageFlags.Ephemeral] });

                const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
                if (listing.userId !== userId && !isAdmin) {
                    return await interaction.reply({ content: "❌ Only the **host** or an **admin** can edit this listing's date & time.", flags: [MessageFlags.Ephemeral] });
                }

                global.pfSessions.set(userId, { step: 'sel_timezone', data: { id: listing.id, isDirectEdit: true, name: listing.name, size: listing.size, imageUrl: listing.imageUrl } });
                return await sendTimezoneSelectEphemeral(interaction, global.pfSessions.get(userId), true);
            }

            if (cid.startsWith('pf_pub_delete_')) {
                const listingId = cid.replace('pf_pub_delete_', '');
                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);

                if (!listing) return interaction.reply({ content: "⚠️ This listing no longer exists.", flags: [MessageFlags.Ephemeral] });

                const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
                if (listing.userId !== userId && !isAdmin) {
                    return await interaction.reply({ content: "❌ Only the **host** or an **admin** can delete this PF listing.", flags: [MessageFlags.Ephemeral] });
                }

                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`pf_confirm_pub_del_${listingId}`).setLabel('Yes, Delete Listing').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`pf_cancel_pub_del_${listingId}`).setLabel('No, Cancel').setStyle(ButtonStyle.Secondary)
                );

                return await interaction.reply({
                    content: `⚠️ **Are you sure you want to delete "${listing.name}"?**\nThis will remove the channel announcement and clear this Party Finder listing permanently.`,
                    components: [confirmRow],
                    flags: [MessageFlags.Ephemeral]
                });
            }

            if (cid.startsWith('pf_confirm_pub_del_')) {
                const listingId = cid.replace('pf_confirm_pub_del_', '');
                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);

                if (listing) {
                    try {
                        if (listing.messageId && listing.channelId) {
                            const channel = await interaction.client.channels.fetch(listing.channelId).catch(() => null);
                            if (channel && channel.isTextBased()) {
                                const channelMsg = await channel.messages.fetch(listing.messageId).catch(() => null);
                                if (channelMsg) await channelMsg.delete().catch(() => null);
                            }
                        }
                    } catch (e) {
                        console.error('Error removing public announcement message:', e);
                    }

                    await deleteListingFromDB(listingId);

                    await interaction.channel.send({
                        content: `🗑️ **User (<@${userId}>) deleted PF: (${listing.name}) set for (${listing.date}).**`
                    }).catch(() => { });
                }

                return await interaction.update({
                    content: "✅ Listing and announcement successfully deleted.",
                    components: [],
                    embeds: []
                });
            }

            if (cid.startsWith('pf_cancel_pub_del_')) {
                return await interaction.update({ content: "❌ Deletion cancelled.", components: [], embeds: [] });
            }

            if (cid.startsWith('pf_delete_listing_')) {
                const listingId = cid.replace('pf_delete_listing_', '');
                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);

                if (!listing) {
                    return interaction.reply({
                        content: "⚠️ **Notice:** This Party Finder listing has already been deleted or does not exist.",
                        flags: [MessageFlags.Ephemeral]
                    });
                }

                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`pf_confirm_del_${listingId}`).setLabel('Yes, Delete Listing').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`pf_cancel_del_${listingId}`).setLabel('No, Cancel').setStyle(ButtonStyle.Secondary)
                );

                return await interaction.reply({
                    content: `⚠️ **Are you sure you want to delete "${listing.name}"?**\nThis will remove the channel announcement and clear this Party Finder listing permanently.`,
                    components: [confirmRow],
                    flags: [MessageFlags.Ephemeral]
                });
            }

            if (cid.startsWith('pf_confirm_del_')) {
                const listingId = cid.replace('pf_confirm_del_', '');
                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);

                if (listing) {
                    try {
                        if (listing.messageId && listing.channelId) {
                            const channel = await interaction.client.channels.fetch(listing.channelId).catch(() => null);
                            if (channel && channel.isTextBased()) {
                                const channelMsg = await channel.messages.fetch(listing.messageId).catch(() => null);
                                if (channelMsg) await channelMsg.delete().catch(() => null);
                            }
                        }
                    } catch (e) {
                        console.error('Error removing public announcement message:', e);
                    }

                    await deleteListingFromDB(listingId);

                    await interaction.channel.send({
                        content: `🗑️ **User (<@${listing.userId}>) deleted PF: (${listing.name}) set for (${listing.date}).**`
                    }).catch(() => { });
                }

                return await interaction.update({
                    content: "✅ Listing and announcement successfully deleted.",
                    components: [],
                    embeds: []
                });
            }

            if (cid.startsWith('pf_cancel_del_')) {
                return await interaction.update({ content: "❌ Deletion cancelled.", components: [] });
            }

            if (cid === 'pf_create') {
                global.pfSessions.set(userId, { step: 'modal_duty', data: {} });

                const modal = new ModalBuilder()
                    .setCustomId('pf_modal_duty')
                    .setTitle('Party Finder Setup')
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('duty_name')
                                .setLabel('Duty / Event Name')
                                .setStyle(TextInputStyle.Short)
                                .setPlaceholder('e.g. Ultimate Raid / Extreme Trial')
                                .setRequired(true)
                        )
                    );

                await interaction.showModal(modal);
                return;
            }

            if (cid === 'pf_sel_size_menu') {
                const session = global.pfSessions.get(userId);
                if (!session) return interaction.reply({ content: "❌ Session expired. Please start over using `/pf`.", flags: [MessageFlags.Ephemeral] });

                const partySize = parseInt(interaction.values[0]);
                session.data.size = partySize;

                if (partySize === 4) {
                    session.data.tanks = 1;
                    session.data.healers = 1;
                    session.data.meleedps = 1;
                    session.data.range = 0;
                    session.data.caster = 1;
                } else {
                    session.data.tanks = 2;
                    session.data.healers = 2;
                    session.data.meleedps = 2;
                    session.data.range = 1;
                    session.data.caster = 1;
                }

                return await sendRoleConfigEphemeral(interaction, session, true);
            }

            if (cid.startsWith('pf_cfg_')) {
                const roleType = cid.replace('pf_cfg_', '');
                const session = global.pfSessions.get(userId);
                if (!session) return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral] });

                if (roleType === 'confirm') {
                    return await sendTimezoneSelectEphemeral(interaction, session, true);
                }

                session.data.activeRoleEdit = roleType;
                const modal = new ModalBuilder()
                    .setCustomId('pf_modal_role_count')
                    .setTitle(`Configure ${roleType.toUpperCase()} Slots`)
                    .addComponents(
                        new ActionRowBuilder().addComponents(
                            new TextInputBuilder()
                                .setCustomId('role_count_input')
                                .setLabel('Number of Slots')
                                .setStyle(TextInputStyle.Short)
                                .setValue(String(session.data[roleType] ?? 0))
                                .setRequired(true)
                        )
                    );

                return await interaction.showModal(modal);
            }

            if (cid === 'pf_sel_gmt_menu') {
                const session = global.pfSessions.get(userId);
                if (!session) return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral] });

                session.data.gmt = parseInt(interaction.values[0], 10);
                return await interaction.deferUpdate();
            }

            if (cid === 'pf_timezone_done') {
                const session = global.pfSessions.get(userId);
                if (!session) return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral] });

                return await sendDateModal(interaction, session);
            }

            if (cid === 'pf_sel_hour_menu' || cid === 'pf_sel_minute_menu' || cid === 'pf_time_done') {
                const session = global.pfSessions.get(userId);
                if (!session) return interaction.reply({ content: "❌ Session expired. Please start over using `/pf`.", flags: [MessageFlags.Ephemeral] });

                if (cid === 'pf_sel_hour_menu') {
                    session.data.hour = interaction.values[0];
                    return await interaction.deferUpdate();
                }

                if (cid === 'pf_sel_minute_menu') {
                    session.data.minute = interaction.values[0];
                    return await interaction.deferUpdate();
                }

                if (cid === 'pf_time_done') {
                    if (!session.data.hour) session.data.hour = '21';
                    if (!session.data.minute) session.data.minute = '00';

                    session.data.time = `${session.data.hour}:${session.data.minute}`;

                    return await sendImageModal(interaction, session);
                }
            }

            if (cid.startsWith('pf_edit_')) {
                const field = cid.replace('pf_edit_', '');
                const session = global.pfSessions.get(userId);
                if (!session) return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral] });

                if (field === 'name_size') {
                    session.step = 'sel_size';
                    const sizeRow = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('pf_sel_size_menu')
                            .setPlaceholder('Select Party Size')
                            .addOptions([
                                { label: '4 Members (Light Party)', value: '4', description: 'Standard 4-person duty' },
                                { label: '8 Members (Full Party)', value: '8', description: 'Standard 8-person raid/trial' }
                            ])
                    );
                    return await interaction.update({ content: `✏️ **Edit Party Size**\nCurrent Name: **${session.data.name}**\nSelect your new **Party Size**:`, components: [sizeRow], embeds: [] });
                }

                if (field === 'roles') {
                    return await sendRoleConfigEphemeral(interaction, session, true);
                }

                if (field === 'date') {
                    return await sendTimezoneSelectEphemeral(interaction, session, true);
                }

                if (field === 'image') {
                    return await sendImageModal(interaction, session);
                }
            }

            if (cid === 'pf_finish') {
                const session = global.pfSessions.get(userId);
                if (!session) return interaction.reply({ content: "❌ Session expired.", flags: [MessageFlags.Ephemeral] });

                const gmtVal = session.data.gmt ?? 9;
                const gmtStr = `GMT${gmtVal >= 0 ? '+' + gmtVal : gmtVal}`;

                let finalImgUrl = session.data.imageUrl;
                let imageStatus = session.data.imageStatus;

                if (!finalImgUrl) {
                    finalImgUrl = loadPresetImage(session.data.size || 8);
                    if (finalImgUrl) {
                        imageStatus = 'success_random';
                    } else {
                        imageStatus = 'failed_random';
                    }
                }

                const listing = {
                    id: Date.now().toString(),
                    userId,
                    guildId,
                    channelId: interaction.channelId,
                    name: session.data.name,
                    size: session.data.size,
                    tanks: session.data.tanks,
                    healers: session.data.healers,
                    dps: session.data.dps ?? 0,
                    meleedps: session.data.meleedps,
                    range: session.data.range,
                    caster: session.data.caster,
                    date: `${session.data.dateStr} ${session.data.time} ${gmtStr}`,
                    imageUrl: finalImgUrl,
                    claims: { tanks: [], healers: [], dps: [], meleedps: [], range: [], caster: [], other: [], reserves: [] },
                    messageId: null,
                    status: 'active',
                    notified30Min: false,
                    notifiedExact: false
                };
                migrateOldJobCodes(listing);
                ensureListingClaims(listing);

                const { embed, components } = await buildPFEmbedAndRows(listing, interaction.guild, `<@${userId}>`);
                const sentMessage = await interaction.channel.send({
                    content: '@here A new Party Finder listing has been published!',
                    embeds: [embed],
                    components
                });

                listing.messageId = sentMessage.id;
                await saveListingToDB(listing);
                global.pfSessions.delete(userId);

                let photoStatusMsg = "";
                if (imageStatus === 'success_custom') {
                    photoStatusMsg = "\n🖼️ **Photo Status:** Custom cover photo was successfully attached and used!";
                } else if (imageStatus === 'success_random') {
                    photoStatusMsg = "\n🎲 **Photo Status:** Cover photo field was left blank, successfully loaded a random preset image from JSON!";
                } else if (imageStatus === 'failed_invalid') {
                    photoStatusMsg = "\n⚠️ **Photo Status:** Custom URL was invalid/inaccessible. Attempted random preset fallback, but it also failed.";
                } else if (imageStatus === 'failed_random') {
                    photoStatusMsg = "\n⚠️ **Photo Status:** Preset image lookup failed or json files are empty.";
                } else {
                    photoStatusMsg = "\nℹ️ **Photo Status:** Cover photo was left blank.";
                }

                const successNote = `🎉 **Party Finder successfully posted to the channel!**${photoStatusMsg}`;
                return await interaction.update({ content: successNote, components: [], embeds: [] });
            }

            if (cid.startsWith('pf_join_modal_')) {
                const listingId = cid.replace('pf_join_modal_', '');
                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);
                if (!listing) return interaction.reply({ content: "❌ This listing no longer exists.", flags: [MessageFlags.Ephemeral] });

                const roleMenuRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`pf_role_pick_${listingId}`)
                        .setPlaceholder('Select Role Category...')
                        .addOptions([
                            { label: 'Tank', value: 'tanks', description: 'Select a Tank role/job', emoji: '🛡️' },
                            { label: 'Healer', value: 'healers', description: 'Select a Healer role/job', emoji: '💚' },
                            { label: 'DPS', value: 'dps_root', description: 'Select DPS jobs, Melee, Range, or Caster', emoji: '⚔️' },
                            { label: 'Other', value: 'other', description: 'Select an Other role/job', emoji: '📌' }
                        ])
                );

                return interaction.reply({
                    content: "🛡️ **Step 1:** Select your desired **Role Category**:",
                    components: [roleMenuRow],
                    flags: [MessageFlags.Ephemeral]
                });
            }

            if (cid.startsWith('pf_role_pick_')) {
                const listingId = cid.replace('pf_role_pick_', '');
                const roleKey = interaction.values[0];

                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);
                if (!listing) return interaction.update({ content: "❌ This listing no longer exists.", components: [] });

                const jobsDB = loadJobsJSON();
                let options = [];

                if (roleKey === 'tanks') {
                    options = (jobsDB.tanks || []).map(j => ({
                        label: `${j.name} (${j.code})`,
                        value: `tanks_${j.code}`,
                        description: `Job Code: ${j.code}`
                    }));
                } else if (roleKey === 'healers') {
                    options = (jobsDB.healers || []).map(j => ({
                        label: `${j.name} (${j.code})`,
                        value: `healers_${j.code}`,
                        description: `Job Code: ${j.code}`
                    }));
                } else if (roleKey === 'other') {
                    options = (jobsDB.other || []).map(j => ({
                        label: `${j.name} (${j.code})`,
                        value: `other_${j.code}`,
                        description: `Job Code: ${j.code}`
                    }));
                } else if (roleKey === 'dps_root') {
                    const dpsJobs = (jobsDB.dps || []).map(j => ({
                        label: `${j.name} (${j.code})`,
                        value: `dps_${j.code}`,
                        description: `DPS job: ${j.code}`
                    }));

                    const literalOptions = [
                        { label: 'Melee', value: 'sub_meleedps', description: 'Select to choose a Melee job' },
                        { label: 'Range', value: 'sub_range', description: 'Select to choose a Range job' },
                        { label: 'Caster', value: 'sub_caster', description: 'Select to choose a Caster job' }
                    ];

                    options = [...dpsJobs, ...literalOptions];
                } else if (roleKey === 'sub_meleedps') {
                    options = (jobsDB.meleedps || []).map(j => ({
                        label: `${j.name} (${j.code})`,
                        value: `meleedps_${j.code}`,
                        description: `Melee job: ${j.code}`
                    }));
                } else if (roleKey === 'sub_range') {
                    options = (jobsDB.physicalrangeddps || []).map(j => ({
                        label: `${j.name} (${j.code})`,
                        value: `range_${j.code}`,
                        description: `Range job: ${j.code}`
                    }));
                } else if (roleKey === 'sub_caster') {
                    options = (jobsDB.magicalrangeddps || []).map(j => ({
                        label: `${j.name} (${j.code})`,
                        value: `caster_${j.code}`,
                        description: `Caster job: ${j.code}`
                    }));
                }

                if (['sub_meleedps', 'sub_range', 'sub_caster'].includes(roleKey)) {
                    const subMenuRow = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`pf_jobsel_${listingId}`)
                            .setPlaceholder('Select Specific Job...')
                            .addOptions(options.length > 0 ? options.slice(0, 25) : [{ label: 'General / Any', value: `${roleKey}_ANY` }])
                    );
                    return interaction.update({
                        content: `✨ Choose your specific job:`,
                        components: [subMenuRow]
                    });
                }

                const menuRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`pf_jobsel_${listingId}`)
                        .setPlaceholder('Select your Specific Job...')
                        .addOptions(options.length > 0 ? options.slice(0, 25) : [{ label: 'General / Any', value: `${roleKey}_ANY` }])
                );

                return interaction.update({
                    content: `✨ **Step 2:** Choose your specific job:`,
                    components: [menuRow]
                });
            }

            if (cid.startsWith('pf_jobsel_')) {
                const listingId = cid.replace('pf_jobsel_', '');
                const rawVal = interaction.values[0];

                if (rawVal.startsWith('sub_')) {
                    const jobsDB = loadJobsJSON();
                    let options = [];
                    let subRoleKey = rawVal;

                    if (rawVal === 'sub_meleedps') {
                        options = (jobsDB.meleedps || []).map(j => ({
                            label: `${j.name} (${j.code})`,
                            value: `meleedps_${j.code}`,
                            description: `Melee job: ${j.code}`
                        }));
                    } else if (rawVal === 'sub_range') {
                        options = (jobsDB.physicalrangeddps || []).map(j => ({
                            label: `${j.name} (${j.code})`,
                            value: `range_${j.code}`,
                            description: `Range job: ${j.code}`
                        }));
                    } else if (rawVal === 'sub_caster') {
                        options = (jobsDB.magicalrangeddps || []).map(j => ({
                            label: `${j.name} (${j.code})`,
                            value: `caster_${j.code}`,
                            description: `Caster job: ${j.code}`
                        }));
                    }

                    const subMenuRow = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`pf_jobsel_${listingId}`)
                            .setPlaceholder('Select Specific Job...')
                            .addOptions(options.length > 0 ? options.slice(0, 25) : [{ label: 'General / Any', value: `${subRoleKey}_ANY` }])
                    );
                    return interaction.update({
                        content: `✨ Choose your specific sub-job:`,
                        components: [subMenuRow]
                    });
                }

                const valParts = rawVal.split('_');
                const roleKey = valParts[0];
                const selectedJobCode = valParts.slice(1).join('_');

                const confirmButtonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`pf_confirm_join_${listingId}_${roleKey}_${selectedJobCode}`)
                        .setLabel('Confirm Job Selection ✅')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`pf_cancel_join_${listingId}`)
                        .setLabel('Cancel ❌')
                        .setStyle(ButtonStyle.Secondary)
                );

                return interaction.update({
                    content: `👉 You selected role **${roleKey.toUpperCase()}** with job **${selectedJobCode}**. Click **Confirm Job Selection** to finalize!`,
                    components: [confirmButtonRow]
                });
            }

            if (cid.startsWith('pf_confirm_join_')) {
                const parts = cid.replace('pf_confirm_join_', '').split('_');
                const listingId = parts[0];
                const roleKey = parts[1];
                const selectedJobCode = parts.slice(2).join('_');

                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);
                if (!listing) return interaction.update({ content: "❌ This listing no longer exists.", components: [] });

                migrateOldJobCodes(listing);
                ensureListingClaims(listing);

                for (const cat in listing.claims) {
                    listing.claims[cat] = listing.claims[cat].filter(e => e.userId !== userId);
                }

                const dyn = getDynamicCounts(listing);
                let isBench = false;
                const totalDpsCount = listing.claims.dps.length + listing.claims.meleedps.length + listing.claims.range.length + listing.claims.caster.length;

                // INDEPENDENT CATEGORY VALIDATION CHECKS IN EXACT ORDER
                if (roleKey === 'tanks') {
                    if (dyn.totalMainSigned < listing.size && listing.claims.tanks.length < listing.tanks) {
                        listing.claims.tanks.push({ userId, job: selectedJobCode });
                    } else {
                        listing.claims.reserves.push({ userId, job: selectedJobCode });
                        isBench = true;
                    }
                } else if (roleKey === 'healers') {
                    if (dyn.totalMainSigned < listing.size && listing.claims.healers.length < listing.healers) {
                        listing.claims.healers.push({ userId, job: selectedJobCode });
                    } else {
                        listing.claims.reserves.push({ userId, job: selectedJobCode });
                        isBench = true;
                    }
                } else if (roleKey === 'dps') {
                    if (dyn.totalMainSigned < listing.size && totalDpsCount < dyn.maxDpsPool) {
                        listing.claims.dps.push({ userId, job: selectedJobCode });
                    } else {
                        listing.claims.reserves.push({ userId, job: selectedJobCode });
                        isBench = true;
                    }
                } else if (roleKey === 'meleedps') {
                    if (dyn.totalMainSigned < listing.size && totalDpsCount < dyn.maxDpsPool && listing.claims.meleedps.length < listing.meleedps) {
                        listing.claims.meleedps.push({ userId, job: selectedJobCode });
                    } else {
                        listing.claims.reserves.push({ userId, job: selectedJobCode });
                        isBench = true;
                    }
                } else if (roleKey === 'range') {
                    if (dyn.totalMainSigned < listing.size && totalDpsCount < dyn.maxDpsPool && listing.claims.range.length < listing.range) {
                        listing.claims.range.push({ userId, job: selectedJobCode });
                    } else {
                        listing.claims.reserves.push({ userId, job: selectedJobCode });
                        isBench = true;
                    }
                } else if (roleKey === 'caster') {
                    if (dyn.totalMainSigned < listing.size && totalDpsCount < dyn.maxDpsPool && listing.claims.caster.length < listing.caster) {
                        listing.claims.caster.push({ userId, job: selectedJobCode });
                    } else {
                        listing.claims.reserves.push({ userId, job: selectedJobCode });
                        isBench = true;
                    }
                } else if (roleKey === 'other') {
                    if (dyn.totalMainSigned < listing.size && listing.claims.other.length < dyn.maxOtherPool) {
                        listing.claims.other.push({ userId, job: selectedJobCode });
                    } else {
                        listing.claims.reserves.push({ userId, job: selectedJobCode });
                        isBench = true;
                    }
                } else {
                    listing.claims.reserves.push({ userId, job: selectedJobCode });
                    isBench = true;
                }

                await saveListingToDB(listing);
                await updateChannelListingEmbed(interaction, listing);

                let replyText = `✅ Successfully registered as **${selectedJobCode}**!`;
                if (isBench) {
                    replyText = `⚠️ **That slot/party is full, so you have been placed into Reserves/Bench (${selectedJobCode})**!`;
                }

                return interaction.update({ content: replyText, components: [] });
            }

            if (cid.startsWith('pf_cancel_join_')) {
                return interaction.update({ content: "❌ Job selection cancelled.", components: [] });
            }

            if (cid.startsWith('pf_leave_')) {
                const listingId = cid.replace('pf_leave_', '');
                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);
                if (!listing) return interaction.reply({ content: "❌ This listing no longer exists.", flags: [MessageFlags.Ephemeral] });

                migrateOldJobCodes(listing);
                ensureListingClaims(listing);

                for (const cat in listing.claims) {
                    listing.claims[cat] = listing.claims[cat].filter(e => e.userId !== userId);
                }

                await saveListingToDB(listing);
                await updateChannelListingEmbed(interaction, listing);

                return interaction.reply({ content: "🚪 You have left/cancelled your slot in this party finder.", flags: [MessageFlags.Ephemeral] });
            }

            if (cid === 'pf_check') {
                const dbData = await loadDB();
                const userListings = dbData.pfDatabase.filter(l => String(l.userId) === userId && String(l.guildId) === guildId);

                if (userListings.length === 0) {
                    return interaction.reply({ content: "❌ You don't have any active Party Finder listings in this server.", flags: [MessageFlags.Ephemeral] });
                }

                const rows = userListings.map(l => new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`pf_show_${l.id}`).setLabel(`🔄 Show Again: ${l.name.substring(0, 60)}`).setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`pf_delete_listing_${l.id}`).setLabel(`🗑️ Delete`).setStyle(ButtonStyle.Danger)
                ));

                return interaction.reply({ content: "📋 **Your Active Party Finder Listings:**", components: rows, flags: [MessageFlags.Ephemeral] });
            }

            if (cid.startsWith('pf_show_')) {
                const listingId = cid.replace('pf_show_', '');
                const dbData = await loadDB();
                const listing = dbData.pfDatabase.find(l => l.id === listingId);

                if (!listing) {
                    return interaction.update({ content: "❌ Listing no longer exists.", components: [] });
                }
                migrateOldJobCodes(listing);
                ensureListingClaims(listing);

                if (listing.messageId && listing.channelId) {
                    try {
                        const channel = await interaction.client.channels.fetch(listing.channelId).catch(() => null);
                        if (channel && channel.isTextBased()) {
                            const oldMsg = await channel.messages.fetch(listing.messageId).catch(() => null);
                            if (oldMsg) await oldMsg.delete();
                        }
                    } catch (e) { }
                }

                listing.channelId = interaction.channelId;
                const { embed, components } = await buildPFEmbedAndRows(listing, interaction.guild, `<@${listing.userId}>`);
                
                if (listing.imageUrl) {
                    embed.setImage(listing.imageUrl);
                }

                const newMsg = await interaction.channel.send({ content: '@here Party Finder listing refreshed:', embeds: [embed], components });

                listing.messageId = newMsg.id;
                await saveListingToDB(listing);

                return interaction.update({ content: "🔄 **Party Finder successfully re-posted/shown again in the channel!**", components: [] });
            }
        }

        if (interaction.isModalSubmit()) {
            const mId = interaction.customId;
            const session = global.pfSessions.get(userId);
            if (!session) return interaction.reply({ content: "❌ Session expired. Please start over using `/pf`.", flags: [MessageFlags.Ephemeral] });

            if (mId === 'pf_modal_duty') {
                session.data.name = interaction.fields.getTextInputValue('duty_name');
                session.step = 'sel_size';

                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('pf_sel_size_menu')
                        .setPlaceholder('Select Party Size')
                        .addOptions([
                            { label: '4 Members (Light Party)', value: '4', description: 'Standard 4-person duty' },
                            { label: '8 Members (Full Party)', value: '8', description: 'Standard 8-person raid/trial' }
                        ])
                );
                return await interaction.reply({ content: `👥 **Party Size Setup**\nDuty: **${session.data.name}**\nNow select your **Party Size**:`, components: [row], flags: [MessageFlags.Ephemeral] });
            }

            if (mId === 'pf_modal_role_count') {
                const countVal = parseInt(interaction.fields.getTextInputValue('role_count_input'), 10);
                if (isNaN(countVal) || countVal < 0) {
                    return await interaction.reply({ content: "❌ Please enter a valid non-negative number.", flags: [MessageFlags.Ephemeral] });
                }

                const roleKey = session.data.activeRoleEdit;
                if (roleKey) {
                    session.data[roleKey] = countVal;
                }

                return await sendRoleConfigEphemeral(interaction, session, true);
            }

            if (mId === 'pf_modal_date') {
                const yearText = interaction.fields.getTextInputValue('year_input').trim();
                const monthText = interaction.fields.getTextInputValue('month_input').trim();
                const dayText = interaction.fields.getTextInputValue('day_input').trim();

                if (!/^\d{4}$/.test(yearText)) {
                    return await interaction.reply({ content: "❌ Invalid year format. Please provide a 4-digit year (e.g., `2026`).", flags: [MessageFlags.Ephemeral] });
                }
                const monthNum = parseInt(monthText, 10);
                if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
                    return await interaction.reply({ content: "❌ Invalid month. Please provide a number between 1 and 12.", flags: [MessageFlags.Ephemeral] });
                }
                const dayNum = parseInt(dayText, 10);
                if (isNaN(dayNum) || dayNum < 1 || dayNum > 31) {
                    return await interaction.reply({ content: "❌ Invalid day. Please provide a number between 1 and 31.", flags: [MessageFlags.Ephemeral] });
                }

                session.data.year = yearText;
                session.data.month = String(monthNum).padStart(2, '0');
                session.data.day = String(dayNum).padStart(2, '0');
                session.data.dateStr = `${session.data.year}-${session.data.month}-${session.data.day}`;
                session.step = 'sel_time';

                const gmtOffset = session.data.gmt ?? 9;
                const targetDate = new Date(Date.now() + (gmtOffset * 3600 * 1000) + (10 * 60 * 1000));
                let rawMinutes = targetDate.getUTCMinutes();
                let roundedMinutes = Math.ceil(rawMinutes / 15) * 15;
                let targetHours = targetDate.getUTCHours();

                if (roundedMinutes >= 60) {
                    roundedMinutes = 0;
                    targetHours = (targetHours + 1) % 24;
                }

                session.data.hour = String(targetHours).padStart(2, '0');
                session.data.minute = String(roundedMinutes).padStart(2, '0');

                const hoursOptions = Array.from({ length: 24 }, (_, i) => {
                    const h = String(i).padStart(2, '0');
                    return { label: h, value: h };
                });

                const minutesOptions = Array.from({ length: 12 }, (_, i) => {
                    const m = String(i * 5).padStart(2, '0');
                    return { label: m, value: m };
                });

                const hoursMenu = new StringSelectMenuBuilder().setCustomId('pf_sel_hour_menu').setPlaceholder(`Hour [${session.data.hour}]`).addOptions(hoursOptions);
                const minutesMenu = new StringSelectMenuBuilder().setCustomId('pf_sel_minute_menu').setPlaceholder(`Minute [${session.data.minute}]`).addOptions(minutesOptions);

                const row1 = new ActionRowBuilder().addComponents(hoursMenu);
                const row2 = new ActionRowBuilder().addComponents(minutesMenu);
                const row3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('pf_time_done').setLabel('Confirm Time ✅').setStyle(ButtonStyle.Success)
                );

                if (session.data.isDirectEdit) {
                    return await interaction.update({ content: `⏰ **Time Setup (Direct Edit)**\nSelected Date: **${session.data.dateStr}** (GMT${gmtOffset >= 0 ? '+' + gmtOffset : gmtOffset})\nSelect **Hour** and **Minute**, then click Confirm:`, components: [row1, row2, row3] });
                }

                return await interaction.update({ content: `⏰ **Time Setup**\nSelected Date: **${session.data.dateStr}** (GMT${gmtOffset >= 0 ? '+' + gmtOffset : gmtOffset})\nSelect **Hour** and **Minute**, then click Confirm:`, components: [row1, row2, row3] });
            }

            if (mId === 'pf_modal_image') {
                const urlInput = interaction.fields.getTextInputValue('image_url_input').trim();
                let finalImageUrl = session.data.imageUrl || null;
                let imageStatus = 'blank';

                if (urlInput !== '') {
                    const isValid = await isValidImageUrl(urlInput);
                    if (!isValid) {
                        imageStatus = 'failed_invalid';
                    } else {
                        finalImageUrl = urlInput;
                        imageStatus = 'success_custom';
                    }
                }

                session.data.imageUrl = finalImageUrl;
                session.data.imageStatus = imageStatus;

                if (session.data.isDirectEdit) {
                    const dbData = await loadDB();
                    const listing = dbData.pfDatabase.find(l => l.id === session.data.id);
                    if (listing) {
                        const gmtVal = session.data.gmt ?? 9;
                        const gmtString = `GMT${gmtVal >= 0 ? '+' + gmtVal : gmtVal}`;
                        listing.date = `${session.data.dateStr} ${session.data.time} ${gmtString}`;
                        listing.imageUrl = session.data.imageUrl;
                        await saveListingToDB(listing);
                        await updateChannelListingEmbed(interaction, listing);
                    }
                    global.pfSessions.delete(userId);
                    return await interaction.update({
                        content: `✅ Successfully updated listing details!`,
                        components: [],
                        embeds: []
                    });
                }

                return await sendConfirmationDashboard(interaction, session, true);
            }
        }
    }
};