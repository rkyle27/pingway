// Top.gg vote thank-you DMs. The website (/api/topgg) gives the points and records each vote in topgg_votes;
// this module DMs the voter once per vote with their new balance and links to the website.
// dm_state: 0 = waiting, 3 = sending, 1 = sent, 2 = could not DM, 4 = skipped (too old, e.g. bot was offline).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { pool } = require('./db');

const POLL_MS = 30 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // don't DM about votes older than a day
const SITE = 'https://pingway.app';
const VOTE_URL = 'https://top.gg/bot/1530586586524418048/vote';

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

function buildMessage(points, bal) {
    const embed = new EmbedBuilder()
        .setColor('#a78bfa')
        .setTitle('💜 Thanks for voting for Pingway!')
        .setDescription(
            'You got **+' + points + ' point' + (points === 1 ? '' : 's') + '**' + (points === 2 ? ' (weekend double vote!)' : '') + '.\n' +
            'Your balance: **' + bal.toLocaleString('en-US') + ' point' + (bal === 1 ? '' : 's') + '**\n\n' +
            '• 1 point = 1 extra Retainer Watch retainer for a month\n' +
            '• 10 points = Supporter Perks for a month\n\n' +
            'You can vote again in 12 hours. Manage your points on the [Pingway website](' + SITE + ').'
        )
        .setFooter({ text: 'Vote points expire 180 days after the vote.' });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Pingway website').setEmoji('🌐').setURL(SITE + '/retainers.html'),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Supporter Perks').setEmoji('✨').setURL(SITE + '/me.html#perks'),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Vote on top.gg').setEmoji('🗳️').setURL(VOTE_URL)
    );
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
                await user.send(buildMessage(Number(v.points) || 1, await balance(String(v.user_id))));
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

module.exports = { start, tick, buildMessage };
