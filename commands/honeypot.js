const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const honeypot = require('../utils/honeypot');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('honeypot')
        .setDescription('🍯 "Do not chat here" channel that removes hacked accounts.')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .setDMPermission(false)
        .addSubcommand(s => s.setName('set').setDescription('Use a channel as the honeypot (Pingway posts a warning there).')
            .addChannelOption(o => o.setName('channel').setDescription('The do-not-chat channel').setRequired(true)
                .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(s => s.setName('off').setDescription('Turn the honeypot off.'))
        .addSubcommand(s => s.setName('dm').setDescription('DM caught members that their account may be hacked.')
            .addBooleanOption(o => o.setName('on').setDescription('Send the DM?').setRequired(true)))
        .addSubcommand(s => s.setName('warning').setDescription('Post Pingway\'s "do not post here" warning in the honeypot channel.')
            .addBooleanOption(o => o.setName('on').setDescription('Show the warning?').setRequired(true)))
        .addSubcommand(s => s.setName('status').setDescription('Show the honeypot settings.')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guild = interaction.guild;
        const reply = content => interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
        try {
            const me = guild.members.me;
            const canBan = me && me.permissions.has(PermissionFlagsBits.BanMembers);
            const canDelete = me && me.permissions.has(PermissionFlagsBits.ManageMessages);
            const permNote = (!canBan || !canDelete)
                ? '\n\n⚠️ Pingway is missing **' + [!canBan && 'Ban Members', !canDelete && 'Manage Messages'].filter(Boolean).join(' and ') +
                  '**. Give its role these permissions, or caught members can\'t be removed.'
                : '';

            if (sub === 'set') {
                const channel = interaction.options.getChannel('channel', true);
                await honeypot.setChannel(interaction.client, guild.id, channel.id);
                const t = honeypot.getTrap(guild.id);
                return reply('🍯 <#' + channel.id + '> is now the honeypot.' + (t && !t.warning ? '' : ' Pingway posted a warning there.') + ' Anyone except staff who posts in it is softbanned ' +
                    '(removed, with their messages from the last hour deleted; they can rejoin later).' + permNote);
            }
            if (sub === 'off') {
                await honeypot.setChannel(interaction.client, guild.id, null);
                return reply('🍯 Honeypot turned off. You can delete the warning message in the old channel.');
            }
            if (sub === 'dm') {
                const on = interaction.options.getBoolean('on', true);
                await honeypot.setDm(guild.id, on);
                return reply(on ? '📨 Caught members will get a DM saying their account may be hacked.' : '📨 No DM will be sent to caught members.');
            }
            if (sub === 'warning') {
                const on = interaction.options.getBoolean('on', true);
                await honeypot.setWarning(interaction.client, guild.id, on);
                return reply(on
                    ? '🚫 Pingway will post its "do not post here" warning in the honeypot channel.'
                    : '🚫 Pingway\'s warning is off (and removed if it was posted). Make sure your channel tells members not to post there, or they may be softbanned by mistake.');
            }
            const trap = honeypot.getTrap(guild.id);
            return reply(trap
                ? '🍯 Honeypot: <#' + trap.channelId + '> · DM: ' + (trap.dm ? 'on' : 'off') + ' · Warning: ' + (trap.warning ? 'on' : 'off') + '\nSee the list of caught members on the Pingway website (server settings).' + permNote
                : '🍯 The honeypot is off. Use `/honeypot set` to choose a channel.' + permNote);
        } catch (err) {
            console.error('❌ [HONEYPOT] Command failed:', err.message);
            return reply('❌ Something went wrong. Please try again.');
        }
    }
};
