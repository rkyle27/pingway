const {
    SlashCommandBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const { pool } = require('../utils/db');

function extractLodestoneId(input) {
    if (!input) return null;
    const cleanInput = input.trim();
    const urlMatch = cleanInput.match(/\/character\/(\d+)/);
    if (urlMatch) return urlMatch[1];
    if (/^\d+$/.test(cleanInput)) return cleanInput;
    return null;
}

const ffxivJobs = {
    Tank: ['Paladin', 'Warrior', 'Dark Knight', 'Gunbreaker'],
    Healer: ['White Mage', 'Scholar', 'Astrologian', 'Sage'],
    Melee: ['Monk', 'Dragoon', 'Ninja', 'Samurai', 'Reaper', 'Viper'],
    Range: ['Bard', 'Machinist', 'Dancer'],
    Caster: ['Black Mage', 'Summoner', 'Red Mage', 'Pictomancer']
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ignconfig')
        .setDescription('⚙️ Configure your FFXIV character profile, main job, portraits, Tomestone, and FFLogs settings.'),

    async execute(interaction) {
        const userId = interaction.user.id;
        const [rows] = await pool.execute('SELECT * FROM user_ign_config WHERE user_id = ?', [userId]);
        const existing = rows.length > 0 ? rows[0] : null;

        global.ignSessions = global.ignSessions || {};
        global.ignSessions[userId] = {
            lodestone_id: existing ? existing.lodestone_id : '',
            main_job: existing && existing.main_job ? existing.main_job : '',
            portrait_url: existing && existing.portrait_url ? existing.portrait_url : '',
            full_photo_url: existing && existing.full_photo_url ? existing.full_photo_url : '',
            portrait_toggle: existing ? Boolean(existing.portrait_toggle) : true,
            tomestone_url: existing && existing.tomestone_url ? existing.tomestone_url : '',
            fflogs_url: existing && existing.fflogs_url ? existing.fflogs_url : ''
        };

        return sendConfigDashboard(interaction, true);
    },

    async handleButton(interaction) {
        const userId = interaction.user.id;
        global.ignSessions = global.ignSessions || {};
        let session = global.ignSessions[userId];

        if (!session) {
            const [rows] = await pool.execute('SELECT * FROM user_ign_config WHERE user_id = ?', [userId]);
            const existing = rows.length > 0 ? rows[0] : null;

            session = global.ignSessions[userId] = {
                lodestone_id: existing ? existing.lodestone_id : '',
                main_job: existing && existing.main_job ? existing.main_job : '',
                portrait_url: existing && existing.portrait_url ? existing.portrait_url : '',
                full_photo_url: existing && existing.full_photo_url ? existing.full_photo_url : '',
                portrait_toggle: existing ? Boolean(existing.portrait_toggle) : true,
                tomestone_url: existing && existing.tomestone_url ? existing.tomestone_url : '',
                fflogs_url: existing && existing.fflogs_url ? existing.fflogs_url : ''
            };
        }

        if (interaction.customId === 'ign_toggle_portrait') {
            if (session.portrait_toggle === true && (!session.full_photo_url || session.full_photo_url.trim() === '')) {
                return interaction.reply({
                    content: '⚠️ You cannot turn off the portrait unless a **Full Photo** has been added!',
                    flags: [MessageFlags.Ephemeral]
                });
            }

            await interaction.deferUpdate().catch(() => { });
            session.portrait_toggle = !session.portrait_toggle;
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false);
        }

        if (interaction.customId === 'ign_btn_main_job') {
            const roleSelect = new StringSelectMenuBuilder()
                .setCustomId('ign_select_role')
                .setPlaceholder('Select your main job role')
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('Tank').setValue('Tank').setDescription('Paladin, Warrior, Dark Knight, Gunbreaker'),
                    new StringSelectMenuOptionBuilder().setLabel('Healer').setValue('Healer').setDescription('White Mage, Scholar, Astrologian, Sage'),
                    new StringSelectMenuOptionBuilder().setLabel('Melee DPS').setValue('Melee').setDescription('Monk, Dragoon, Ninja, Samurai, Reaper, Viper'),
                    new StringSelectMenuOptionBuilder().setLabel('Physical Ranged DPS').setValue('Range').setDescription('Bard, Machinist, Dancer'),
                    new StringSelectMenuOptionBuilder().setLabel('Magical Caster DPS').setValue('Caster').setDescription('Black Mage, Summoner, Red Mage, Pictomancer')
                );

            const row = new ActionRowBuilder().addComponents(roleSelect);
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ign_btn_back_dashboard').setLabel('Back to Dashboard').setStyle(ButtonStyle.Secondary)
            );

            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle('⚔️ Select Main Job Role')
                .setDescription('Please choose your character role category from the dropdown below.');

            return interaction.update({ embeds: [embed], components: [row, backRow] }).catch(() => { });
        }

        if (interaction.customId === 'ign_btn_link') {
            const modal = new ModalBuilder()
                .setCustomId('ign_modal_link')
                .setTitle('Link Lodestone Character');

            const urlInput = new TextInputBuilder()
                .setCustomId('lodestone_url_input')
                .setLabel('Lodestone URL or ID')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://na.finalfantasyxiv.com/lodestone/character/12345678/')
                .setValue(session.lodestone_id ? `https://na.finalfantasyxiv.com/lodestone/character/${session.lodestone_id}/` : '')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'ign_btn_portrait') {
            const modal = new ModalBuilder()
                .setCustomId('ign_modal_portrait')
                .setTitle('Add Portrait');

            const portraitInput = new TextInputBuilder()
                .setCustomId('portrait_url_input')
                .setLabel('Portrait Direct URL')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('leave blank to use default')
                .setValue(session.portrait_url || '')
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(portraitInput));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'ign_btn_full_photo') {
            const modal = new ModalBuilder()
                .setCustomId('ign_modal_full_photo')
                .setTitle('Add Full Photo');

            const fullPhotoInput = new TextInputBuilder()
                .setCustomId('full_photo_url_input')
                .setLabel('Full Photo Direct URL')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('leave blank to use default')
                .setValue(session.full_photo_url || '')
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(fullPhotoInput));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'ign_btn_tomestone_link') {
            const modal = new ModalBuilder()
                .setCustomId('ign_modal_tomestone')
                .setTitle('Add Tomestone Link');

            const input = new TextInputBuilder()
                .setCustomId('tomestone_url_input')
                .setLabel('Tomestone URL (leave blank to clear)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://tomestone.gg/character/...')
                .setValue(session.tomestone_url || '')
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'ign_btn_fflogs_link') {
            const modal = new ModalBuilder()
                .setCustomId('ign_modal_fflogs')
                .setTitle('Add FFLogs Link');

            const input = new TextInputBuilder()
                .setCustomId('fflogs_url_input')
                .setLabel('FFLogs URL (leave blank to clear)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://www.fflogs.com/character/...')
                .setValue(session.fflogs_url || '')
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'ign_btn_back_dashboard') {
            return sendConfigDashboard(interaction, false);
        }

        if (interaction.customId === 'ign_btn_exit') {
            delete global.ignSessions[userId];
            await interaction.update({ content: 'Configuration session closed.', embeds: [], components: [] }).catch(() => { });
            setTimeout(() => {
                interaction.deleteReply().catch(() => { });
            }, 3000);
            return;
        }
    },

    async handleSelectMenu(interaction) {
        const userId = interaction.user.id;
        global.ignSessions = global.ignSessions || {};
        let session = global.ignSessions[userId];

        if (!session) return interaction.deferUpdate().catch(() => { });

        if (interaction.customId === 'ign_select_role') {
            const selectedRole = interaction.values[0];
            const jobs = ffxivJobs[selectedRole] || [];

            const jobSelect = new StringSelectMenuBuilder()
                .setCustomId('ign_select_job')
                .setPlaceholder(`Select your ${selectedRole} job`)
                .addOptions(jobs.map(job => new StringSelectMenuOptionBuilder().setLabel(job).setValue(job)));

            const row = new ActionRowBuilder().addComponents(jobSelect);
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ign_btn_main_job').setLabel('Back to Roles').setStyle(ButtonStyle.Secondary)
            );

            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle(`⚔️ Select ${selectedRole} Job`)
                .setDescription('Choose your specific main job from the dropdown below.');

            return interaction.update({ embeds: [embed], components: [row, backRow] }).catch(() => { });
        }

        if (interaction.customId === 'ign_select_job') {
            await interaction.deferUpdate().catch(() => { });
            session.main_job = interaction.values[0];
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false);
        }
    },

    async handleModal(interaction) {
        const userId = interaction.user.id;
        global.ignSessions = global.ignSessions || {};
        let session = global.ignSessions[userId];

        if (!session) {
            session = global.ignSessions[userId] = { lodestone_id: '', main_job: '', portrait_url: '', full_photo_url: '', portrait_toggle: true, tomestone_url: '', fflogs_url: '' };
        }

        if (interaction.customId === 'ign_modal_link') {
            await interaction.deferUpdate().catch(() => { });
            const rawInput = interaction.fields.getTextInputValue('lodestone_url_input');
            const extractedId = extractLodestoneId(rawInput);
            if (!extractedId) {
                return interaction.followUp({ content: '❌ Invalid Lodestone URL or ID format.', flags: [MessageFlags.Ephemeral] }).catch(() => { });
            }
            session.lodestone_id = extractedId;
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false);
        }

        if (interaction.customId === 'ign_modal_portrait') {
            await interaction.deferUpdate().catch(() => { });
            session.portrait_url = interaction.fields.getTextInputValue('portrait_url_input').trim();
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false);
        }

        if (interaction.customId === 'ign_modal_full_photo') {
            await interaction.deferUpdate().catch(() => { });
            session.full_photo_url = interaction.fields.getTextInputValue('full_photo_url_input').trim();
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false);
        }

        if (interaction.customId === 'ign_modal_tomestone') {
            await interaction.deferUpdate().catch(() => { });
            session.tomestone_url = interaction.fields.getTextInputValue('tomestone_url_input').trim();
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false);
        }

        if (interaction.customId === 'ign_modal_fflogs') {
            await interaction.deferUpdate().catch(() => { });
            session.fflogs_url = interaction.fields.getTextInputValue('fflogs_url_input').trim();
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false);
        }
    }
};

async function saveSessionToDb(userId, session) {
    const portrait = session.portrait_url ? session.portrait_url.trim() : null;
    const fullPhoto = session.full_photo_url ? session.full_photo_url.trim() : null;
    const mainJob = session.main_job ? session.main_job.trim() : null;
    const tomestoneUrl = session.tomestone_url ? session.tomestone_url.trim() : null;
    const fflogsUrl = session.fflogs_url ? session.fflogs_url.trim() : null;

    await pool.execute(
        `INSERT INTO user_ign_config (user_id, lodestone_id, main_job, portrait_url, full_photo_url, portrait_toggle, tomestone_url, fflogs_url) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
         lodestone_id = ?, main_job = ?, portrait_url = ?, full_photo_url = ?, portrait_toggle = ?, tomestone_url = ?, fflogs_url = ?`,
        [
            userId, session.lodestone_id, mainJob, portrait, fullPhoto, session.portrait_toggle, tomestoneUrl, fflogsUrl,
            session.lodestone_id, mainJob, portrait, fullPhoto, session.portrait_toggle, tomestoneUrl, fflogsUrl
        ]
    );
}

async function sendConfigDashboard(interaction, isInitial = false) {
    const userId = interaction.user.id;
    const session = global.ignSessions[userId];

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('⚙️ FFXIV Character Configuration Dashboard')
        .setDescription('Changes save automatically when you click buttons or submit modals.')
        .addFields(
            { name: '🔗 Lodestone ID', value: session.lodestone_id ? `\`${session.lodestone_id}\`` : '*Not set*', inline: false },
            { name: '⚔️ Main Job', value: session.main_job ? session.main_job : '*Not set*', inline: false },
            { name: '🖼️ Add Portrait', value: session.portrait_url ? session.portrait_url : '*Using Default*', inline: false },
            { name: '🌅 Add Full Photo', value: session.full_photo_url ? session.full_photo_url : '*None set*', inline: false },
            { name: '👁️ Portrait State', value: session.portrait_toggle ? '🟢 ON' : '🔴 OFF', inline: true },
            { name: '🏛️ Tomestone Link', value: session.tomestone_url ? session.tomestone_url : '*None set*', inline: false },
            { name: '📊 FFLogs Link', value: session.fflogs_url ? session.fflogs_url : '*None set*', inline: false }
        );

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ign_btn_link').setLabel('Link Lodestone').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ign_btn_main_job').setLabel('Main Job').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_btn_portrait').setLabel('Add Portrait').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_btn_full_photo').setLabel('Add Full Photo').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_toggle_portrait').setLabel(`Portrait: ${session.portrait_toggle ? 'ON' : 'OFF'}`).setStyle(session.portrait_toggle ? ButtonStyle.Success : ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ign_btn_tomestone_link').setLabel('Add Tomestone Link').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_btn_fflogs_link').setLabel('Add FFLogs Link').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_btn_exit').setLabel('Exit').setStyle(ButtonStyle.Danger)
    );

    if (isInitial) {
        return interaction.reply({ embeds: [embed], components: [row1, row2], flags: [MessageFlags.Ephemeral] }).catch(() => { });
    } else {
        if (interaction.deferred || interaction.replied) {
            return interaction.editReply({ embeds: [embed], components: [row1, row2] }).catch(() => { });
        }
        return interaction.update({ embeds: [embed], components: [row1, row2] }).catch(() => { });
    }
}