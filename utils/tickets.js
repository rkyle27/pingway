// Ticket system (help desk). Set up on the website (server settings -> Tickets); free for every server.
// Pingway creates a "Tickets" category with an "open-a-ticket" channel (with the Open Ticket button) and a
// private "ticket-logs" channel. Each ticket is a private channel only the member and the support roles can see.
// Closing a ticket saves a text transcript to ticket-logs (if turned on) and deletes the ticket channel.
// The transcript is a file posted in the server's own ticket-logs channel: Pingway does not keep a copy.

const {
    Events, ChannelType, PermissionFlagsBits, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder
} = require('discord.js');
const { pool } = require('./db');

const RELOAD_MS = 60 * 1000;
const P = PermissionFlagsBits;
const DEFAULT_PANEL = 'Need help? Click **Open Ticket** to talk privately with the staff team.';
const DEFAULT_WELCOME = 'Thanks for opening a ticket! Tell us what you need, and a staff member will help you soon.';
const TRANSCRIPT_MAX_MESSAGES = 2000;
// Retention (owner decision): closed tickets in the tickets table (who opened/closed/claimed, the request text, times)
// are kept for 180 days after closing, then deleted automatically. Open tickets are never deleted.
// Transcripts are only in the server's Discord ticket-logs channel (owned by the server), so they are not touched.
const RETENTION_DAYS = 180;
const CLEANUP_FIRST_MS = 2 * 60 * 1000;
const CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH = 1000;

let tablesReady = false;
let started = false;
let loading = false;
let settings = new Map(); // guildId -> settings row
const busy = new Set();   // guildId:userId opening a ticket right now

async function ensureTables() {
    if (tablesReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS ticket_settings (
        guild_id VARCHAR(32) PRIMARY KEY,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        support_roles TEXT,
        max_open INT NOT NULL DEFAULT 1,
        welcome TEXT,
        panel_text TEXT,
        transcripts TINYINT(1) NOT NULL DEFAULT 1,
        category_id VARCHAR(32) DEFAULT NULL,
        panel_channel_id VARCHAR(32) DEFAULT NULL,
        panel_message_id VARCHAR(32) DEFAULT NULL,
        log_channel_id VARCHAR(32) DEFAULT NULL,
        counter INT NOT NULL DEFAULT 0,
        status VARCHAR(160) DEFAULT NULL,
        updated_at BIGINT NOT NULL DEFAULT 0,
        synced_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS tickets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(32) NOT NULL,
        number INT NOT NULL,
        channel_id VARCHAR(32) DEFAULT NULL,
        user_id VARCHAR(32) NOT NULL,
        claimed_by VARCHAR(32) DEFAULT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'open',
        reason VARCHAR(500) DEFAULT NULL,
        created_at BIGINT NOT NULL,
        closed_at BIGINT DEFAULT NULL,
        closed_by VARCHAR(32) DEFAULT NULL,
        KEY idx_guild_user (guild_id, user_id, status),
        KEY idx_channel (channel_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    tablesReady = true;
}

const supportRoles = s => {
    try {
        const list = JSON.parse(s.support_roles || '[]');
        return Array.isArray(list) ? list.map(String) : [];
    } catch (e) {
        return [];
    }
};

async function setStatus(guildId, s, status) {
    if (s.status === status) return;
    s.status = status;
    await pool.execute('UPDATE ticket_settings SET status = ? WHERE guild_id = ?', [status, guildId]).catch(() => {});
}

function panelPayload(s) {
    const embed = new EmbedBuilder().setColor('#5865f2').setTitle('🎫 Support Tickets')
        .setDescription(Number(s.enabled) === 1 ? (s.panel_text || DEFAULT_PANEL) : 'Tickets are closed right now. Please check back later.');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pwtk:open').setLabel('Open Ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary)
            .setDisabled(Number(s.enabled) !== 1)
    );
    return { embeds: [embed], components: [row] };
}

// Create (or repair) the category, channels and panel message so they match the website settings
async function setup(client, guild, s) {
    const me = guild.members.me;
    if (!me || !me.permissions.has(P.ManageChannels) || !me.permissions.has(P.ManageRoles)) {
        return setStatus(guild.id, s, 'Pingway needs the Manage Channels and Manage Roles permissions');
    }
    const roles = supportRoles(s).filter(id => guild.roles.cache.has(id));
    const botAllow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles, P.ManageChannels];
    const staffAllow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
    try {
        let category = s.category_id && guild.channels.cache.get(s.category_id);
        if (!category) {
            category = await guild.channels.create({
                name: '🎫 Tickets', type: ChannelType.GuildCategory, reason: 'Pingway ticket system',
                permissionOverwrites: [
                    { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
                    { id: client.user.id, allow: botAllow }
                ]
            });
            s.category_id = category.id;
        }
        let panel = s.panel_channel_id && guild.channels.cache.get(s.panel_channel_id);
        if (!panel) {
            panel = await guild.channels.create({
                name: 'open-a-ticket', type: ChannelType.GuildText, parent: category.id, reason: 'Pingway ticket system',
                permissionOverwrites: [
                    { id: guild.roles.everyone.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads] },
                    { id: client.user.id, allow: botAllow }
                ]
            });
            s.panel_channel_id = panel.id;
            s.panel_message_id = null;
        }
        const logOverwrites = [
            { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
            { id: client.user.id, allow: botAllow },
            ...roles.map(id => ({ id, allow: [P.ViewChannel, P.ReadMessageHistory] }))
        ];
        let log = s.log_channel_id && guild.channels.cache.get(s.log_channel_id);
        if (!log) {
            log = await guild.channels.create({
                name: 'ticket-logs', type: ChannelType.GuildText, parent: category.id, reason: 'Pingway ticket system',
                permissionOverwrites: logOverwrites
            });
            s.log_channel_id = log.id;
        } else {
            await log.permissionOverwrites.set(logOverwrites, 'Pingway ticket system: support roles changed').catch(() => {});
        }

        let panelMessage = null;
        if (s.panel_message_id) panelMessage = await panel.messages.fetch(s.panel_message_id).catch(() => null);
        if (panelMessage) await panelMessage.edit(panelPayload(s));
        else {
            panelMessage = await panel.send(panelPayload(s));
            s.panel_message_id = panelMessage.id;
        }

        await pool.execute(
            'UPDATE ticket_settings SET category_id = ?, panel_channel_id = ?, panel_message_id = ?, log_channel_id = ?, synced_at = ? WHERE guild_id = ?',
            [s.category_id, s.panel_channel_id, s.panel_message_id, s.log_channel_id, s.updated_at, guild.id]
        );
        s.synced_at = s.updated_at;
        await setStatus(guild.id, s, 'ok');
        console.log('🎫 [TICKETS] Set up / updated in ' + guild.name + '.');
    } catch (err) {
        console.error('❌ [TICKETS] Setup failed in ' + guild.name + ':', err.message);
        await setStatus(guild.id, s, 'Setup failed: ' + String(err.message).slice(0, 120));
    }
}

// Turned off on the website: keep the channels, but grey out the button
async function disablePanel(guild, s) {
    const panel = s.panel_channel_id && guild.channels.cache.get(s.panel_channel_id);
    const message = panel && s.panel_message_id ? await panel.messages.fetch(s.panel_message_id).catch(() => null) : null;
    if (message) await message.edit(panelPayload(s)).catch(() => {});
    await pool.execute('UPDATE ticket_settings SET synced_at = ? WHERE guild_id = ?', [s.updated_at, guild.id]).catch(() => {});
    s.synced_at = s.updated_at;
    await setStatus(guild.id, s, 'off');
}

async function load(client) {
    if (loading) return;
    loading = true;
    try {
        await ensureTables();
        const [rows] = await pool.execute('SELECT * FROM ticket_settings');
        const next = new Map();
        for (const s of rows) {
            next.set(s.guild_id, s);
            const guild = client.guilds.cache.get(s.guild_id);
            if (!guild) continue;
            const changed = Number(s.updated_at) !== Number(s.synced_at);
            if (Number(s.enabled) === 1) {
                // Changed on the website, or an admin deleted one of Pingway's ticket channels
                const missing = !guild.channels.cache.has(s.category_id || '-') || !guild.channels.cache.has(s.panel_channel_id || '-') ||
                    !guild.channels.cache.has(s.log_channel_id || '-');
                if (changed || (missing && s.status === 'ok')) await setup(client, guild, s);
            } else if (changed) {
                await disablePanel(guild, s);
            }
        }
        settings = next;
    } catch (err) {
        console.error('❌ [TICKETS] Reload failed:', err.message);
    } finally {
        loading = false;
    }
}

const isSupport = (member, s) => Boolean(member) && (
    member.permissions.has(P.ManageChannels) || supportRoles(s).some(id => member.roles.cache.has(id))
);

async function openModal(interaction, s) {
    const [[{ n }]] = await pool.execute("SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'",
        [interaction.guildId, interaction.user.id]);
    const max = Math.max(1, Number(s.max_open) || 1);
    if (Number(n) >= max) {
        return interaction.reply({ content: '⚠️ You already have ' + n + ' open ticket(s). Please use that one, or close it first.', flags: [MessageFlags.Ephemeral] });
    }
    const modal = new ModalBuilder().setCustomId('pwtk:openmodal').setTitle('Open a ticket').addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('reason').setLabel('What do you need help with?').setStyle(TextInputStyle.Paragraph)
                .setRequired(false).setMaxLength(500)
        )
    );
    return interaction.showModal(modal);
}

async function createTicket(client, interaction, s) {
    const guild = interaction.guild;
    const key = guild.id + ':' + interaction.user.id;
    if (busy.has(key)) return interaction.reply({ content: '⏳ Your ticket is being created…', flags: [MessageFlags.Ephemeral] });
    busy.add(key);
    try {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const category = guild.channels.cache.get(s.category_id);
        if (!category) return interaction.editReply('❌ The ticket system is not set up correctly. Please tell a server admin.');
        if (category.children && category.children.cache.size >= 50) {
            return interaction.editReply('❌ There are too many open tickets right now. Please try again later.');
        }
        const [[{ n }]] = await pool.execute("SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'", [guild.id, interaction.user.id]);
        if (Number(n) >= Math.max(1, Number(s.max_open) || 1)) return interaction.editReply('⚠️ You already have an open ticket.');

        await pool.execute('UPDATE ticket_settings SET counter = counter + 1 WHERE guild_id = ?', [guild.id]);
        const [[{ counter }]] = await pool.execute('SELECT counter FROM ticket_settings WHERE guild_id = ?', [guild.id]);
        const number = Number(counter);
        const reason = (interaction.fields.getTextInputValue('reason') || '').trim().slice(0, 500);
        const roles = supportRoles(s).filter(id => guild.roles.cache.has(id));
        const allow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];

        const channel = await guild.channels.create({
            name: 'ticket-' + String(number).padStart(4, '0'), type: ChannelType.GuildText, parent: category.id,
            topic: 'Ticket #' + number + ' by ' + interaction.user.tag, reason: 'Pingway ticket opened by ' + interaction.user.tag,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [P.ViewChannel] },
                { id: client.user.id, allow: [...allow, P.ManageChannels] },
                { id: interaction.user.id, allow },
                ...roles.map(id => ({ id, allow }))
            ]
        });
        await pool.execute('INSERT INTO tickets (guild_id, number, channel_id, user_id, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [guild.id, number, channel.id, interaction.user.id, 'open', reason || null, Date.now()]);

        const embed = new EmbedBuilder().setColor('#5865f2').setTitle('🎫 Ticket #' + number)
            .setDescription((s.welcome || DEFAULT_WELCOME) + (reason ? '\n\n**Request:**\n' + reason : ''))
            .setFooter({ text: 'Opened by ' + interaction.user.tag }).setTimestamp();
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pwtk:claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('pwtk:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger)
        );
        await channel.send({
            content: '<@' + interaction.user.id + '>' + (roles.length ? ' ' + roles.map(id => '<@&' + id + '>').join(' ') : ''),
            embeds: [embed], components: [buttons],
            allowedMentions: { users: [interaction.user.id], roles }
        });
        console.log('🎫 [TICKETS] Ticket #' + number + ' opened by ' + interaction.user.tag + ' in ' + guild.name + '.');
        return interaction.editReply('✅ Your ticket is open: <#' + channel.id + '>');
    } catch (err) {
        console.error('❌ [TICKETS] Could not open a ticket in ' + guild.name + ':', err.message);
        return interaction.editReply('❌ Could not create your ticket. Pingway may be missing the Manage Channels permission.').catch(() => {});
    } finally {
        busy.delete(key);
    }
}

async function getTicket(channelId) {
    const [[t]] = await pool.execute("SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'", [channelId]);
    return t || null;
}

function stamp(ms) {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

async function buildTranscript(channel) {
    const all = [];
    let before;
    while (all.length < TRANSCRIPT_MAX_MESSAGES) {
        const batch = await channel.messages.fetch({ limit: 100, before });
        if (!batch.size) break;
        all.push(...batch.values());
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    all.reverse();
    return all.map(m => {
        const parts = [m.content || ''];
        for (const e of m.embeds) parts.push('[embed] ' + [e.title, e.description].filter(Boolean).join(' - '));
        for (const a of m.attachments.values()) parts.push('[file] ' + a.url);
        return '[' + stamp(m.createdTimestamp) + '] ' + m.author.tag + ': ' + parts.filter(Boolean).join(' ');
    }).join('\n');
}

async function closeTicket(client, interaction, s, t) {
    const guild = interaction.guild;
    const channel = interaction.channel;
    await interaction.reply({ content: '🔒 Closing this ticket in 5 seconds…' });
    await pool.execute("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?", [Date.now(), interaction.user.id, t.id]);

    const log = s.log_channel_id && guild.channels.cache.get(s.log_channel_id);
    if (log) {
        try {
            const embed = new EmbedBuilder().setColor('#95a5a6').setTitle('🔒 Ticket #' + t.number + ' closed')
                .addFields(
                    { name: 'Opened by', value: '<@' + t.user_id + '>', inline: true },
                    { name: 'Closed by', value: '<@' + interaction.user.id + '>', inline: true },
                    { name: 'Claimed by', value: t.claimed_by ? '<@' + t.claimed_by + '>' : '-', inline: true },
                    { name: 'Opened', value: '<t:' + Math.floor(Number(t.created_at) / 1000) + ':f>', inline: true },
                    { name: 'Request', value: t.reason ? String(t.reason).slice(0, 1000) : '-' }
                ).setTimestamp();
            const files = [];
            if (Number(s.transcripts) === 1) {
                const text = await buildTranscript(channel);
                files.push(new AttachmentBuilder(Buffer.from(text || '(no messages)', 'utf8'), { name: 'ticket-' + String(t.number).padStart(4, '0') + '.txt' }));
            }
            await log.send({ embeds: [embed], files, allowedMentions: { parse: [] } });
        } catch (err) {
            console.error('❌ [TICKETS] Could not save the transcript:', err.message);
        }
    }
    setTimeout(() => channel.delete('Pingway ticket closed by ' + interaction.user.tag).catch(err =>
        console.error('❌ [TICKETS] Could not delete ticket channel:', err.message)), 5000);
}

async function onInteraction(client, interaction) {
    if (!interaction.guildId || !(interaction.isButton() || interaction.isModalSubmit())) return;
    const cid = interaction.customId || '';
    if (!cid.startsWith('pwtk:')) return;
    try {
        if (require('../maintenance').isMaintenance(interaction.guildId)) return; // the main handler already replied
    } catch (e) { /* no maintenance module */ }

    try {
        const [[s]] = await pool.execute('SELECT * FROM ticket_settings WHERE guild_id = ?', [interaction.guildId]);
        if (!s || Number(s.enabled) !== 1) {
            return interaction.reply({ content: '⚠️ Tickets are turned off in this server.', flags: [MessageFlags.Ephemeral] });
        }
        if (cid === 'pwtk:open') return openModal(interaction, s);
        if (cid === 'pwtk:openmodal') return createTicket(client, interaction, s);

        const t = await getTicket(interaction.channelId);
        if (!t) return interaction.reply({ content: '⚠️ This ticket is already closed.', flags: [MessageFlags.Ephemeral] });
        const member = interaction.member;

        if (cid === 'pwtk:claim') {
            if (!isSupport(member, s)) return interaction.reply({ content: '⚠️ Only the support team can claim tickets.', flags: [MessageFlags.Ephemeral] });
            if (t.claimed_by) return interaction.reply({ content: 'ℹ️ Already claimed by <@' + t.claimed_by + '>.', flags: [MessageFlags.Ephemeral] });
            await pool.execute('UPDATE tickets SET claimed_by = ? WHERE id = ?', [interaction.user.id, t.id]);
            return interaction.reply({ content: '🙋 <@' + interaction.user.id + '> will help you with this ticket.', allowedMentions: { parse: [] } });
        }
        if (cid === 'pwtk:close') {
            if (interaction.user.id !== t.user_id && !isSupport(member, s)) {
                return interaction.reply({ content: '⚠️ Only the person who opened this ticket or the support team can close it.', flags: [MessageFlags.Ephemeral] });
            }
            const confirm = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('pwtk:closeyes').setLabel('Yes, close it').setStyle(ButtonStyle.Danger)
            );
            return interaction.reply({ content: 'Close this ticket? The channel will be deleted.', components: [confirm], flags: [MessageFlags.Ephemeral] });
        }
        if (cid === 'pwtk:closeyes') {
            if (interaction.user.id !== t.user_id && !isSupport(member, s)) {
                return interaction.reply({ content: '⚠️ You can\'t close this ticket.', flags: [MessageFlags.Ephemeral] });
            }
            return closeTicket(client, interaction, s, t);
        }
    } catch (err) {
        console.error('❌ [TICKETS] Button failed:', err.message);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Something went wrong. Please try again.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }
    }
}

// Daily: delete closed tickets older than RETENTION_DAYS (by closed_at), 1000 rows at a time
async function cleanupOldTickets() {
    try {
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        let total = 0;
        for (;;) {
            const [rows] = await pool.query("SELECT id FROM tickets WHERE status = 'closed' AND COALESCE(closed_at, created_at) < ? ORDER BY id LIMIT " + CLEANUP_BATCH, [cutoff]);
            if (!rows.length) break;
            const [res] = await pool.query('DELETE FROM tickets WHERE id IN (' + rows.map(() => '?').join(',') + ") AND status = 'closed'", rows.map(r => r.id));
            const n = Number(res && res.affectedRows) || 0;
            total += n;
            if (!n || rows.length < CLEANUP_BATCH) break;
        }
        if (total) console.log('🧹 [TICKETS] Deleted ' + total + ' closed ticket' + (total === 1 ? '' : 's') + ' older than ' + RETENTION_DAYS + ' days.');
        return total;
    } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE' || /no such table|doesn't exist/i.test(err.message)) return 0; // no tickets yet
        console.error('❌ [TICKETS] Ticket cleanup failed:', err.message);
        return 0;
    }
}

function start(client) {
    if (started) return;
    started = true;
    setTimeout(cleanupOldTickets, CLEANUP_FIRST_MS).unref();
    setInterval(cleanupOldTickets, CLEANUP_EVERY_MS).unref();
    client.on(Events.InteractionCreate, interaction => onInteraction(client, interaction).catch(() => {}));
    // A ticket channel deleted by hand counts as closed
    client.on(Events.ChannelDelete, channel => {
        pool.execute("UPDATE tickets SET status = 'closed', closed_at = ? WHERE channel_id = ? AND status = 'open'", [Date.now(), channel.id]).catch(() => {});
    });
    load(client);
    setInterval(() => load(client), RELOAD_MS);
}

module.exports = { start, load, ensureTables, cleanupOldTickets };
