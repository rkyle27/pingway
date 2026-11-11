const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const honeypot = require('../utils/honeypot');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

// One command, options only (no sub-commands): /honeypot action: <Set channel | Turn off | DM alerts | Warning message | Status>
// channel: (needed for Set channel) · on: True/False (needed for DM alerts and Warning message)
const ACTIONS = ['set', 'off', 'dm', 'warning', 'status'];

module.exports = {
    ACTIONS,
    data: new SlashCommandBuilder()
        .setName('honeypot')
        .setDescription(t('en', 'honeypot.cmd.description')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .setDMPermission(false)
        .addStringOption(o => o.setName('action').setNameLocalizations(discordLocalizations('honeypot.cmd.actionName'))
            .setDescription(t('en', 'honeypot.cmd.action')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.action')).setRequired(true)
            .addChoices(...ACTIONS.map(value => ({ name: t('en', 'honeypot.cmd.actions.' + value), name_localizations: discordLocalizations('honeypot.cmd.actions.' + value), value }))))
        .addChannelOption(o => o.setName('channel').setNameLocalizations(discordLocalizations('honeypot.cmd.channelName'))
            .setDescription(t('en', 'honeypot.cmd.channel')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.channel')).setRequired(false)
            .addChannelTypes(ChannelType.GuildText))
        .addBooleanOption(o => o.setName('on').setNameLocalizations(discordLocalizations('honeypot.cmd.onName'))
            .setDescription(t('en', 'honeypot.cmd.on')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.on')).setRequired(false)),

    async execute(interaction) {
        const sub = interaction.options.getString('action', true);
        const guild = interaction.guild;
        const lang = await userLanguage.forInteraction(interaction);
        const reply = content => interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
        // Which options go with which action (friendly message instead of guessing)
        const channelOpt = interaction.options.getChannel('channel', false);
        const onOpt = interaction.options.getBoolean('on', false);
        const hasOn = onOpt !== null && onOpt !== undefined;
        if (sub === 'set' && !channelOpt) return reply(t(lang, 'honeypot.needChannel'));
        if (sub !== 'set' && channelOpt) return reply(t(lang, 'honeypot.onlyChannel'));
        if ((sub === 'dm' || sub === 'warning') && !hasOn) return reply(t(lang, 'honeypot.needOn', { action: t(lang, 'honeypot.cmd.actions.' + sub) }));
        if (sub !== 'dm' && sub !== 'warning' && hasOn) return reply(t(lang, 'honeypot.onlyOn'));
        try {
            const me = guild.members.me;
            const canBan = me && me.permissions.has(PermissionFlagsBits.BanMembers);
            const canDelete = me && me.permissions.has(PermissionFlagsBits.ManageMessages);
            const permNote = (!canBan || !canDelete)
                ? t(lang, 'honeypot.missingPerms', { perms: [!canBan && t(lang, 'honeypot.perms.ban'), !canDelete && t(lang, 'honeypot.perms.manage')].filter(Boolean).join(t(lang, 'honeypot.and')) })
                : '';

            if (sub === 'set') {
                const channel = channelOpt;
                await honeypot.setChannel(interaction.client, guild.id, channel.id);
                const trapNow = honeypot.getTrap(guild.id);
                return reply(t(lang, 'honeypot.isNow', { channelId: channel.id, posted: trapNow && !trapNow.warning ? '' : t(lang, 'honeypot.posted'), permNote }));
            }
            if (sub === 'off') {
                await honeypot.setChannel(interaction.client, guild.id, null);
                return reply(t(lang, 'honeypot.turnedOff'));
            }
            if (sub === 'dm') {
                const on = onOpt;
                await honeypot.setDm(guild.id, on);
                return reply(on ? t(lang, 'honeypot.dmOn') : t(lang, 'honeypot.dmOff'));
            }
            if (sub === 'warning') {
                const on = onOpt;
                await honeypot.setWarning(interaction.client, guild.id, on);
                return reply(on
                    ? t(lang, 'honeypot.warningOn')
                    : t(lang, 'honeypot.warningOff'));
            }
            const trap = honeypot.getTrap(guild.id);
            return reply(trap
                ? t(lang, 'honeypot.status', { channelId: trap.channelId, dm: trap.dm ? t(lang, 'honeypot.on') : t(lang, 'honeypot.off'), warning: trap.warning ? t(lang, 'honeypot.on') : t(lang, 'honeypot.off'), permNote })
                : t(lang, 'honeypot.statusOff', { permNote }));
        } catch (err) {
            console.error('❌ [HONEYPOT] Command failed:', err.message);
            return reply(t(lang, 'honeypot.failed'));
        }
    }
};
