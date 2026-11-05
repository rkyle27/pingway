const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, AttachmentBuilder } = require('discord.js');
const welcome = require('../utils/welcome');

// /welcomehere (admins only): post welcome cards for new members in THIS channel, or turn them off.
// The design and message are changed on the website (server settings -> Welcome). Logic: utils/welcome.js.
module.exports = {
    data: new SlashCommandBuilder()
        .setName('welcomehere')
        .setDescription('👋 Post welcome cards for new members in this channel (admins only).')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false)
        .addStringOption(o => o.setName('action').setDescription('Turn welcome cards on here (default) or off.')
            .addChoices({ name: 'set', value: 'set' }, { name: 'off', value: 'off' })),

    async execute(interaction) {
        const reply = content => interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
        if (!interaction.inGuild() || !interaction.guild) return reply('❌ This command only works in a server.');
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return reply('❌ Only server admins (Administrator permission) can use this command.');
        }
        const guild = interaction.guild;
        const action = interaction.options.getString('action') || 'set';

        if (action === 'off') {
            try {
                await welcome.disable(guild.id, interaction.user.id);
                return reply('👋 Welcome cards are turned off. Use `/welcomehere` in a channel to turn them on again.');
            } catch (err) {
                console.error('❌ [WELCOME] /welcomehere off failed:', err.message);
                return reply('❌ Something went wrong. Please try again.');
            }
        }

        const channel = interaction.channel;
        const missing = welcome.missingPerms(guild, channel);
        if (!missing) return reply('❌ Use `/welcomehere` in a text or announcement channel.');
        if (missing.length) {
            return reply('❌ Pingway can\'t post welcome cards in <#' + interaction.channelId + '>. It is missing: **' + missing.join('**, **') + '**.\n' +
                'Give Pingway\'s role these permissions in this channel, then run `/welcomehere` again.');
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
            return interaction.editReply({ content: '❌ Something went wrong. Please try again.' }).catch(() => {});
        }
        const content = '👋 Welcome cards will be posted in <#' + interaction.channelId + '>. Change the design and message on the Pingway website (server settings → Welcome).';
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
