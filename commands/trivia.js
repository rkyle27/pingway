// /trivia: Pingway Trivia — Guess the word. Free for everyone.
// The whole game is ONE private (ephemeral) message that changes in place like an app:
//   start screen -> pick a difficulty -> game -> result. "Back" returns to the difficulty menu.
// Each difficulty has its own FFXIV word of the day (same for everyone). One solve per person per JST day in all
// servers; giving up or running out of guesses locks that difficulty for the day. New words at 0:00 JST.
// Buttons use customIds starting with 'tv_' (no other handler picks them up); everything is handled by a collector
// on this message, filtered to the person who ran the command. Game rules and data: utils/trivia.js, utils/triviaWords.js.

const {
    SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const T = require('../utils/trivia');
const W = require('../utils/triviaWords');
const { isMaintenance } = require('../maintenance');

const TITLE = '🧩 **Pingway Trivia — Guess the word**';
const IDLE_MS = 14 * 60 * 1000;
const STATUS_ICON = { solved: '✅', gaveup: '🏳️', failed: '❌', playing: '▶' };
const STATUS_TEXT = { solved: 'solved', gaveup: 'gave up', failed: 'out of guesses', playing: 'in progress' };

const btn = (id, label, style, emoji, disabled) => {
    const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
    if (emoji) b.setEmoji(emoji);
    if (disabled) b.setDisabled(true);
    return b;
};
const row = (...b) => new ActionRowBuilder().addComponents(...b);

function untilReset() {
    const mins = Math.max(1, Math.ceil(W.msToReset() / 60000));
    return (mins >= 60 ? Math.floor(mins / 60) + ' h ' : '') + (mins % 60) + ' min';
}
const n = v => Number(v || 0).toLocaleString('en-US');

function displayNameOf(interaction) {
    const m = interaction.member;
    return (m && (m.displayName || m.nick)) || interaction.user.globalName || interaction.user.username || 'Player';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trivia')
        .setDescription('🧩 Guess the FFXIV word of the day in 6 difficulties, earn bits and keep your streak.'),

    async execute(interaction) {
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({ content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!', flags: [MessageFlags.Ephemeral] });
        }
        const userId = interaction.user.id;
        const guildId = interaction.guildId || null;
        let last = interaction;      // newest interaction (its token edits the message)
        let diff = null;             // difficulty on screen
        let feedback = '';           // one line under the game ("Not it", new hint…)

        try {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            await T.touchPlayer({ userId, guildId, displayName: displayNameOf(interaction), avatar: interaction.user.avatar });
        } catch (err) {
            console.error('❌ [TRIVIA] start:', err.message);
            return interaction.editReply({ content: '❌ Trivia is not available right now. Please try again in a minute.' }).catch(() => {});
        }

        // ---------- screens ----------
        const warming = () => {
            T.refreshBank();
            return { content: TITLE + '\n⏳ Trivia is warming up, try again in a minute.', components: [] };
        };

        const shareInfo = async st => {
            if (!guildId || !st.solved || st.solved.shared) return null;
            return T.shareChannel(guildId);
        };

        async function home() {
            const day = W.dayOf();
            const [st, u, yest, words] = await Promise.all([T.dayStatus(userId, day), T.getUser(userId), T.yesterdayAnswers(day), T.wordsOf(day)]);
            if (!words) return warming();
            const streak = W.liveStreak(u, day);
            const season = u && u.season_key === W.seasonOf(day) ? Number(u.season_bits) || 0 : 0;
            const playing = W.DIFFICULTIES.find(d => st.plays[d.key] && st.plays[d.key].status === 'playing');
            const lines = [TITLE,
                'Guess the FFXIV word of the day. 6 difficulties, each with its own word. One solve a day, in every server.',
                '',
                '**You:** 🔥 Streak ' + streak + ' · 💎 ' + n(season) + ' bits this month · ' + n(u && u.bits_total) + ' all time'];
            if (st.solved) lines.push('✅ You solved today\'s **' + W.DIFF[st.solved.difficulty].name + '** (+' + st.solved.bits + ' bits). Come back after 0:00 JST! (in ' + untilReset() + ')');
            else if (playing) lines.push('▶ Your **' + playing.name + '** game is waiting for you.');
            else lines.push('⏳ New words in ' + untilReset() + ' (0:00 JST).');
            const y = W.DIFFICULTIES.filter(d => yest[d.key]);
            lines.push('', '**Yesterday\'s answers**');
            lines.push(y.length ? y.map(d => d.emoji + ' ' + d.name + ': ||' + yest[d.key] + '||').join('\n') : '_None yet — come back tomorrow!_');
            const buttons = [btn('tv_play', st.solved ? 'Today\'s results' : playing ? 'Continue' : 'Play', ButtonStyle.Primary, st.solved ? '📋' : '▶'),
                btn('tv_howto', 'How to play', ButtonStyle.Secondary, '❓')];
            if (await shareInfo(st)) buttons.push(btn('tv_share', 'Share result', ButtonStyle.Success, '📣'));
            return { content: lines.join('\n'), components: [row(...buttons)] };
        }

        function howTo() {
            return {
                content: [TITLE,
                    '• Each box is one letter: ⬜ hidden, 🇦 shown. Spaces and symbols are always shown.',
                    '• Press **Guess** and type the whole answer. Case, accents, spaces and symbols don\'t matter.',
                    '• A wrong guess shows one more letter. Too many wrong guesses and that difficulty locks for the day.',
                    '• **Hint** gives a clue (no letters). **Give up** locks that difficulty for today; you can still try another.',
                    '• After one solve you\'re done for the day, in every server. New words at 0:00 JST.',
                    '',
                    '**Bits:** base × (2 − (hints + wrong guesses) ÷ guess limit), never below base. A perfect solve gives double.',
                    W.DIFFICULTIES.map(d => d.emoji + ' ' + d.name + ': ' + d.base + ' bit' + (d.base === 1 ? '' : 's') + ', ' + d.limit + ' wrong guesses').join(' · '),
                    '**Streak:** solve on days in a row. Bonus at 5/10/15/20/30 days: +10/+20/+30/+40/+60 bits. Streaks and the monthly leaderboard start again on the 1st.',
                    'Leaderboards: pingway.app → Trivia. You can hide yourself in My Settings.'].join('\n'),
                components: [row(btn('tv_home', 'Back', ButtonStyle.Secondary, '↩'))]
            };
        }

        async function menu() {
            const day = W.dayOf();
            const [st, words] = await Promise.all([T.dayStatus(userId, day), T.wordsOf(day)]);
            if (!words) return warming();
            const lines = [TITLE, st.solved ? '✅ You solved today\'s **' + W.DIFF[st.solved.difficulty].name + '**. Come back after 0:00 JST!' : 'Pick a difficulty. Each one has its own word of the day.', ''];
            const buttons = W.DIFFICULTIES.map(d => {
                const p = st.plays[d.key];
                const s = p ? p.status : null;
                lines.push(d.emoji + ' **' + d.name + '** · ' + d.base + ' bit' + (d.base === 1 ? '' : 's') + ' · ' + d.limit + ' guesses — ' + (s ? STATUS_ICON[s] + ' ' + STATUS_TEXT[s] : 'new'));
                const locked = !!st.solved || (s && s !== 'playing');
                return btn('tv_d_' + d.key, d.name, s === 'solved' ? ButtonStyle.Success : s === 'playing' ? ButtonStyle.Primary : locked ? ButtonStyle.Danger : ButtonStyle.Secondary,
                    s ? STATUS_ICON[s] : d.emoji, locked);
            });
            return { content: lines.join('\n'), components: [row(...buttons.slice(0, 3)), row(...buttons.slice(3)), row(btn('tv_home', 'Back', ButtonStyle.Secondary, '↩'))] };
        }

        function gameScreen(word, play) {
            const d = W.DIFF[diff];
            const left = d.limit - play.wrong;
            const hints = play.hintsUsed.map(i => word.hints[i]).filter(Boolean);
            const lines = [TITLE, d.emoji + ' **' + d.name + '** · ' + left + ' wrong guess' + (left === 1 ? '' : 'es') + ' left · ' + hints.length + '/' + word.hints.length + ' hints', '',
                W.renderBoxes(word.word, play.revealed), ''];
            if (hints.length) lines.push(hints.map(h => '💡 ' + h).join('\n'));
            if (feedback) lines.push(feedback);
            return {
                content: lines.join('\n'),
                components: [row(
                    btn('tv_guess', 'Guess', ButtonStyle.Primary, '✏️'),
                    btn('tv_hint', 'Hint', ButtonStyle.Secondary, '💡', hints.length >= word.hints.length),
                    btn('tv_giveup', 'Give up', ButtonStyle.Danger, '🏳️'),
                    btn('tv_back', 'Back', ButtonStyle.Secondary, '↩'))]
            };
        }

        // Opens the chosen difficulty (or tells why it can't be played)
        async function openDiff() {
            const day = W.dayOf();
            const words = await T.wordsOf(day);
            if (!words) return warming();
            const r = await T.startPlay(userId, day, diff, guildId);
            if (!r.ok) return menu();
            return gameScreen(words[diff], r.play);
        }

        // "About" block: only on the result screen after a solve (it would spoil the answer before)
        const aboutBlock = word => {
            const lore = String((word && word.lore) || '').replace(/[_~`|]/g, '\\$&').replace(/@/g, '@\u200b');
            return lore ? ['', '📖 **About ' + word.word.replace(/[*_~`|\\]/g, '\\$&') + '**', lore] : ['', '📖 The answer was **' + word.word + '**.'];
        };

        async function solvedScreen(play, award, word) {
            const d = W.DIFF[play.difficulty];
            const lines = [TITLE, '✅ **Solved!** ' + d.emoji + ' ' + d.name + ' · +' + award.bits + ' bits (base ' + award.base + ', bonus ' + award.bonus + ')'];
            lines.push('🔥 Streak ' + award.streak + (award.streak === 1 ? ' day' : ' days') + (award.milestone ? ' · 🎉 Streak bonus +' + award.milestone + ' bits!' : ''));
            lines.push('💎 ' + n(award.seasonBits) + ' bits this month · ' + n(award.total) + ' all time');
            if (word) lines.push(...aboutBlock(word));
            lines.push('', 'That\'s it for today — come back after 0:00 JST (in ' + untilReset() + ').');
            const buttons = [btn('tv_back', 'Back', ButtonStyle.Secondary, '↩')];
            if (guildId && !play.shared && await T.shareChannel(guildId)) buttons.unshift(btn('tv_share', 'Share result', ButtonStyle.Success, '📣'));
            return { content: lines.join('\n'), components: [row(...buttons)] };
        }

        function lockedScreen(play) {
            const d = W.DIFF[play.difficulty];
            const why = play.status === 'gaveup' ? '🏳️ You gave up on **' + d.name + '**.' : '❌ Out of guesses on **' + d.name + '**.';
            return {
                content: [TITLE, why + ' It is locked for today.', 'You can still try another difficulty. The answer shows up in "Yesterday\'s answers" after 0:00 JST.'].join('\n'),
                components: [row(btn('tv_back', 'Back', ButtonStyle.Secondary, '↩'))]
            };
        }

        // ---------- actions ----------
        async function doShare(i) {
            const day = W.dayOf();
            const st = await T.dayStatus(userId, day);
            const chId = await shareInfo(st);
            if (!chId) return i.reply({ content: 'Nothing to share right now.', flags: [MessageFlags.Ephemeral] });
            const channel = await interaction.guild.channels.fetch(chId).catch(() => null);
            if (!channel || typeof channel.send !== 'function') return i.reply({ content: '⚠️ The Trivia share channel is gone. Ask an admin to pick a new one on the website.', flags: [MessageFlags.Ephemeral] });
            if (!(await T.markShared(userId, day, st.solved.difficulty))) return i.reply({ content: 'Already shared. 🙂', flags: [MessageFlags.Ephemeral] });
            const u = await T.getUser(userId);
            try {
                await channel.send({ content: T.shareLine(displayNameOf(interaction), st.solved.difficulty, st.solved, W.liveStreak(u, day)), allowedMentions: { parse: [] } });
            } catch (err) {
                await T.markShared(userId, day, st.solved.difficulty, true).catch(() => {});
                return i.reply({ content: '⚠️ Pingway can\'t post in <#' + chId + '>. Ask an admin to check its permissions there.', flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } });
            }
            const p = await home();
            p.content += '\n\n📣 Shared in <#' + chId + '>!';
            return i.update({ ...p, allowedMentions: { parse: [] } });
        }

        async function doGuess(i) {
            const modalId = 'tv_modal_' + i.id;
            const modal = new ModalBuilder().setCustomId(modalId).setTitle('Your guess (' + W.DIFF[diff].name + ')')
                .addComponents(row(new TextInputBuilder().setCustomId('answer').setLabel('Type the whole answer')
                    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
            await i.showModal(modal);
            const sub = await i.awaitModalSubmit({ filter: m => m.customId === modalId && m.user.id === userId, time: 10 * 60 * 1000 }).catch(() => null);
            if (!sub) return;
            last = sub;
            const day = W.dayOf();
            const words = await T.wordsOf(day);
            if (!words) return sub.update(warming());
            const answer = String(sub.fields.getTextInputValue('answer') || '').slice(0, 100);
            const r = await T.guess(userId, day, diff, words[diff], answer);
            if (r.result === 'solved') return sub.update({ ...(await solvedScreen(r.play, r.award, words[diff])), allowedMentions: { parse: [] } });
            if (r.result === 'failed') return sub.update(lockedScreen(r.play));
            if (r.result === 'wrong') {
                const left = W.DIFF[diff].limit - r.play.wrong;
                feedback = '❌ Not it' + (r.newLetter ? ' — one more letter is shown.' : '.') + ' ' + left + ' wrong guess' + (left === 1 ? '' : 'es') + ' left.';
                return sub.update(gameScreen(words[diff], r.play));
            }
            feedback = '';
            return sub.update(await menu());
        }

        const p0 = await home().catch(err => { console.error('❌ [TRIVIA] home:', err.message); return { content: '❌ Trivia is not available right now. Please try again in a minute.', components: [] }; });
        await interaction.editReply(p0);
        if (!p0.components || !p0.components.length) return;
        const message = await interaction.fetchReply();

        const collector = message.createMessageComponentCollector({ filter: i => i.user.id === userId && String(i.customId).startsWith('tv_'), idle: IDLE_MS });
        collector.on('collect', async i => {
            try {
                last = i;
                const id = i.customId;
                if (id === 'tv_home') { feedback = ''; return i.update(await home()); }
                if (id === 'tv_howto') return i.update(howTo());
                if (id === 'tv_play' || id === 'tv_back') { feedback = ''; return i.update(await menu()); }
                if (id === 'tv_share') return doShare(i);
                if (id.startsWith('tv_d_')) {
                    const key = id.slice(5);
                    if (!W.DIFF[key]) return i.update(await menu());
                    diff = key; feedback = '';
                    return i.update(await openDiff());
                }
                if (!diff) return i.update(await menu());
                if (id === 'tv_guess') return doGuess(i);
                if (id === 'tv_hint') {
                    const day = W.dayOf();
                    const words = await T.wordsOf(day);
                    if (!words) return i.update(warming());
                    const r = await T.useHint(userId, day, diff, words[diff]);
                    if (!r.play || r.play.status !== 'playing') return i.update(await menu());
                    feedback = r.ok ? '' : 'No more hints for this word.';
                    return i.update(gameScreen(words[diff], r.play));
                }
                if (id === 'tv_giveup') {
                    return i.update({
                        content: TITLE + '\n🏳️ **Give up?** This difficulty locks for today. (The answer is not shown until tomorrow.)',
                        components: [row(btn('tv_giveup_yes', 'Yes, give up', ButtonStyle.Danger), btn('tv_giveup_no', 'No, keep playing', ButtonStyle.Secondary))]
                    });
                }
                if (id === 'tv_giveup_yes') {
                    const play = await T.giveUp(userId, W.dayOf(), diff);
                    feedback = '';
                    if (!play || play.status === 'playing') return i.update(await menu());
                    return i.update(play.status === 'solved' ? await menu() : lockedScreen(play));
                }
                if (id === 'tv_giveup_no') return i.update(await openDiff());
            } catch (err) {
                console.error('❌ [TRIVIA] button:', err.message);
                if (!i.replied && !i.deferred) await i.reply({ content: '❌ Something went wrong. Please run /trivia again.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
        });
        collector.on('end', (c, reason) => {
            if (reason !== 'idle') return;
            last.editReply({ content: TITLE + '\n⌛ Session ended — run /trivia again.', components: [] }).catch(() => {});
        });
    }
};
