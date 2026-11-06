const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const honeypot = require('../utils/honeypot');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('honeypot')
        .setDescription(t('en', 'honeypot.cmd.description')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.description'))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .setDMPermission(false)
        .addSubcommand(s => s.setName('set').setDescription(t('en', 'honeypot.cmd.set')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.set'))
            .addChannelOption(o => o.setName('channel').setDescription(t('en', 'honeypot.cmd.channel')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.channel')).setRequired(true)
                .addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(s => s.setName('off').setDescription(t('en', 'honeypot.cmd.off')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.off')))
        .addSubcommand(s => s.setName('dm').setDescription(t('en', 'honeypot.cmd.dm')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.dm'))
            .addBooleanOption(o => o.setName('on').setDescription(t('en', 'honeypot.cmd.dmOn')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.dmOn')).setRequired(true)))
        .addSubcommand(s => s.setName('warning').setDescription(t('en', 'honeypot.cmd.warning')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.warning'))
            .addBooleanOption(o => o.setName('on').setDescription(t('en', 'honeypot.cmd.warningOn')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.warningOn')).setRequired(true)))
        .addSubcommand(s => s.setName('status').setDescription(t('en', 'honeypot.cmd.status')).setDescriptionLocalizations(discordLocalizations('honeypot.cmd.status'))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guild = interaction.guild;
        const lang = await userLanguage.forInteraction(interaction);
        const reply = content => interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
        try {
            const me = guild.members.me;
            const canBan = me && me.permissions.has(PermissionFlagsBits.BanMembers);
            const canDelete = me && me.permissions.has(PermissionFlagsBits.ManageMessages);
            const permNote = (!canBan || !canDelete)
                ? t(lang, 'honeypot.missingPerms', { perms: [!canBan && t(lang, 'honeypot.perms.ban'), !canDelete && t(lang, 'honeypot.perms.manage')].filter(Boolean).join(t(lang, 'honeypot.and')) })
                : '';

            if (sub === 'set') {
                const channel = interaction.options.getChannel('channel', true);
                await honeypot.setChannel(interaction.client, guild.id, channel.id);
                const trapNow = honeypot.getTrap(guild.id);
                return reply(t(lang, 'honeypot.isNow', { channelId: channel.id, posted: trapNow && !trapNow.warning ? '' : t(lang, 'honeypot.posted'), permNote }));
            }
            if (sub === 'off') {
                await honeypot.setChannel(interaction.client, guild.id, null);
                return reply(t(lang, 'honeypot.turnedOff'));
            }
            if (sub === 'dm') {
                const on = interaction.options.getBoolean('on', true);
                await honeypot.setDm(guild.id, on);
                return reply(on ? t(lang, 'honeypot.dmOn') : t(lang, 'honeypot.dmOff'));
            }
            if (sub === 'warning') {
                const on = interaction.options.getBoolean('on', true);
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
