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
const { t, tOr, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');
const ignClaims = require('../utils/ignClaims'); // v2.2: Link Lodestone = claim with a code in the Lodestone profile
const { ownerHasMembership } = require('../utils/membership');
const { isHttpsUrl } = require('../utils/safeImage');
const ignLinks = require('../utils/ignLinks'); // Tomestone / FFLogs links must belong to the linked character

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

// Job values stay English (saved in the database, used by /ign); only the shown names are translated
const jobName = (job, lang) => tOr(lang, 'jobs.' + job, job);
const jobList = (role, lang) => (ffxivJobs[role] || []).map(j => jobName(j, lang)).join(', ');
const roleName = (role, lang) => tOr(lang, 'ignconfig.roleShort.' + role, role);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ignconfig')
        .setDescription(t('en', 'ignconfig.cmd.description')).setDescriptionLocalizations(discordLocalizations('ignconfig.cmd.description')),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
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

        return sendConfigDashboard(interaction, true, lang);
    },

    async handleButton(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
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
                    content: t(lang, 'ignconfig.needPhoto'),
                    flags: [MessageFlags.Ephemeral]
                });
            }

            await interaction.deferUpdate().catch(() => { });
            session.portrait_toggle = !session.portrait_toggle;
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false, lang);
        }

        if (interaction.customId === 'ign_btn_main_job') {
            const roleSelect = new StringSelectMenuBuilder()
                .setCustomId('ign_select_role')
                .setPlaceholder(t(lang, 'ignconfig.selectRole'))
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel(t(lang, 'ignconfig.roles.tank')).setValue('Tank').setDescription(jobList('Tank', lang)),
                    new StringSelectMenuOptionBuilder().setLabel(t(lang, 'ignconfig.roles.healer')).setValue('Healer').setDescription(jobList('Healer', lang)),
                    new StringSelectMenuOptionBuilder().setLabel(t(lang, 'ignconfig.roles.melee')).setValue('Melee').setDescription(jobList('Melee', lang)),
                    new StringSelectMenuOptionBuilder().setLabel(t(lang, 'ignconfig.roles.ranged')).setValue('Range').setDescription(jobList('Range', lang)),
                    new StringSelectMenuOptionBuilder().setLabel(t(lang, 'ignconfig.roles.caster')).setValue('Caster').setDescription(jobList('Caster', lang))
                );

            const row = new ActionRowBuilder().addComponents(roleSelect);
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ign_btn_back_dashboard').setLabel(t(lang, 'ignconfig.backDashboard')).setStyle(ButtonStyle.Secondary)
            );

            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle(t(lang, 'ignconfig.selectRoleTitle'))
                .setDescription(t(lang, 'ignconfig.selectRoleHelp'));

            return interaction.update({ embeds: [embed], components: [row, backRow] }).catch(() => { });
        }

        if (interaction.customId === 'ign_btn_link') {
            const modal = new ModalBuilder()
                .setCustomId('ign_modal_link')
                .setTitle(t(lang, 'ignconfig.linkTitle'));

            const urlInput = new TextInputBuilder()
                .setCustomId('lodestone_url_input')
                .setLabel(t(lang, 'ignconfig.lodestoneLabel'))
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
                .setTitle(t(lang, 'ignconfig.portraitTitle'));

            const portraitInput = new TextInputBuilder()
                .setCustomId('portrait_url_input')
                .setLabel(t(lang, 'ignconfig.portraitLabel'))
                .setStyle(TextInputStyle.Short)
                .setPlaceholder(t(lang, 'ignconfig.leaveBlank'))
                .setValue(session.portrait_url || '')
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(portraitInput));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'ign_btn_full_photo') {
            const modal = new ModalBuilder()
                .setCustomId('ign_modal_full_photo')
                .setTitle(t(lang, 'ignconfig.photoTitle'));

            const fullPhotoInput = new TextInputBuilder()
                .setCustomId('full_photo_url_input')
                .setLabel(t(lang, 'ignconfig.photoLabel'))
                .setStyle(TextInputStyle.Short)
                .setPlaceholder(t(lang, 'ignconfig.leaveBlank'))
                .setValue(session.full_photo_url || '')
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(fullPhotoInput));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'ign_btn_tomestone_link') {
            const modal = new ModalBuilder()
                .setCustomId('ign_modal_tomestone')
                .setTitle(t(lang, 'ignconfig.tomestoneTitle'));

            const input = new TextInputBuilder()
                .setCustomId('tomestone_url_input')
                .setLabel(t(lang, 'ignconfig.tomestoneLabel'))
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
                .setTitle(t(lang, 'ignconfig.fflogsTitle'));

            const input = new TextInputBuilder()
                .setCustomId('fflogs_url_input')
                .setLabel(t(lang, 'ignconfig.fflogsLabel'))
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('https://www.fflogs.com/character/...')
                .setValue(session.fflogs_url || '')
                .setRequired(false);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (interaction.customId === 'ign_btn_verify') {
            await interaction.deferUpdate().catch(() => { });
            const perks = await ownerHasMembership(userId);
            const r = await ignClaims.checkClaim(pool, userId, null, { perks, makeMain: true });
            if (!r.ok) return interaction.followUp({ content: claimReason(r, lang), flags: [MessageFlags.Ephemeral] }).catch(() => { });
            global.ignSessions[userId] = await loadSession(userId);
            await sendConfigDashboard(interaction, false, lang);
            return interaction.followUp({ content: t(lang, r.moved ? 'ignconfig.claim.verifiedMoved' : 'ignconfig.claim.verified', { name: r.name || r.lodestoneId }), flags: [MessageFlags.Ephemeral] }).catch(() => { });
        }

        if (interaction.customId === 'ign_btn_back_dashboard') {
            return sendConfigDashboard(interaction, false, lang);
        }

        if (interaction.customId === 'ign_btn_exit') {
            delete global.ignSessions[userId];
            await interaction.update({ content: t(lang, 'ignconfig.closed'), embeds: [], components: [] }).catch(() => { });
            setTimeout(() => {
                interaction.deleteReply().catch(() => { });
            }, 3000);
            return;
        }
    },

    async handleSelectMenu(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        const userId = interaction.user.id;
        global.ignSessions = global.ignSessions || {};
        let session = global.ignSessions[userId];

        if (!session) return interaction.deferUpdate().catch(() => { });

        if (interaction.customId === 'ign_select_role') {
            const selectedRole = interaction.values[0];
            const jobs = ffxivJobs[selectedRole] || [];

            const jobSelect = new StringSelectMenuBuilder()
                .setCustomId('ign_select_job')
                .setPlaceholder(t(lang, 'ignconfig.selectJob', { role: roleName(selectedRole, lang) }))
                .addOptions(jobs.map(job => new StringSelectMenuOptionBuilder().setLabel(jobName(job, lang)).setValue(job)));

            const row = new ActionRowBuilder().addComponents(jobSelect);
            const backRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('ign_btn_main_job').setLabel(t(lang, 'ignconfig.backRoles')).setStyle(ButtonStyle.Secondary)
            );

            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle(t(lang, 'ignconfig.selectJobTitle', { role: roleName(selectedRole, lang) }))
                .setDescription(t(lang, 'ignconfig.selectJobHelp'));

            return interaction.update({ embeds: [embed], components: [row, backRow] }).catch(() => { });
        }

        if (interaction.customId === 'ign_select_job') {
            await interaction.deferUpdate().catch(() => { });
            session.main_job = interaction.values[0];
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false, lang);
        }
    },

    async handleModal(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
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
                return interaction.followUp({ content: t(lang, 'ignconfig.invalidLodestone'), flags: [MessageFlags.Ephemeral] }).catch(() => { });
            }
            // v2.2: a character is only linked after the claim code is found in its Lodestone profile (ign_btn_verify)
            const perks = await ownerHasMembership(userId);
            const claim = await ignClaims.startClaim(pool, userId, extractedId, { perks });
            if (!claim.ok && claim.reason === 'alreadyYours') {
                await ignClaims.setMain(pool, userId, extractedId);
                global.ignSessions[userId] = await loadSession(userId);
                await sendConfigDashboard(interaction, false, lang);
                return interaction.followUp({ content: t(lang, 'ignconfig.claim.madeMain'), flags: [MessageFlags.Ephemeral] }).catch(() => { });
            }
            if (!claim.ok) return interaction.followUp({ content: claimReason(claim, lang), flags: [MessageFlags.Ephemeral] }).catch(() => { });
            return sendClaimPrompt(interaction, claim, lang);
        }

        if (interaction.customId === 'ign_modal_portrait') {
            await interaction.deferUpdate().catch(() => { });
            const portraitInput = interaction.fields.getTextInputValue('portrait_url_input').trim();
            if (portraitInput && !isHttpsUrl(portraitInput)) {
                return interaction.followUp({ content: t(lang, 'ignconfig.invalidImageUrl'), flags: [MessageFlags.Ephemeral] }).catch(() => { });
            }
            session.portrait_url = portraitInput;
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false, lang);
        }

        if (interaction.customId === 'ign_modal_full_photo') {
            await interaction.deferUpdate().catch(() => { });
            const photoInput = interaction.fields.getTextInputValue('full_photo_url_input').trim();
            if (photoInput && !isHttpsUrl(photoInput)) {
                return interaction.followUp({ content: t(lang, 'ignconfig.invalidImageUrl'), flags: [MessageFlags.Ephemeral] }).catch(() => { });
            }
            session.full_photo_url = photoInput;
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false, lang);
        }

        if (interaction.customId === 'ign_modal_tomestone' || interaction.customId === 'ign_modal_fflogs') {
            await interaction.deferUpdate().catch(() => { });
            const kind = interaction.customId === 'ign_modal_tomestone' ? 'tomestone' : 'fflogs';
            const input = interaction.fields.getTextInputValue(kind + '_url_input').trim();
            let url = '';
            if (input) {
                // must be the link of the linked character (utils/ignLinks.js); otherwise the old link stays
                const r = ignLinks.check(input, kind, await linkCharacter(userId, session.lodestone_id));
                if (!r.ok) return interaction.followUp({ content: linkError(r, kind, lang), flags: [MessageFlags.Ephemeral] }).catch(() => { });
                url = r.normalizedUrl;
            }
            session[kind + '_url'] = url;
            await saveSessionToDb(userId, session);
            return sendConfigDashboard(interaction, false, lang);
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
    // v2.2: the same fields on the claimed character (website IGN Card)
    await ignClaims.syncFromConfig(pool, userId).catch(err => console.error('❌ [IGN] Sync failed:', err.message));
}

async function sendConfigDashboard(interaction, isInitial = false, lang = 'en') {
    const userId = interaction.user.id;
    const session = global.ignSessions[userId];
    // a saved link that isn't this character's is not shown on the card: a short note says so
    const character = (session.tomestone_url || session.fflogs_url) ? await linkCharacter(userId, session.lodestone_id) : null;
    const linkValue = kind => {
        const url = session[kind + '_url'];
        if (!url) return t(lang, 'ignconfig.noneSet');
        return ignLinks.usable(url, kind, character) ? url : url + '\n' + t(lang, 'ignconfig.links.mismatch.' + kind);
    };

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(t(lang, 'ignconfig.dashTitle'))
        .setDescription(t(lang, 'ignconfig.dashHelp'))
        .addFields(
            { name: t(lang, 'ignconfig.fields.lodestone'), value: session.lodestone_id ? `\`${session.lodestone_id}\`` : t(lang, 'ignconfig.notSet'), inline: false },
            { name: t(lang, 'ignconfig.fields.mainJob'), value: session.main_job ? jobName(session.main_job, lang) : t(lang, 'ignconfig.notSet'), inline: false },
            { name: t(lang, 'ignconfig.fields.portrait'), value: session.portrait_url ? session.portrait_url : t(lang, 'ignconfig.usingDefault'), inline: false },
            { name: t(lang, 'ignconfig.fields.photo'), value: session.full_photo_url ? session.full_photo_url : t(lang, 'ignconfig.noneSet'), inline: false },
            { name: t(lang, 'ignconfig.fields.portraitState'), value: session.portrait_toggle ? t(lang, 'ignconfig.on') : t(lang, 'ignconfig.off'), inline: true },
            { name: t(lang, 'ignconfig.fields.tomestone'), value: linkValue('tomestone'), inline: false },
            { name: t(lang, 'ignconfig.fields.fflogs'), value: linkValue('fflogs'), inline: false }
        );

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ign_btn_link').setLabel(t(lang, 'ignconfig.btn.link')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ign_btn_main_job').setLabel(t(lang, 'ignconfig.btn.mainJob')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_btn_portrait').setLabel(t(lang, 'ignconfig.btn.portrait')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_btn_full_photo').setLabel(t(lang, 'ignconfig.btn.photo')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_toggle_portrait').setLabel(t(lang, 'ignconfig.btn.portraitToggle', { state: session.portrait_toggle ? t(lang, 'ignconfig.btn.on') : t(lang, 'ignconfig.btn.off') })).setStyle(session.portrait_toggle ? ButtonStyle.Success : ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ign_btn_tomestone_link').setLabel(t(lang, 'ignconfig.btn.tomestone')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_btn_fflogs_link').setLabel(t(lang, 'ignconfig.btn.fflogs')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ign_btn_exit').setLabel(t(lang, 'ignconfig.btn.exit')).setStyle(ButtonStyle.Danger)
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

// ---------- Tomestone / FFLogs links (utils/ignLinks.js) ----------
// The character the links must belong to: the linked Lodestone id + the name / world read from the Lodestone when it was
// claimed (ign_characters). An older, not verified card has no name / world yet: only Lodestone-id links can be checked.
async function linkCharacter(userId, lodestoneId) {
    const id = lodestoneId ? String(lodestoneId) : '';
    let row = null;
    if (id) {
        try { row = (await ignClaims.listCharacters(pool, userId)).find(r => String(r.lodestone_id) === id) || null; } catch (e) { row = null; }
    }
    return { lodestoneId: id, name: (row && row.character_name) || '', world: (row && row.world) || '' };
}

function linkError(r, kind, lang) {
    if (r.code === 'not_https') return t(lang, 'ignconfig.links.notHttps');
    if (r.code === 'wrong_site') return t(lang, 'ignconfig.links.wrongSite.' + kind);
    if (r.code === 'wrong_character') return t(lang, 'ignconfig.links.wrongCharacter.' + kind);
    if (r.code === 'wrong_world') return t(lang, 'ignconfig.links.wrongWorld');
    if (r.code === 'unverifiable_id') return t(lang, 'ignconfig.links.unverifiableId', { link: r.suggest || 'https://www.fflogs.com/character/lodestone-id/…' });
    return t(lang, 'ignconfig.links.badFormat.' + kind);
}

// ---------- v2.2 claim (Link Lodestone) ----------
async function loadSession(userId) {
    const [rows] = await pool.execute('SELECT * FROM user_ign_config WHERE user_id = ?', [userId]);
    const existing = rows.length > 0 ? rows[0] : null;
    return {
        lodestone_id: existing ? existing.lodestone_id : '',
        main_job: existing && existing.main_job ? existing.main_job : '',
        portrait_url: existing && existing.portrait_url ? existing.portrait_url : '',
        full_photo_url: existing && existing.full_photo_url ? existing.full_photo_url : '',
        portrait_toggle: existing ? Boolean(existing.portrait_toggle) : true,
        tomestone_url: existing && existing.tomestone_url ? existing.tomestone_url : '',
        fflogs_url: existing && existing.fflogs_url ? existing.fflogs_url : ''
    };
}

function claimReason(r, lang) {
    if (r.reason === 'limit') return r.perks ? t(lang, 'ignconfig.claim.limitMax', { max: r.max }) : t(lang, 'ignconfig.claim.limitFree', { free: r.free, max: r.max });
    if (r.reason === 'wait') return t(lang, 'ignconfig.claim.reason.wait', { n: r.seconds || 15 });
    return tOr(lang, 'ignconfig.claim.reason.' + r.reason, t(lang, 'ignconfig.claim.reason.error'));
}

async function sendClaimPrompt(interaction, claim, lang) {
    const embed = new EmbedBuilder()
        .setColor(0x9b6bff)
        .setTitle(t(lang, 'ignconfig.claim.title'))
        .setDescription(t(lang, 'ignconfig.claim.steps', {
            code: claim.code,
            link: 'https://na.finalfantasyxiv.com/lodestone/character/' + claim.lodestoneId + '/',
            expires: '<t:' + Math.floor(claim.expiresAt / 1000) + ':R>'
        }));
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ign_btn_verify').setLabel(t(lang, 'ignconfig.claim.btnVerify')).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ign_btn_back_dashboard').setLabel(t(lang, 'ignconfig.backDashboard')).setStyle(ButtonStyle.Secondary)
    );
    if (interaction.deferred || interaction.replied) return interaction.editReply({ embeds: [embed], components: [row] }).catch(() => { });
    return interaction.update({ embeds: [embed], components: [row] }).catch(() => { });
}
