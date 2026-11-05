// Vote thank-you DMs (top.gg, discordbotlist.com, discordlist.gg). The website (/api/topgg, /api/dblvote, /api/dlistvote) gives the points and records each vote in topgg_votes;
// this module DMs the voter once per vote with their new balance and links to the website.
// dm_state: 0 = waiting, 3 = sending, 1 = sent, 2 = could not DM, 4 = skipped (too old, e.g. bot was offline).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { pool } = require('./db');

const POLL_MS = 30 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // don't DM about votes older than a day
const SITE = 'https://pingway.app';

// Vote sites. To add a new vote site, add ONE entry here (the website must write its votes to topgg_votes with its own vote_id prefix).
// vote_id prefixes written by the website:
//   top.gg             'v1:<top.gg vote id>' (v1 webhooks) or 'v0:<userId>:<ms>' (legacy webhooks)   - pingway-dashboard/api/topgg.js
//   discordbotlist.com 'dbl:<userId>:<ms>'                                                        - pingway-dashboard/api/dblvote.js
//   discordlist.gg     'dlist:<userId>:<ms>'                                                      - pingway-dashboard/api/dlistvote.js
// A vote_id no entry matches still gets a plain thank-you DM (no site name, no vote button).
const VOTE_SITES = {
    topgg: { name: 'top.gg', url: 'https://top.gg/bot/1530586586524418048/vote', match: id => /^v[01]:/.test(id), weekendDouble: true, every: '12 hours' },
    dbl:   { name: 'discordbotlist.com', url: 'https://discordbotlist.com/bots/pingway/upvote', match: id => id.startsWith('dbl:'), weekendDouble: false, every: '12 hours' },
    dlist: { name: 'discordlist.gg', url: 'https://discordlist.gg/bot/1530586586524418048/vote', match: id => id.startsWith('dlist:'), weekendDouble: false, every: '12 hours' }
};

function siteFor(voteId) {
    const id = String(voteId || '');
    for (const key of Object.keys(VOTE_SITES)) {
        try { if (VOTE_SITES[key].match(id)) return VOTE_SITES[key]; } catch (e) { /* bad entry: treat as no match */ }
    }
    return null;
}

let started = false;
let running = false;
let warned = 0;

async function balance(userId) {
    const [[row]] = await pool.execute(
        'SELECT COALESCE(SUM(credits_left), 0) AS bal FROM credit_lots WHERE user_id = ? AND credits_left > 0 AND (expires_at = 0 OR expires_at > ?)',
        [userId, Date.now()]
    );
    return Number(row.bal) || 0;
}

function buildMessage(points, bal, voteId) {
    const site = siteFor(voteId);
    const embed = new EmbedBuilder()
        .setColor('#a78bfa')
        .setTitle('💜 Thanks for voting for Pingway!')
        .setDescription(
            'You got **+' + points + ' point' + (points === 1 ? '' : 's') + '**' + (site ? ' for voting on **' + site.name + '**' : '') + (site && site.weekendDouble && points === 2 ? ' (weekend double vote!)' : '') + '.\n' +
            'Your balance: **' + bal.toLocaleString('en-US') + ' point' + (bal === 1 ? '' : 's') + '**\n\n' +
            '• 1 point = 1 extra Retainer Watch retainer for a month\n' +
            '• 10 points = Supporter Perks for a month\n\n' +
            (site ? 'You can vote again on ' + site.name + ' in ' + site.every + '. ' : '') + 'Manage your points on the [Pingway website](' + SITE + ').'
        )
        .setFooter({ text: 'Vote points expire 180 days after the vote.' });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Pingway website').setEmoji('🌐').setURL(SITE + '/retainers.html'),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Supporter Perks').setEmoji('✨').setURL(SITE + '/me.html#perks')
    );
    if (site) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Vote again on ' + site.name).setEmoji('🗳️').setURL(site.url));
    return { embeds: [embed], components: [row] };
}

async function tick(client) {
    if (running) return;
    running = true;
    try {
        const now = Date.now();
        await pool.execute('UPDATE topgg_votes SET dm_state = 4 WHERE dm_state = 0 AND created_at < ?', [now - MAX_AGE_MS]);
        const [rows] = await pool.execute('SELECT vote_id, user_id, points FROM topgg_votes WHERE dm_state = 0 ORDER BY created_at LIMIT 20');
        for (const v of rows) {
            const [res] = await pool.execute('UPDATE topgg_votes SET dm_state = 3 WHERE vote_id = ? AND dm_state = 0', [v.vote_id]);
            if (!res || res.affectedRows !== 1) continue; // already taken
            let state = 2;
            try {
                const user = await client.users.fetch(String(v.user_id));
                await user.send(buildMessage(Number(v.points) || 1, await balance(String(v.user_id)), v.vote_id));
                state = 1;
                console.log('🗳️ [VOTE] Thank-you DM sent to user ' + v.user_id + ' (+' + v.points + ').');
            } catch (err) {
                console.log('🗳️ [VOTE] Could not DM voter ' + v.user_id + ' (' + (err.code || err.message) + '). Points were still added.');
            }
            await pool.execute('UPDATE topgg_votes SET dm_state = ? WHERE vote_id = ?', [state, v.vote_id]);
        }
    } catch (err) {
        // The website creates the table on the first vote
        if (!/doesn't exist|no such table/i.test(err.message) && Date.now() - warned > 60 * 60 * 1000) {
            warned = Date.now();
            console.error('❌ [VOTE] Vote DM check failed:', err.message);
        }
    } finally {
        running = false;
    }
}

function start(client) {
    if (started) return;
    started = true;
    setTimeout(() => tick(client), 10 * 1000);
    setInterval(() => tick(client), POLL_MS);
}

module.exports = { start, tick, buildMessage, VOTE_SITES };
