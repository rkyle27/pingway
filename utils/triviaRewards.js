// Pingway Trivia season end (a season = one calendar month in JST). Started from utils/trivia.js start().
// Runs ~60 seconds after start and every 10 minutes. When the JST day becomes the 1st, the month that just ended is
// processed once (trivia_season_jobs remembers what was done). Only the month right before the current one is ever
// processed (older ones are never backfilled, the current one never before it ends). Seasons before FIRST_SEASON are
// only marked as done (the feature starts with November 2026).
// 1. Monthly bits reward (not announced anywhere; the player just gets a congratulations DM):
//    month bits (SUM of solved trivia_plays.bits that month, streak bonuses included) >= 500 -> 5 points,
//    >= 1000 -> 10 points (instead of 5). Only for Discord accounts at least 30 days old that solved on 10+ days that month.
//    Points are added like the website does for votes/Ko-fi (credit_lots, expire after 180 days, then the waiting
//    Retainer Watch / Supporter Perks renewals are settled), in the same transaction as the trivia_rewards row
//    (PRIMARY KEY user + season), so a restart or a second run never gives them twice. The DM is sent after the commit;
//    the points stay even when the DM fails.
// 2. Server top-3 roles (trivia_guild.role_top1..3, set on the website): the server's leaderboard of the month that
//    ended (players of that server, not hidden, still members; most bits first, a tie goes to who reached the total
//    first) gets the roles. Last month's holders (trivia_role_holders) lose them. Holders keep the role all month.
//    Roles Pingway can't manage (deleted, above Pingway's role, managed by an integration, no Manage Roles) are skipped.

const { PermissionFlagsBits } = require('discord.js');
const { pool } = require('./db');
const W = require('./triviaWords');
const dmStatus = require('./dmStatus');

const FIRST_SEASON = '2026-11';
const POLL_MS = 10 * 60 * 1000;
const FIRST_RUN_MS = 60 * 1000;
const REWARD_TIERS = [[1000, 10], [500, 5]]; // [month bits at least, points] — highest first, only one applies
const MIN_SOLVE_DAYS = 10;
const MIN_ACCOUNT_AGE_MS = 30 * 864e5;
const CREDIT_VALIDITY_DAYS = 180;
const POINTS_MIGRATION = 'credits_to_points_x10_2026_11';
const SITE = 'https://pingway.app';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Roles with any of these permissions are never given as a Trivia prize (Pingway only takes them back from last month's
// holder): Administrator, Manage Server, Manage Roles, Manage Channels, Ban/Kick Members, Manage Webhooks, Manage Messages,
// Mention @everyone, Timeout Members, Manage Nicknames, Manage Expressions (emojis/stickers), Manage Events,
// Manage Threads, View Audit Log, View Server Insights (Discord permission bits)
const DANGEROUS_PERMS = [3n, 5n, 28n, 4n, 2n, 1n, 29n, 13n, 17n, 40n, 27n, 30n, 33n, 34n, 7n, 19n].reduce((m, b) => m | (1n << b), 0n);
const ROLE_RETRIES = 6; // a Discord error (not "member left") retries the roles step up to 6 times (1 hour)

let tablesReady = false;
let started = false;
let running = false;
const roleTries = new Map(); // season -> failed role runs
const errorLogged = new Map(); // key -> time (keeps the console quiet when something keeps failing)

function logOnce(key, text) {
    const last = errorLogged.get(key) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    errorLogged.set(key, Date.now());
    console.error(text);
}

const isMissingTable = err => err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist|no such table/i.test(err.message || ''));

async function ensureTables() {
    if (tablesReady) return;
    await require('./trivia').ensureTables(); // trivia_plays, trivia_users, trivia_players, trivia_guild
    await pool.execute(`CREATE TABLE IF NOT EXISTS trivia_rewards (
        user_id VARCHAR(32) NOT NULL,
        season CHAR(7) NOT NULL,
        points INT NOT NULL,
        given_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, season)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS trivia_season_jobs (
        season CHAR(7) PRIMARY KEY,
        rewards_done_at BIGINT DEFAULT NULL,
        roles_done_at BIGINT DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS trivia_role_holders (
        guild_id VARCHAR(32) NOT NULL,
        \`rank\` TINYINT NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        role_id VARCHAR(32) NOT NULL,
        season CHAR(7) NOT NULL,
        PRIMARY KEY (guild_id, \`rank\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // Top-3 role columns (the website adds the same ones; whoever is second only gets "Duplicate column")
    for (const col of ['role_top1', 'role_top2', 'role_top3']) {
        const [has] = await pool.execute("SHOW COLUMNS FROM trivia_guild LIKE '" + col + "'");
        if (has.length) continue;
        await pool.execute('ALTER TABLE trivia_guild ADD COLUMN ' + col + ' VARCHAR(32) DEFAULT NULL').catch(err => {
            if (err.code !== 'ER_DUP_FIELDNAME' && !/Duplicate column/i.test(err.message)) throw err;
        });
    }
    tablesReady = true;
}

// ---------- helpers ----------
const prevSeason = season => W.seasonOf(W.addDays(season + '-01', -1));
const nextSeason = season => W.seasonOf(W.addDays(season + '-01', 32));
const seasonName = season => MONTHS[Number(season.slice(5, 7)) - 1] + ' ' + season.slice(0, 4);
const seasonRange = season => [season + '-01', nextSeason(season) + '-01']; // day >= from AND day < to
// When a Discord account was made (from its id)
const accountCreatedAt = id => { try { return Number((BigInt(String(id)) >> 22n) + 1420070400000n); } catch (e) { return Date.now(); } };
const pointsFor = bits => { for (const [min, pts] of REWARD_TIERS) if (bits >= min) return pts; return 0; };

function rewardMessage(bits, points, season) {
    return '🎉 Congratulations! You earned **' + bits.toLocaleString('en-US') + ' bits** in Pingway Trivia in ' + seasonName(season) +
        ' — here are **' + points + ' points** as a thank-you. Use them for extra retainers or Supporter Perks at ' + SITE + '/me.html';
}

// ---------- points (copied from the website's lib/credits.js, same rules as vote/Ko-fi points) ----------
const FREE_SLOTS = 2;
const PERKS_COST = 10;
const RENEWAL_GRACE_MS = 48 * 60 * 60 * 1000;
const ON = 1, PAUSED = 2;
const stateOf = r => Number(r.enabled === undefined || r.enabled === null ? ON : r.enabled);

function addOneMonth(ts) {
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const day = Math.min(d.getUTCDate(), lastDay);
    return Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}
function newClaimCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'PW-';
    for (const b of require('crypto').randomBytes(6)) code += alphabet[b % alphabet.length];
    return code;
}
async function balance(conn, userId, now) {
    const [[row]] = await conn.execute(
        'SELECT COALESCE(SUM(credits_left), 0) AS bal FROM credit_lots WHERE user_id = ? AND credits_left > 0 AND (expires_at = 0 OR expires_at > ?)',
        [userId, now]
    );
    return Number(row.bal) || 0;
}
async function consume(conn, userId, amount, now) {
    let left = amount;
    const [lots] = await conn.execute(
        'SELECT id, credits_left FROM credit_lots WHERE user_id = ? AND credits_left > 0 AND (expires_at = 0 OR expires_at > ?) ORDER BY (expires_at = 0), expires_at, id FOR UPDATE',
        [userId, now]
    );
    for (const lot of lots) {
        if (left <= 0) break;
        const take = Math.min(left, Number(lot.credits_left));
        await conn.execute('UPDATE credit_lots SET credits_left = credits_left - ? WHERE id = ?', [take, lot.id]);
        left -= take;
    }
    if (left > 0) throw new Error('consume: not enough credits');
}
async function getAccount(conn, userId, lock) {
    const [[acct]] = await conn.execute('SELECT * FROM supporter_account WHERE user_id = ?' + (lock ? ' FOR UPDATE' : ''), [userId]);
    return acct || null;
}
async function getOrCreateAccount(conn, userId, now) {
    let acct = await getAccount(conn, userId, true);
    if (acct) return acct;
    for (let i = 0; i < 5; i++) {
        try {
            await conn.execute('INSERT INTO supporter_account (user_id, claim_code, created_at) VALUES (?, ?, ?)', [userId, newClaimCode(), now]);
            break;
        } catch (e) {
            if (e.code !== 'ER_DUP_ENTRY') throw e;
            acct = await getAccount(conn, userId, true);
            if (acct) return acct;
        }
    }
    return getAccount(conn, userId, true);
}
async function saveAccount(conn, userId, cycleStart, cycleEnd, paidSlots) {
    await conn.execute('UPDATE supporter_account SET cycle_start = ?, cycle_end = ?, paid_slots = ?, paused = 0 WHERE user_id = ?', [cycleStart, cycleEnd, paidSlots, userId]);
}
// Waiting Retainer Watch renewal (same as the website's settle)
async function settle(conn, userId, now) {
    const acct = await getAccount(conn, userId, true);
    if (!acct || acct.cycle_end === null || Number(acct.cycle_end) > now) return;
    let cycleStart = Number(acct.cycle_start);
    let cycleEnd = Number(acct.cycle_end);
    let guard = 0;
    while (cycleEnd <= now && guard++ < 600) {
        const [rows] = await conn.execute('SELECT * FROM retainer_watch WHERE user_id = ? ORDER BY created_at, id', [userId]);
        const on = rows.filter(r => stateOf(r) === ON);
        const extras = Math.max(0, on.length - FREE_SLOTS);
        if (extras > 0) {
            if (await balance(conn, userId, now) >= extras) {
                cycleStart = cycleEnd;
                cycleEnd = addOneMonth(cycleStart);
                await consume(conn, userId, extras, now);
                await saveAccount(conn, userId, cycleStart, cycleEnd, extras);
                continue;
            }
            if (now < cycleEnd + RENEWAL_GRACE_MS) return;
        }
        for (const r of on.slice(FREE_SLOTS)) await conn.execute('UPDATE retainer_watch SET enabled = ?, active = 0 WHERE id = ?', [PAUSED, r.id]);
        await saveAccount(conn, userId, null, null, 0);
        return;
    }
}
async function savePerks(conn, userId, state, start, end, now) {
    await conn.execute(
        `INSERT INTO supporter_perks (user_id, state, cycle_start, cycle_end, updated_at) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE state = VALUES(state), cycle_start = VALUES(cycle_start), cycle_end = VALUES(cycle_end), updated_at = VALUES(updated_at)`,
        [userId, state, start, end, now]
    );
}
// Waiting Supporter Perks renewal (same as the website's settlePerks)
async function settlePerks(conn, userId, now) {
    const [[row]] = await conn.execute('SELECT * FROM supporter_perks WHERE user_id = ? FOR UPDATE', [userId]);
    if (!row || row.cycle_end === null || Number(row.cycle_end) > now) return;
    let start = Number(row.cycle_start), end = Number(row.cycle_end);
    if (row.state === 'canceled') return savePerks(conn, userId, 'off', null, null, now);
    if (row.state !== 'active') return;
    let guard = 0;
    while (end <= now && guard++ < 600) {
        if (await balance(conn, userId, now) >= PERKS_COST) {
            await consume(conn, userId, PERKS_COST, now);
            start = end;
            end = addOneMonth(start);
            continue;
        }
        if (now < end + RENEWAL_GRACE_MS) return savePerks(conn, userId, 'active', start, end, now);
        return savePerks(conn, userId, 'off', null, null, now);
    }
    await savePerks(conn, userId, 'active', start, end, now);
}

// Points tables are made by the website. Not ready (or credits not yet converted to points) -> try again later.
async function pointsReady() {
    try {
        const [done] = await pool.execute('SELECT name FROM bot_migrations WHERE name = ?', [POINTS_MIGRATION]);
        if (!done.length) return { ok: false, why: 'credits are not converted to points yet' };
        for (const t of ['credit_lots', 'supporter_account']) {
            const [has] = await pool.query("SHOW TABLES LIKE '" + t + "'");
            if (!has.length) return { ok: false, why: 'table ' + t + ' does not exist yet' };
        }
        const [perks] = await pool.query("SHOW TABLES LIKE 'supporter_perks'");
        return { ok: true, perks: perks.length > 0 };
    } catch (err) {
        if (isMissingTable(err)) return { ok: false, why: 'points tables do not exist yet' };
        throw err;
    }
}

// One player's reward. Returns true when given now, false when it was already given.
async function giveReward(userId, season, points, perksTable, now) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        try {
            await conn.execute('INSERT INTO trivia_rewards (user_id, season, points, given_at) VALUES (?, ?, ?, ?)', [userId, season, points, now]);
        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') { await conn.rollback(); return false; }
            throw e;
        }
        await getOrCreateAccount(conn, userId, now);
        await conn.execute(
            'INSERT INTO credit_lots (user_id, credits_total, credits_left, source, ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId, points, points, 'reward', 'trivia-' + season, now, now + CREDIT_VALIDITY_DAYS * 864e5]
        );
        await settle(conn, userId, now);                       // a waiting Retainer Watch renewal can go ahead
        if (perksTable) await settlePerks(conn, userId, now);  // a waiting Supporter Perks renewal too
        await conn.commit();
        return true;
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

async function sendRewardDm(client, userId, bits, points, season) {
    if (!client || dmStatus.isBlocked(userId)) return;
    let user;
    try {
        user = await client.users.fetch(userId);
    } catch (err) {
        console.log('🎁 [TRIVIA] Could not find user ' + userId + ' for the reward DM (' + (err.code || err.message) + '). Points were still added.');
        if (err && err.code === 10013) await dmStatus.markFailed(userId, 'unknown_user');
        return;
    }
    try {
        await user.send(rewardMessage(bits, points, season));
        await dmStatus.markOk(userId);
    } catch (err) {
        console.log('🎁 [TRIVIA] Could not DM user ' + userId + ' about the reward (' + (err.code || err.message) + '). Points were still added.');
        if (err && err.code === 50007) await dmStatus.markFailed(userId, 'dm_closed');
    }
}

// Returns true when every reward of the season is done (false = try again on the next run)
async function runRewards(client, season) {
    const ready = await pointsReady();
    if (!ready.ok) {
        logOnce('points', '⚠️ [TRIVIA] Season ' + season + ' rewards are waiting: ' + ready.why + '.');
        return false;
    }
    const [from, to] = seasonRange(season);
    const [rows] = await pool.execute(
        "SELECT user_id, SUM(bits) AS month_bits, COUNT(DISTINCT day) AS solve_days FROM trivia_plays WHERE status = 'solved' AND day >= ? AND day < ? " +
        'GROUP BY user_id HAVING SUM(bits) >= ?',
        [from, to, REWARD_TIERS[REWARD_TIERS.length - 1][0]]
    );
    let players = 0, total = 0, failed = 0;
    for (const r of rows) {
        const userId = String(r.user_id);
        const bits = Number(r.month_bits) || 0;
        const points = pointsFor(bits);
        const now = Date.now();
        if (!points || Number(r.solve_days) < MIN_SOLVE_DAYS || now - accountCreatedAt(userId) < MIN_ACCOUNT_AGE_MS) continue;
        let given;
        try {
            given = await giveReward(userId, season, points, ready.perks, now);
        } catch (err) {
            failed++;
            logOnce('reward:' + userId, '❌ [TRIVIA] Season ' + season + ' reward for ' + userId + ' failed (will try again): ' + err.message);
            continue;
        }
        if (!given) continue;
        players++;
        total += points;
        await sendRewardDm(client, userId, bits, points, season);
    }
    console.log('🎁 [TRIVIA] Season ' + season + ' rewards: ' + players + ' player(s), ' + total + ' points.' + (failed ? ' ' + failed + ' failed, trying again later.' : ''));
    return failed === 0;
}

// ---------- server top-3 roles ----------
// A server's leaderboard of the season (same people as the website board: played there, not hidden), best first
async function guildRanking(guildId, season) {
    const [from, to] = seasonRange(season);
    const [rows] = await pool.execute(
        'SELECT p.user_id, SUM(t.bits) AS month_bits, MAX(t.finished_at) AS reached FROM trivia_players p ' +
        'JOIN trivia_users u ON u.user_id = p.user_id ' +
        "JOIN trivia_plays t ON t.user_id = p.user_id AND t.status = 'solved' AND t.day >= ? AND t.day < ? " +
        'WHERE p.guild_id = ? AND u.hidden = 0 GROUP BY p.user_id HAVING SUM(t.bits) > 0 ' +
        'ORDER BY month_bits DESC, reached ASC, p.user_id',
        [from, to, String(guildId)]
    );
    return rows.map(r => String(r.user_id));
}

const isUnknownMember = err => err && (err.code === 10007 || err.code === 10013);
async function fetchMember(guild, userId) {
    try {
        return await guild.members.fetch(userId);
    } catch (err) {
        if (isUnknownMember(err)) return null; // left the server
        throw err;
    }
}

const permBits = role => { try { return BigInt(role.permissions && role.permissions.bitfield !== undefined ? role.permissions.bitfield : 0); } catch (e) { return 0n; } };
// What Pingway may do with a role: give (a safe role it can manage), remove (it can manage it), why (problem, if any).
// Roles with dangerous permissions can only be removed (from last month's holder), never given.
async function manageableRole(guild, me, roleId) {
    let role = guild.roles.cache.get(roleId);
    if (!role) role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return { give: false, remove: false, why: 'role ' + roleId + ' no longer exists' };
    if (role.id === guild.id) return { give: false, remove: false, why: 'the @everyone role can\'t be a prize' };
    if (role.managed) return { give: false, remove: false, why: 'role ' + role.name + ' is managed by Discord or an integration' };
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return { give: false, remove: false, why: 'Pingway is missing Manage Roles' };
    if (role.position >= me.roles.highest.position) return { give: false, remove: false, why: 'role ' + role.name + ' is not below Pingway\'s highest role' };
    if (permBits(role) & DANGEROUS_PERMS) return { give: false, remove: true, why: 'role ' + role.name + ' has moderator/admin permissions, so it is never given' };
    return { give: true, remove: true, why: null };
}

async function runGuildRoles(client, g, season, holders) {
    const guildId = String(g.guild_id);
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return; // Pingway is not in this server anymore
    const me = guild.members.me || await guild.members.fetchMe();
    const roleIds = { 1: g.role_top1 ? String(g.role_top1) : null, 2: g.role_top2 ? String(g.role_top2) : null, 3: g.role_top3 ? String(g.role_top3) : null };
    const old = {};
    for (const h of holders) old[Number(h.rank)] = { userId: String(h.user_id), roleId: String(h.role_id) };

    // What can be done with each role (problems logged once per server and role)
    const usable = {};
    for (const id of new Set([...Object.values(roleIds), ...Object.values(old).map(h => h.roleId)].filter(Boolean))) {
        const res = await manageableRole(guild, me, id);
        usable[id] = res;
        if (res.why && Object.values(roleIds).includes(id)) logOnce('roles:' + guildId + ':' + id, '⚠️ [TRIVIA] Top-3 roles in ' + (guild.name || guildId) + ': skipped (' + res.why + ').');
    }
    const canGive = r => Boolean(roleIds[r] && usable[roleIds[r]].give);

    // Winners: the ranking, skipping people who left the server
    const winners = {};
    const ranked = await guildRanking(guildId, season);
    let rank = 1;
    for (const userId of ranked) {
        if (rank > 3) break;
        if (!(await fetchMember(guild, userId))) continue;
        winners[rank++] = userId;
    }

    // Ranks that change this time: the role can be given or at least taken back (a dangerous role: only taken back
    // from last month's holder), or no role is set anymore (old holder cleaned up). Other ranks keep their holder.
    const ranks = [1, 2, 3].filter(r => roleIds[r] ? usable[roleIds[r]].remove : old[r]);
    const keep = new Set(ranks.filter(r => canGive(r) && winners[r]).map(r => winners[r] + ':' + roleIds[r]));
    // Also keep what other ranks still hold (skipped ranks keep their holder)
    for (const r of [1, 2, 3]) if (!ranks.includes(r) && old[r]) keep.add(old[r].userId + ':' + old[r].roleId);

    const roleError = (err, what) => logOnce('roles:' + guildId + ':' + what, '⚠️ [TRIVIA] Top-3 roles in ' + (guild.name || guildId) + ': could not ' + what + ' (' + err.message + ').');
    // Take the roles from last month's holders first
    for (const r of ranks) {
        const h = old[r];
        if (!h || keep.has(h.userId + ':' + h.roleId) || !usable[h.roleId].remove) continue;
        const member = await fetchMember(guild, h.userId);
        if (member && member.roles.cache.has(h.roleId)) {
            await member.roles.remove(h.roleId, 'Pingway Trivia: top ' + r + ' of ' + season + ' went to someone else').catch(err => roleError(err, 'remove a role'));
        }
    }
    // Then give them to this month's top 3, and save who has them
    for (const r of ranks) {
        await pool.execute('DELETE FROM trivia_role_holders WHERE guild_id = ? AND `rank` = ?', [guildId, r]);
        if (!canGive(r) || !winners[r]) continue;
        const member = await fetchMember(guild, winners[r]);
        if (!member) continue;
        if (!member.roles.cache.has(roleIds[r])) {
            const okGive = await member.roles.add(roleIds[r], 'Pingway Trivia: top ' + r + ' of ' + season).then(() => true, err => { roleError(err, 'give a role'); return false; });
            if (!okGive) continue;
        }
        await pool.execute('INSERT INTO trivia_role_holders (guild_id, `rank`, user_id, role_id, season) VALUES (?, ?, ?, ?, ?)', [guildId, r, winners[r], roleIds[r], season]);
    }
}

// Returns true when done (false = a Discord error, try again on the next run)
async function runRoles(client, season) {
    if (!client || !client.guilds) return false;
    const [guilds] = await pool.execute(
        'SELECT guild_id, role_top1, role_top2, role_top3 FROM trivia_guild WHERE role_top1 IS NOT NULL OR role_top2 IS NOT NULL OR role_top3 IS NOT NULL ' +
        'OR guild_id IN (SELECT guild_id FROM trivia_role_holders)'
    );
    const [allHolders] = await pool.execute('SELECT guild_id, `rank`, user_id, role_id FROM trivia_role_holders');
    let done = 0, failed = 0;
    for (const g of guilds) {
        try {
            await runGuildRoles(client, g, season, allHolders.filter(h => String(h.guild_id) === String(g.guild_id)));
            done++;
        } catch (err) {
            failed++;
            logOnce('rolesrun:' + g.guild_id, '❌ [TRIVIA] Top-3 roles in server ' + g.guild_id + ' failed: ' + err.message);
        }
    }
    if (guilds.length) console.log('🏅 [TRIVIA] Season ' + season + ' top-3 roles: ' + done + ' server(s) updated' + (failed ? ', ' + failed + ' failed' : '') + '.');
    return failed === 0;
}

// ---------- schedule ----------
async function tick(client) {
    if (running) return;
    running = true;
    try {
        await ensureTables();
        const season = prevSeason(W.seasonOf(W.dayOf())); // the month that just ended (never the current one)
        if (season < FIRST_SEASON) {
            await pool.execute('INSERT IGNORE INTO trivia_season_jobs (season, rewards_done_at, roles_done_at) VALUES (?, ?, ?)', [season, Date.now(), Date.now()]);
            return;
        }
        await pool.execute('INSERT IGNORE INTO trivia_season_jobs (season) VALUES (?)', [season]);
        const [[job]] = await pool.execute('SELECT rewards_done_at, roles_done_at FROM trivia_season_jobs WHERE season = ?', [season]);
        if (job.rewards_done_at === null) {
            if (await runRewards(client, season)) await pool.execute('UPDATE trivia_season_jobs SET rewards_done_at = ? WHERE season = ?', [Date.now(), season]);
        }
        if (job.roles_done_at === null && client && client.guilds) {
            const tries = (roleTries.get(season) || 0) + 1;
            if (await runRoles(client, season) || tries >= ROLE_RETRIES) {
                await pool.execute('UPDATE trivia_season_jobs SET roles_done_at = ? WHERE season = ?', [Date.now(), season]);
                roleTries.delete(season);
            } else {
                roleTries.set(season, tries);
            }
        }
    } catch (err) {
        logOnce('tick', '❌ [TRIVIA] Season end check failed: ' + err.message);
    } finally {
        running = false;
    }
}

function start(client) {
    if (started) return;
    started = true;
    setTimeout(() => tick(client), FIRST_RUN_MS);
    setInterval(() => tick(client), POLL_MS);
}

module.exports = { start, tick, rewardMessage, pointsFor, accountCreatedAt, prevSeason, guildRanking, _reset: () => { tablesReady = false; running = false; roleTries.clear(); errorLogged.clear(); } };
