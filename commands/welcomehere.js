const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, AttachmentBuilder } = require('discord.js');
const welcome = require('../utils/welcome');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// /welcomehere (admins only): post welcome cards for new members in THIS channel, or turn them off.
// The design and message are changed on the website (server settings -> Welcome). Logic: utils/welcome.js.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('welcomehere')
        .setDescription(t('en', 'welcome.cmd.description')).setDescriptionLocalizations(discordLocalizations('welcome.cmd.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addStringOption(o => o.setName('action').setDescription(t('en', 'welcome.cmd.action')).setDescriptionLocalizations(discordLocalizations('welcome.cmd.action'))
            .addChoices({ name: 'set', value: 'set' }, { name: 'off', value: 'off' })),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        const reply = content => interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
        if (!interaction.inGuild() || !interaction.guild) return reply(t(lang, 'welcome.serverOnly'));
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return reply(t(lang, 'welcome.adminsOnly'));
        }
        const guild = interaction.guild;
        const action = interaction.options.getString('action') || 'set';

        if (action === 'off') {
            try {
                await welcome.disable(guild.id, interaction.user.id);
                return reply(t(lang, 'welcome.turnedOff'));
            } catch (err) {
                console.error('❌ [WELCOME] /welcomehere off failed:', err.message);
                return reply(t(lang, 'welcome.failed'));
            }
        }

        const channel = interaction.channel;
        const missing = welcome.missingPerms(guild, channel);
        if (!missing) return reply(t(lang, 'welcome.wrongChannel'));
        if (missing.length) {
            return reply(t(lang, 'welcome.missingPerms', { channelId: interaction.channelId, perms: missing.map(m => welcome.permLabel(m, lang)).join('**, **') }));
        }

        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        } catch (err) {
            return; // interaction expired (slow host)
        }
        try {
            await welcome.enableHere(guild.id, interaction.channelId, interaction.user.id);
        } catch (err) {
            console.error('❌ [WELCOME] /welcomehere set failed:', err.message);
            return interaction.editReply({ content: t(lang, 'welcome.failed') }).catch(() => {});
        }
        const content = t(lang, 'welcome.enabled', { channelId: interaction.channelId });
        let files = [];
        try {
            const member = interaction.member && typeof interaction.member.displayAvatarURL === 'function'
                ? interaction.member
                : await guild.members.fetch(interaction.user.id);
            const { png } = await welcome.previewFor(member, guild);
            files = [new AttachmentBuilder(png, { name: 'welcome-preview.png' })];
        } catch (err) {
            console.error('⚠️ [WELCOME] Preview failed:', err.message);
        }
        return interaction.editReply({ content, files }).catch(() => {});
    }
};
