// Boards (pingway.app homepage boards: Static / FC posters and Community events). The website keeps the posters in the shared
// database (tables in utils/boardsDdl.js) and asks the bot, through command_queue, to send what needs Discord:
//   boards_signup_dm     a sign-up / recruitment offer / invite -> DM to the poster owner (in the OWNER's bot language) with the
//                        person's mention, name, profile link and what they ticked (IGN card image like /ign, FFLogs / Tomestone)
//   boards_channel_post  the same, posted in the owner's chosen server channel (Static / FC posters), with the optional role ping.
//                        Checked first: Pingway is in the server, the owner is still its owner or an admin, the channel exists,
//                        Pingway has View Channel + Send Messages + Embed Links + Attach Files there and may ping the role.
//                        Otherwise nothing is posted and the owner gets a DM saying why.
//   boards_test          Send test (Notifications on the website): a test DM to the owner (+ the channel test)
//   boards_report_dm     a report on a poster -> DM to its owner (the reason and the count; never who reported it)
// And on its own, every hour: expiry reminder DMs at 5, 3 and 0 days for Static / FC posters (once each; a bump starts over).
//
// Safety: the person a job is for always comes from the database rows (never from args); the row's requested_by (written by
// the website from the login) must match the sign-up / report / test owner. Every value is checked; a bad row ends as
// 'error' and never crashes the bot. DM failures are written to dm_blocked (utils/dmStatus.js), like alert DMs.
// Nothing private is posted anywhere public: channel posts only show what the person chose to send to that poster.

const { t } = require('./i18n');
const ignLinks = require('./ignLinks');

const SITE = 'https://pingway.app';
const ID_RE = /^\d{15,22}$/;
const KINDS = ['lfm', 'lfs', 'fc', 'lffc', 'event'];
const NOTIFY_KINDS = ['lfm', 'lfs', 'fc', 'lffc'];
const ACTIONS = ['boards_signup_dm', 'boards_channel_post', 'boards_test', 'boards_report_dm'];
const REASONS = ['picture', 'words', 'link', 'spam', 'fake', 'other'];
const HIDE_AT = 3;
const DAY = 24 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;
const COLOR = { lfm: 0xc8955a, lfs: 0xc8955a, fc: 0xd4af37, lffc: 0xd4af37, event: 0x3ba55d };
const NEED = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles'];

const clip = (s, n) => { const x = String(s == null ? '' : s); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
// Discord markdown / mentions in names and titles are shown as plain text
const plain = (s, n) => clip(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/([\\*_~`|>#\[\]()])/g, '\\$1').replace(/@/g, '@\u200b'), n);
const posterUrl = id => SITE + '/poster?id=' + Number(id);
const tabUrl = SITE + '/dashboard?tab=boards';
const profileUrl = id => 'https://discord.com/users/' + id;
function httpsUrl(u) {
    const s = String(u || '').trim();
    if (!s || s.length > 500) return '';
    try { const x = new URL(s); return x.protocol === 'https:' && !x.username && !x.password ? x.href : ''; } catch (e) { return ''; }
}
const result = (state, data) => ({ state, result: JSON.stringify(data || {}) });

function defaults(deps) {
    const d = Object.assign({}, deps || {});
    if (!d.pool) d.pool = require('./db').pool;
    if (!d.langOf) d.langOf = id => require('./userLanguage').forUser(id);
    if (!d.guildLangOf) d.guildLangOf = g => require('./userLanguage').forGuild(g);
    if (!d.dmStatus) d.dmStatus = require('./dmStatus');
    if (!d.makeCard) d.makeCard = (userId, lodestoneId, show) => defaultCard(d.pool, userId, lodestoneId, show);
    if (!d.now) d.now = () => Date.now();
    return d;
}

/** The IGN card of one verified character, made like /ign (commands/ign.js). Links the person did not tick stay off it. */
async function defaultCard(pool, userId, lodestoneId, show) {
    const [rows] = await pool.execute('SELECT * FROM ign_characters WHERE user_id = ? AND lodestone_id = ? AND claim_key IS NOT NULL', [String(userId), String(lodestoneId)]);
    if (!rows[0]) return null;
    const ign = require('../commands/ign');
    const config = require('./ignClaims').cardConfig(rows[0]);
    if (!show || !show.fflogs) config.fflogs_url = null;
    if (!show || !show.tomestone) config.tomestone_url = null;
    config.collectStats = await ign.collectStatsFor(String(userId), rows[0].lodestone_id);
    const data = await ign.fetchLodestoneData(config.lodestone_id);
    if (!data || !data.success) return null;
    return ign.generateCard(config, data);
}

async function langOf(d, userId) {
    try { return (await d.langOf(String(userId))) || 'en'; } catch (e) { return 'en'; }
}
async function guildLang(d, guild) {
    try { return (await d.guildLangOf(guild)) || 'en'; } catch (e) { return 'en'; }
}

/** DM a user; failures are remembered in dm_blocked (like alert DMs). -> true / false */
async function dm(d, userId, payload) {
    let user;
    try {
        user = d.client && d.client.users ? await d.client.users.fetch(String(userId)) : null;
    } catch (err) {
        if (err && err.code === 10013) await d.dmStatus.markFailed(String(userId), 'unknown_user');
        return false;
    }
    if (!user || typeof user.send !== 'function') return false;
    try {
        await user.send(payload);
        await d.dmStatus.markOk(String(userId));
        return true;
    } catch (err) {
        if (err && err.code === 50007) await d.dmStatus.markFailed(String(userId), 'dm_closed');
        return false;
    }
}

async function posterRow(pool, id) {
    const [rows] = await pool.execute('SELECT id, kind, owner_id, title, expires_at, event_at, hidden, report_count, notify_channel, notify_guild_id, notify_channel_id, notify_role_id FROM board_posters WHERE id = ?', [Number(id)]);
    const p = rows[0];
    if (!p || !KINDS.includes(p.kind) || !ID_RE.test(String(p.owner_id))) return null;
    return p;
}

/** The text lines for one sign-up (kind = the poster's kind): who, their profile, their character and the links they ticked */
function signupLines(lang, p, s, channel) {
    const name = plain(s.user_name || 'Player', 80), mention = '<@' + s.user_id + '>';
    const lines = [t(lang, 'boards.' + (channel ? 'channelBody' : 'body') + '.' + p.kind, { name, mention, title: plain(p.title, 100) }), '', t(lang, 'boards.profile', { url: profileUrl(s.user_id) })];
    lines.push(s.char_name ? t(lang, 'boards.character', { name: plain(s.char_name, 64), world: plain(s.char_world || '', 64) }) : t(lang, 'boards.noCharacter'));
    // FFLogs / Tomestone only when they belong to the sign-up's character (utils/ignLinks.js)
    const ch = { lodestoneId: s.lodestone_id ? String(s.lodestone_id) : '', name: s.char_name || '', world: s.char_world || '' };
    const ff = httpsUrl(ignLinks.usable(s.fflogs_url, 'fflogs', ch)), ts = httpsUrl(ignLinks.usable(s.tomestone_url, 'tomestone', ch));
    if (ff) lines.push(t(lang, 'boards.fflogs', { url: ff }));
    if (ts) lines.push(t(lang, 'boards.tomestone', { url: ts }));
    return lines;
}

/** The sign-up message (embed + the IGN card when ticked), in one language */
async function signupMessage(d, lang, p, s, card, channel) {
    const lines = signupLines(lang, p, s, channel);
    if (Number(s.send_card) === 1) lines.push(t(lang, card ? 'boards.cardAttached' : 'boards.cardFailed'));
    lines.push('', t(lang, 'boards.poster', { url: posterUrl(p.id) }));
    const embed = { color: COLOR[p.kind], title: t(lang, 'boards.title.' + p.kind), description: clip(lines.join('\n'), 4000), footer: { text: t(lang, 'boards.footer') } };
    const msg = { embeds: [embed], allowedMentions: { parse: [] } };
    if (card) { embed.image = { url: 'attachment://ign_card.png' }; msg.files = [{ attachment: card, name: 'ign_card.png' }]; }
    return msg;
}

async function makeCard(d, s) {
    if (Number(s.send_card) !== 1 || !s.lodestone_id) return null;
    try {
        const buf = await d.makeCard(String(s.user_id), String(s.lodestone_id), { fflogs: !!s.fflogs_url, tomestone: !!s.tomestone_url });
        return Buffer.isBuffer(buf) && buf.length ? buf : null;
    } catch (e) {
        console.error('⚠️ [BOARDS] IGN card failed:', e && e.message);
        return null;
    }
}

async function signupRow(pool, id) {
    const [rows] = await pool.execute('SELECT id, poster_id, user_id, user_name, lodestone_id, char_name, char_world, send_card, fflogs_url, tomestone_url FROM board_signups WHERE id = ?', [Number(id)]);
    const s = rows[0];
    return s && ID_RE.test(String(s.user_id)) ? s : null;
}

/**
 * Where a channel post can go: checks everything Discord needs. -> { ok: true, channel, role } or { ok: false, reason }
 * reason: noGuild | notAdmin | noChannel | noPerms | noRole | cantMention
 */
async function channelTarget(d, ownerId, guildId, channelId, roleId) {
    if (!ID_RE.test(String(guildId || '')) || !ID_RE.test(String(channelId || ''))) return { ok: false, reason: 'noChannel' };
    const guild = d.client && d.client.guilds ? d.client.guilds.cache.get(String(guildId)) : null;
    if (!guild) return { ok: false, reason: 'noGuild' };
    let admin = String(guild.ownerId) === String(ownerId);
    if (!admin) {
        const member = await guild.members.fetch(String(ownerId)).catch(() => null);
        admin = !!(member && member.permissions && member.permissions.has('Administrator'));
    }
    if (!admin) return { ok: false, reason: 'notAdmin', guild };
    const channel = await guild.channels.fetch(String(channelId)).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return { ok: false, reason: 'noChannel', guild };
    const me = guild.members.me || null;
    const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (!perms || !NEED.every(p => perms.has(p))) return { ok: false, reason: 'noPerms', guild, channel };
    let role = null;
    if (roleId) {
        if (!ID_RE.test(String(roleId))) return { ok: false, reason: 'noRole', guild, channel };
        role = guild.roles && guild.roles.cache ? guild.roles.cache.get(String(roleId)) : null;
        if (!role) role = guild.roles && typeof guild.roles.fetch === 'function' ? await guild.roles.fetch(String(roleId)).catch(() => null) : null;
        if (!role) return { ok: false, reason: 'noRole', guild, channel };
        if (!role.mentionable && !perms.has('MentionEveryone')) return { ok: false, reason: 'cantMention', guild, channel };
    }
    return { ok: true, guild, channel, role };
}

async function tellSkipped(d, ownerId, title, reason) {
    const lang = await langOf(d, ownerId);
    const embed = { color: 0xe0a526, title: t(lang, 'boards.skip.title'),
        description: t(lang, 'boards.skip.body', { title: plain(title, 100), reason: t(lang, 'boards.skip.' + reason) }) + '\n\n' + t(lang, 'boards.skip.fix'), footer: { text: t(lang, 'boards.footer') } };
    return dm(d, ownerId, { embeds: [embed], allowedMentions: { parse: [] } });
}

// ---------- the jobs ----------
async function signupDm(d, requestedBy, args) {
    const s = await signupRow(d.pool, args.signupId);
    if (!s || String(s.user_id) !== String(requestedBy)) return result('error', { reason: 'invalid' });
    const p = await posterRow(d.pool, s.poster_id);
    if (!p || p.kind === 'event') return result('done', { sent: false, reason: 'gone' });
    const lang = await langOf(d, p.owner_id);
    const card = await makeCard(d, s);
    const ok = await dm(d, p.owner_id, await signupMessage(d, lang, p, s, card, false));
    console.log('📌 [BOARDS] Sign-up #' + s.id + ' (poster #' + p.id + '): DM ' + (ok ? 'sent' : 'failed') + '.');
    return result('done', { sent: ok, card: !!card });
}

async function channelPost(d, requestedBy, args) {
    const s = await signupRow(d.pool, args.signupId);
    if (!s || String(s.user_id) !== String(requestedBy)) return result('error', { reason: 'invalid' });
    const p = await posterRow(d.pool, s.poster_id);
    if (!p || !NOTIFY_KINDS.includes(p.kind) || Number(p.notify_channel) !== 1) return result('done', { posted: false, reason: 'off' });
    const where = await channelTarget(d, p.owner_id, p.notify_guild_id, p.notify_channel_id, p.notify_role_id);
    if (!where.ok) {
        await tellSkipped(d, p.owner_id, p.title, where.reason);
        console.log('📌 [BOARDS] Channel post for sign-up #' + s.id + ' skipped (' + where.reason + ').');
        return result('done', { posted: false, reason: where.reason });
    }
    const lang = await guildLang(d, where.guild);
    const card = await makeCard(d, s);
    const msg = await signupMessage(d, lang, p, s, card, true);
    if (where.role) { msg.content = '<@&' + where.role.id + '>'; msg.allowedMentions = { parse: [], roles: [String(where.role.id)] }; }
    try {
        await where.channel.send(msg);
    } catch (err) {
        await tellSkipped(d, p.owner_id, p.title, 'noPerms');
        return result('done', { posted: false, reason: 'sendFailed' });
    }
    console.log('📌 [BOARDS] Sign-up #' + s.id + ' posted in the owner\'s channel.');
    return result('done', { posted: true });
}

async function testJob(d, requestedBy, args) {
    const owner = String(requestedBy || '');
    if (!ID_RE.test(owner) || !NOTIFY_KINDS.concat('event').includes(String(args.kind || ''))) return result('error', { reason: 'invalid' });
    const lang = await langOf(d, owner);
    const lines = [t(lang, 'boards.test.dmBody')];
    let posted = null;
    if (args.guildId || args.channelId) {
        if (!NOTIFY_KINDS.includes(args.kind)) return result('error', { reason: 'invalid' });
        const where = await channelTarget(d, owner, args.guildId, args.channelId, args.roleId || '');
        if (where.ok) {
            const glang = await guildLang(d, where.guild);
            let name = 'Player';
            try { const u = await d.client.users.fetch(owner); name = (u && (u.globalName || u.username)) || name; } catch (e) { /* keep */ }
            const msg = { content: (where.role ? '<@&' + where.role.id + '> ' : '') + t(glang, 'boards.test.channelPost', { name: plain(name, 80) }),
                allowedMentions: where.role ? { parse: [], roles: [String(where.role.id)] } : { parse: [] } };
            try { await where.channel.send(msg); posted = true; } catch (e) { posted = 'noPerms'; }
        } else posted = where.reason;
        lines.push('', posted === true ? t(lang, 'boards.test.channelOk', { channel: '<#' + args.channelId + '>' }) : t(lang, 'boards.test.channelSkipped', { reason: t(lang, 'boards.skip.' + posted) }));
    }
    const ok = await dm(d, owner, { embeds: [{ color: 0x5865f2, title: t(lang, 'boards.test.dmTitle'), description: lines.join('\n'), footer: { text: t(lang, 'boards.footer') } }], allowedMentions: { parse: [] } });
    return result('done', { dm: ok, channel: posted });
}

async function reportDm(d, requestedBy, args) {
    const [rows] = await d.pool.execute('SELECT id, poster_id, user_id, reason FROM board_reports WHERE id = ?', [Number(args.reportId)]);
    const r = rows[0];
    if (!r || String(r.user_id) !== String(requestedBy) || !REASONS.includes(r.reason)) return result('error', { reason: 'invalid' });
    const p = await posterRow(d.pool, r.poster_id);
    if (!p) return result('done', { sent: false, reason: 'gone' });
    const lang = await langOf(d, p.owner_id);
    const count = Number(p.report_count) || 0;
    const lines = [t(lang, 'boards.report.body', { title: plain(p.title, 100), reason: t(lang, 'boards.report.reason.' + r.reason), count }), '',
        Number(p.hidden) === 1 ? t(lang, 'boards.report.hidden') : t(lang, 'boards.report.rule'), '', t(lang, 'boards.poster', { url: posterUrl(p.id) })];
    const ok = await dm(d, p.owner_id, { embeds: [{ color: 0xd64545, title: t(lang, 'boards.report.title'), description: lines.join('\n'), footer: { text: t(lang, 'boards.footer') } }], allowedMentions: { parse: [] } });
    console.log('📌 [BOARDS] Report #' + r.id + ' (poster #' + p.id + '): owner DM ' + (ok ? 'sent' : 'failed') + '.');
    return result('done', { sent: ok });
}

/** command_queue job (utils/commandQueue.js). requestedBy = the row's requested_by. Never throws. */
async function run(deps, action, requestedBy, args) {
    try {
        const d = defaults(deps);
        const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        if (!ID_RE.test(String(requestedBy || ''))) return result('error', { reason: 'invalid' });
        if (action === 'boards_signup_dm') return Number.isInteger(a.signupId) && a.signupId > 0 ? await signupDm(d, requestedBy, a) : result('error', { reason: 'invalid' });
        if (action === 'boards_channel_post') return Number.isInteger(a.signupId) && a.signupId > 0 ? await channelPost(d, requestedBy, a) : result('error', { reason: 'invalid' });
        if (action === 'boards_report_dm') return Number.isInteger(a.reportId) && a.reportId > 0 ? await reportDm(d, requestedBy, a) : result('error', { reason: 'invalid' });
        if (action === 'boards_test') return await testJob(d, requestedBy, a);
        return result('error', { reason: 'unknown' });
    } catch (err) {
        if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146)) return result('error', { reason: 'noTables' });
        console.error('⚠️ [BOARDS] Job failed:', err && err.message);
        return result('error', { reason: 'failed' });
    }
}

// ---------- expiry reminders (5, 3 and 0 days; Static / FC posters) ----------
/** Which reminder is due: 5 / 3 / 0, or null. Expired posters only get the "0" one within a day after they expired. */
function dueStage(expiresAt, now) {
    const left = Number(expiresAt) - now;
    if (!Number.isFinite(left)) return null;
    if (left <= 0) return left > -DAY ? 0 : null;
    const days = Math.ceil(left / DAY);
    if (days <= 3) return 3;
    if (days <= 5) return 5;
    return null;
}

async function checkExpiry(deps) {
    const d = defaults(deps);
    const now = d.now();
    let rows;
    try {
        [rows] = await d.pool.execute("SELECT id, kind, owner_id, title, expires_at, expiry_dm_stage FROM board_posters WHERE kind IN ('lfm', 'lfs', 'fc', 'lffc') AND hidden = 0 AND expires_at > ? AND expires_at <= ? ORDER BY id LIMIT 500",
            [now - DAY, now + 5 * DAY]);
    } catch (err) {
        if (err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146)) return 0; // nobody has made a poster yet
        throw err;
    }
    let sent = 0;
    for (const p of rows) {
        if (!ID_RE.test(String(p.owner_id)) || !NOTIFY_KINDS.includes(p.kind)) continue;
        const stage = dueStage(p.expires_at, now);
        const had = p.expiry_dm_stage === null || p.expiry_dm_stage === undefined ? 99 : Number(p.expiry_dm_stage);
        if (stage === null || stage >= had) continue;
        // only once per stage (a bump on the website sets the stage back to NULL)
        const [claim] = await d.pool.execute('UPDATE board_posters SET expiry_dm_stage = ? WHERE id = ? AND expires_at = ? AND (expiry_dm_stage IS NULL OR expiry_dm_stage > ?)', [stage, Number(p.id), Number(p.expires_at), stage]);
        if (!claim || claim.affectedRows !== 1) continue;
        const lang = await langOf(d, p.owner_id);
        const body = stage === 0 ? t(lang, 'boards.expiry.body0', { title: plain(p.title, 100), url: tabUrl })
            : t(lang, 'boards.expiry.body', { title: plain(p.title, 100), time: '<t:' + Math.floor(Number(p.expires_at) / 1000) + ':F>', url: tabUrl });
        const ok = await dm(d, p.owner_id, { embeds: [{ color: COLOR[p.kind], title: t(lang, 'boards.expiry.title' + stage), description: body, footer: { text: t(lang, 'boards.footer') } }], allowedMentions: { parse: [] } });
        if (ok) sent++;
    }
    if (sent) console.log('📌 [BOARDS] Expiry reminders sent: ' + sent + '.');
    return sent;
}

let timer = null;
/** Starts the hourly expiry check (mybot.js, after the client is ready). */
function start(client) {
    if (timer) return;
    let ready = false;
    const tick = () => (ready ? Promise.resolve() : require('./boardsDdl').createBoardTables(require('./db').pool).then(() => { ready = true; }))
        .then(() => checkExpiry({ client })).catch(err => {
        if (!/ECONNRESET|ETIMEDOUT|PROTOCOL_CONNECTION_LOST/.test(String(err && err.code))) console.error('⚠️ [BOARDS] Expiry check failed:', err && err.message);
    });
    const first = setTimeout(tick, 60000);
    if (first.unref) first.unref();
    timer = setInterval(tick, CHECK_MS);
    if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { ACTIONS, NOTIFY_KINDS, HIDE_AT, SITE, run, checkExpiry, dueStage, channelTarget, signupMessage, plain, start, stop, _defaultCard: defaultCard };
