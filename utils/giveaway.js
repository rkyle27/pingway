// Website Dev page -> Giveaway (dev only). The website saves the giveaway (table giveaways, utils/devDdl.js) and asks the bot
// (through command_queue) to draw it; pick() below runs here because only the bot knows the servers and members:
//   1. checks again that the asker (command_queue.requested_by) is a dev in dev_users (staff / anyone else: refused)
//   2. picks a random server Pingway is in, then a random REAL member there (no bots, no apps / system users; the owner
//      can win too). Members: ONE Discord request per tried server (guild.members.list, up to 1,000 members), never a full
//      member download; if that request fails, the members Pingway already has in its cache are used. At most 5 servers are tried.
//   3. DMs the winner (in their language) with a Claim button (customId 'giveaway_claim_<id>'), valid CLAIM_DAYS days
//   4. writes every step to the audit log (dev_audit): winner, DM sent / DM failed (DMs closed -> the owner can reroll)
// handleClaim(): the winner's Claim button. One conditional UPDATE, so it can only be claimed once and only before it expires.
// Preset rewards are queued in command_queue as the job grantCommand() returns (its before / after view is saved in the
// 'giveaway.claimed' audit row). A "manual" reward is sent by the owner by hand (the Dev page history shows it as claimed).

const { t } = require('./i18n');
const { loadPrivate } = require('./privateHook');

const CLAIM_DAYS = 7;
const CLAIM_MS = CLAIM_DAYS * 24 * 60 * 60 * 1000;
const MAX_SERVERS_TRIED = 5;
const LIST_LIMIT = 1000;
const ID_RE = /^\d{15,22}$/;
const PREFIX = 'giveaway_claim_';

const clip = (s, n) => { const x = String(s == null ? '' : s); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const randomIndex = n => Math.floor(Math.random() * n);

async function audit(pool, action, target, after, detail, now = Date.now()) {
    try {
        const [r] = await pool.execute(
            'INSERT INTO dev_audit (at, actor_id, actor_role, action, target, before_val, after_val, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [now, 'system', 'bot', action, target, null, after == null ? null : String(after), detail == null ? null : String(detail)]
        );
        return r && r.insertId ? Number(r.insertId) : null;
    } catch (err) {
        console.error('⚠️ [GIVEAWAY] Could not write the audit log:', err.message);
        return null;
    }
}

/** A real person: not a bot / app, not Discord's system user */
const isReal = m => !!(m && m.user && !m.user.bot && !m.user.system);

/** Real members of a guild: one limited request (up to 1,000), else the cached members. */
async function realMembers(guild) {
    let list = null;
    try {
        if (guild.members && typeof guild.members.list === 'function') list = await guild.members.list({ limit: LIST_LIMIT });
    } catch (e) { list = null; }
    const source = list && typeof list.values === 'function' ? list : (guild.members && guild.members.cache);
    return source ? [...source.values()].filter(isReal) : [];
}

function rewardLine(lang, row) {
    const kind = row.reward_kind, n = Number(row.reward_amount) || 0, text = String(row.reward_text || '').trim();
    const preset = kind === 'points' ? t(lang, 'giveaway.points', { n }) : kind === 'kofi_member' ? t(lang, 'giveaway.kofiMember', { n }) : '';
    return preset && text ? preset + ' — ' + text : preset || text;
}

/** The winner's DM (embed + Claim button), in their language. */
function buildDm(row, lang, expiresAt) {
    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const auto = row.reward_kind === 'points' || row.reward_kind === 'kofi_member';
    const embed = new EmbedBuilder()
        .setColor('#a78bfa')
        .setTitle(t(lang, 'giveaway.title'))
        .setDescription(
            t(lang, 'giveaway.body', { server: clip(row.guild_name, 100) }) + '\n\n' +
            t(lang, 'giveaway.reward', { reward: rewardLine(lang, row) }) + '\n\n' +
            t(lang, 'giveaway.claimBy', { time: '<t:' + Math.floor(expiresAt / 1000) + ':F>' }) + '\n' +
            t(lang, auto ? 'giveaway.autoNote' : 'giveaway.manualNote')
        )
        .setFooter({ text: t(lang, 'giveaway.footer', { id: row.id }) });
    const button = new ButtonBuilder().setCustomId(PREFIX + row.id).setStyle(ButtonStyle.Success).setLabel(t(lang, 'giveaway.claim')).setEmoji('🎁');
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

/**
 * Draws one giveaway. deps: { pool, client, langOf(userId), random(n), now() }
 * -> { state: 'done' | 'error', result } for command_queue (result = JSON for the Dev page)
 */
async function pick(deps, requestedBy, args) {
    const { pool, client } = deps;
    const random = deps.random || randomIndex;
    const now = deps.now ? deps.now() : Date.now();
    const id = Number(args && args.giveawayId);
    const out = (state, data) => ({ state, result: JSON.stringify(Object.assign({ giveawayId: id || null }, data)) });
    if (!Number.isInteger(id) || id < 1 || !ID_RE.test(String(requestedBy || ''))) return out('error', { reason: 'invalid' });
    // 1. the asker must still be a dev (staff and everyone else: refused)
    const [who] = await pool.execute('SELECT role FROM dev_users WHERE user_id = ?', [String(requestedBy)]);
    if (!who[0] || who[0].role !== 'dev') {
        await audit(pool, 'giveaway.refused', 'giveaway #' + id, null, 'not a dev: ' + requestedBy, now);
        return out('error', { reason: 'notDev' });
    }
    // only once: picking -> drawing
    const [take] = await pool.execute("UPDATE giveaways SET state = 'drawing' WHERE id = ? AND state = 'picking' AND created_by = ?", [id, String(requestedBy)]);
    if (!take || take.affectedRows !== 1) return out('error', { reason: 'notWaiting' });
    try {
        return await draw(deps, id, now, random, out);
    } catch (err) {
        const why = clip(err && err.message || err, 250);
        await pool.execute("UPDATE giveaways SET state = 'error', note = ? WHERE id = ? AND state = 'drawing'", ['failed: ' + why, id]).catch(() => {});
        await audit(pool, 'giveaway.error', 'giveaway #' + id, null, 'failed: ' + why, now);
        return out('error', { reason: 'failed', message: why });
    }
}

async function draw(deps, id, now, random, out) {
    const { pool, client } = deps;
    const [rows] = await pool.execute('SELECT * FROM giveaways WHERE id = ?', [id]);
    const row = rows[0];
    // 2. random server, random real member
    const guilds = client && client.guilds ? [...client.guilds.cache.values()].filter(g => g && g.available !== false) : [];
    let guild = null, member = null;
    for (let i = 0; i < MAX_SERVERS_TRIED && guilds.length; i++) {
        const g = guilds.splice(random(guilds.length), 1)[0];
        const members = await realMembers(g);
        if (members.length) { guild = g; member = members[random(members.length)]; break; }
    }
    if (!member) {
        await pool.execute("UPDATE giveaways SET state = 'no_member', note = ?, picked_at = ? WHERE id = ?", ['no server with a real member was found', now, id]);
        await audit(pool, 'giveaway.no_member', 'giveaway #' + id, null, 'no server with a real member was found', now);
        return out('done', { state: 'no_member' });
    }
    const user = member.user;
    const winnerName = clip(member.displayName || user.globalName || user.username || 'Player', 100);
    Object.assign(row, { guild_id: guild.id, guild_name: clip(guild.name, 100), winner_id: user.id, winner_name: winnerName });
    await pool.execute('UPDATE giveaways SET guild_id = ?, guild_name = ?, winner_id = ?, winner_name = ?, picked_at = ? WHERE id = ?',
        [String(guild.id), row.guild_name, String(user.id), winnerName, now, id]);
    await audit(pool, 'giveaway.winner', 'giveaway #' + id, JSON.stringify({ guildId: String(guild.id), guildName: row.guild_name, winnerId: String(user.id), winnerName }),
        'random server out of ' + (client.guilds.cache.size || 0) + ', random real member', now);
    // 3. DM with the Claim button
    const expiresAt = now + CLAIM_MS;
    let lang = 'en';
    try { lang = deps.langOf ? await deps.langOf(String(user.id)) : await require('./userLanguage').forUser(String(user.id)); } catch (e) { lang = 'en'; }
    try {
        await user.send(buildDm(row, lang, expiresAt));
    } catch (err) {
        const why = clip((err && (err.code ? err.code + ' ' : '') + (err.message || err)) || 'DM failed', 250);
        await pool.execute("UPDATE giveaways SET state = 'dm_failed', note = ? WHERE id = ?", ['DM failed: ' + why, id]);
        await audit(pool, 'giveaway.dm_failed', 'giveaway #' + id, null, 'winner ' + user.id + ': ' + why + ' (DMs closed?) - you can reroll on the Dev page', now);
        console.log('🎁 [GIVEAWAY] #' + id + ': could not DM the winner ' + user.id + ' (' + why + ').');
        return out('done', { state: 'dm_failed', guildName: row.guild_name, winnerId: String(user.id), winnerName });
    }
    await pool.execute("UPDATE giveaways SET state = 'dm_sent', expires_at = ? WHERE id = ?", [expiresAt, id]);
    await audit(pool, 'giveaway.dm', 'giveaway #' + id, 'sent', 'DM with the Claim button sent to ' + user.id + ' (' + lang + '), valid ' + CLAIM_DAYS + ' days', now);
    console.log('🎁 [GIVEAWAY] #' + id + ': winner ' + user.id + ' in ' + guild.id + ', DM sent.');
    return out('done', { state: 'dm_sent', guildName: row.guild_name, winnerId: String(user.id), winnerName, expiresAt });
}

/** The queued job that adds a preset reward ({ action, args }), or null for a manual reward. */
function grantCommand(row) {
    const p = loadPrivate('giveawayGrant');
    return p ? p.grantCommand(row) : null;
}

/** Claim button in the winner's DM. deps: { pool, langOf(interaction), now() } */
async function handleClaim(interaction, deps) {
    const { pool } = deps;
    const now = deps.now ? deps.now() : Date.now();
    let lang = 'en';
    try { lang = deps.langOf ? await deps.langOf(interaction) : await require('./userLanguage').forInteraction(interaction); } catch (e) { lang = 'en'; }
    const say = key => interaction.reply({ content: t(lang, 'giveaway.' + key, { days: CLAIM_DAYS }), flags: [64] });
    const id = Number(String(interaction.customId || '').slice(PREFIX.length));
    if (!Number.isInteger(id) || id < 1) return say('gone');
    const userId = String(interaction.user && interaction.user.id);
    const [rows] = await pool.execute('SELECT * FROM giveaways WHERE id = ?', [id]);
    const row = rows[0];
    if (!row) return say('gone');
    if (String(row.winner_id) !== userId) return say('notYours');
    const [r] = await pool.execute("UPDATE giveaways SET state = 'claimed', claimed_at = ? WHERE id = ? AND winner_id = ? AND state = 'dm_sent' AND expires_at > ?", [now, id, userId, now]);
    if (!r || r.affectedRows !== 1) {
        if (row.state === 'claimed') return say('already');
        if (row.state === 'dm_sent' && Number(row.expires_at) <= now) {
            const [e] = await pool.execute("UPDATE giveaways SET state = 'expired' WHERE id = ? AND state = 'dm_sent'", [id]);
            if (e && e.affectedRows === 1) await audit(pool, 'giveaway.expired', 'giveaway #' + id, null, 'winner ' + userId + ' pressed Claim after ' + CLAIM_DAYS + ' days', now);
            return say('expired');
        }
        if (row.state === 'expired') return say('expired');
        return say('gone');
    }
    const grant = grantCommand(row);
    const auditId = await audit(pool, 'giveaway.claimed', 'giveaway #' + id, JSON.stringify({ winnerId: userId, reward: row.reward_kind, amount: Number(row.reward_amount) || 0, text: row.reward_text || '' }),
        grant ? 'added automatically: ' + grant.action + ' ' + JSON.stringify(grant.args) : 'manual reward: send it to the winner yourself', now);
    if (grant) {
        // the bot runs it from command_queue within ~5 s
        const [q] = await pool.execute(
            "INSERT INTO command_queue (action, args, state, audit_id, requested_by, created_at) VALUES (?, ?, 'pending', ?, ?, ?)",
            [grant.action, JSON.stringify(grant.args), auditId, String(row.created_by), now]
        );
        if (q && q.insertId) await pool.execute('UPDATE giveaways SET grant_queue_id = ? WHERE id = ?', [Number(q.insertId), id]);
    }
    console.log('🎁 [GIVEAWAY] #' + id + ' claimed by ' + userId + (grant ? ' (' + grant.action + ' queued)' : ' (manual reward)') + '.');
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
    const done = new ButtonBuilder().setCustomId(PREFIX + id).setStyle(ButtonStyle.Secondary).setLabel(t(lang, 'giveaway.claimed')).setEmoji('✅').setDisabled(true);
    const content = t(lang, grant ? 'giveaway.claimedAuto' : 'giveaway.claimedManual');
    try {
        return await interaction.update({ content, components: [new ActionRowBuilder().addComponents(done)] });
    } catch (e) {
        return interaction.reply({ content, flags: [64] });
    }
}

module.exports = { CLAIM_DAYS, CLAIM_MS, PREFIX, MAX_SERVERS_TRIED, LIST_LIMIT, isReal, realMembers, rewardLine, buildDm, pick, grantCommand, handleClaim };
