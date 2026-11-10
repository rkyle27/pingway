// /trivia: Pingway Trivia — Guess the word. Free for everyone.
// The whole game is ONE private (ephemeral) message that changes in place like an app:
//   start screen -> pick a difficulty -> game -> result. "Back" returns to the difficulty menu.
// Each difficulty has its own FFXIV word of the day (same for everyone). One solve per person per JST day in all
// servers; giving up or running out of guesses locks that difficulty for the day. New words at 0:00 JST.
// Buttons use customIds starting with 'tv_' (no other handler picks them up); everything is handled by a collector
// on this message, filtered to the person who ran the command. Game rules and data: utils/trivia.js, utils/triviaWords.js.
// Languages: the screens use the player's language (utils/userLanguage.js: their /pingway choice, else their Discord
// language, else English), chosen once when /trivia starts. Texts: locales/<lang>/trivia.json. The word of the day is
// the same for everyone and shown with its official name in that language. The public share post uses the server's language.

const {
    SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const T = require('../utils/trivia');
const W = require('../utils/triviaWords');
const i18n = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');
const { isMaintenance } = require('../maintenance');

const IDLE_MS = 14 * 60 * 1000;
const STATUS_ICON = { solved: '✅', gaveup: '🏳️', failed: '❌', playing: '▶' };
const NUMBER_LOCALE = { en: 'en-US', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP' };

const btn = (id, label, style, emoji, disabled) => {
    const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
    if (emoji) b.setEmoji(emoji);
    if (disabled) b.setDisabled(true);
    return b;
};
const row = (...b) => new ActionRowBuilder().addComponents(...b);

// Texts in one language: tx(key, vars), tc(key, count, vars) for the _one/_other forms, num(v) a formatted number
function texts(lang) {
    const tx = (key, vars) => i18n.t(lang, 'trivia.' + key, vars);
    const tc = (key, count, vars) => tx(key + '_' + W.pluralOf(lang, count), Object.assign({ n: count }, vars));
    const num = v => Number(v || 0).toLocaleString(NUMBER_LOCALE[lang] || 'en-US');
    const untilReset = () => {
        const mins = Math.max(1, Math.ceil(W.msToReset() / 60000));
        return mins >= 60 ? tx('time.hm', { h: Math.floor(mins / 60), m: mins % 60 }) : tx('time.m', { m: mins % 60 });
    };
    const diffName = key => tx('diff.' + key);
    return { tx, tc, num, untilReset, diffName, title: tx('title') };
}

// The player's language (never waits more than 1.5 s for the database: then their Discord language)
async function languageOf(interaction) {
    const live = i18n.fromDiscordLocale(interaction && interaction.locale) || i18n.DEFAULT_LANG;
    try {
        return await Promise.race([userLanguage.forInteraction(interaction), new Promise(res => setTimeout(() => res(live), 1500).unref())]);
    } catch (err) {
        return live;
    }
}

function displayNameOf(interaction) {
    const m = interaction.member;
    return (m && (m.displayName || m.nick)) || interaction.user.globalName || interaction.user.username || 'Player';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('trivia')
        .setDescription(i18n.t('en', 'trivia.command.description'))
        .setDescriptionLocalizations(i18n.discordLocalizations('trivia.command.description')),

    async execute(interaction) {
        const lang = await languageOf(interaction);
        const { tx, tc, num: n, untilReset, diffName, title: TITLE } = texts(lang);
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({ content: tx('maintenance'), flags: [MessageFlags.Ephemeral] });
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
            return interaction.editReply({ content: tx('notAvailable') }).catch(() => {});
        }

        // ---------- screens ----------
        const warming = () => {
            T.refreshBank();
            return { content: TITLE + '\n' + tx('warming'), components: [] };
        };

        const shareInfo = async st => {
            if (!guildId || !st.solved || st.solved.shared) return null;
            return T.shareChannel(guildId);
        };

        async function home() {
            const day = W.dayOf();
            const [st, u, yest, words] = await Promise.all([T.dayStatus(userId, day), T.getUser(userId), T.yesterdayAnswers(day, lang), T.wordsOf(day)]);
            if (!words) return warming();
            const streak = W.liveStreak(u, day);
            const season = u && u.season_key === W.seasonOf(day) ? Number(u.season_bits) || 0 : 0;
            const playing = W.DIFFICULTIES.find(d => st.plays[d.key] && st.plays[d.key].status === 'playing');
            const lines = [TITLE,
                tx('home.intro'),
                '',
                tx('home.you', { streak, season: n(season), total: n(u && u.bits_total) })];
            if (st.solved) lines.push(tx('home.solved', { diff: diffName(st.solved.difficulty), bits: st.solved.bits, time: untilReset() }));
            else if (playing) lines.push(tx('home.waiting', { diff: diffName(playing.key) }));
            else lines.push(tx('home.newWords', { time: untilReset() }));
            const y = W.DIFFICULTIES.filter(d => yest[d.key]);
            lines.push('', tx('home.yesterday'));
            lines.push(y.length ? y.map(d => d.emoji + ' ' + diffName(d.key) + ': ||' + yest[d.key] + '||').join('\n') : tx('home.yesterdayNone'));
            const buttons = [btn('tv_play', st.solved ? tx('buttons.results') : playing ? tx('buttons.continue') : tx('buttons.play'), ButtonStyle.Primary, st.solved ? '📋' : '▶'),
                btn('tv_howto', tx('buttons.howto'), ButtonStyle.Secondary, '❓')];
            if (st.solved) buttons.push(btn('tv_today', tx('buttons.todayWord'), ButtonStyle.Secondary, '📖'));
            if (await shareInfo(st)) buttons.push(btn('tv_share', tx('buttons.share'), ButtonStyle.Success, '📣'));
            return { content: lines.join('\n'), components: [row(...buttons)] };
        }

        function howTo() {
            return {
                content: [TITLE,
                    ...tx('howto.rules', { hints: W.HINTS_PER_GUESS }),
                    '',
                    tx('howto.bits'),
                    W.DIFFICULTIES.map(d => tx('howto.diff', { emoji: d.emoji, name: diffName(d.key), bits: tc('count.bits', d.base), wrong: tc('count.wrongGuesses', d.limit) })).join(' · '),
                    tx('howto.streak'),
                    tx('howto.boards')].join('\n'),
                components: [row(btn('tv_home', tx('buttons.back'), ButtonStyle.Secondary, '↩'))]
            };
        }

        async function menu() {
            const day = W.dayOf();
            const [st, words] = await Promise.all([T.dayStatus(userId, day), T.wordsOf(day)]);
            if (!words) return warming();
            const lines = [TITLE, st.solved ? tx('menu.solved', { diff: diffName(st.solved.difficulty) }) : tx('menu.pick'), ''];
            const buttons = W.DIFFICULTIES.map(d => {
                const p = st.plays[d.key];
                const s = p ? p.status : null;
                lines.push(tx('menu.line', { emoji: d.emoji, name: diffName(d.key), bits: tc('count.bits', d.base), limit: tc('count.limit', d.limit),
                    status: s ? STATUS_ICON[s] + ' ' + tx('status.' + s) : tx('status.new') }));
                const locked = !!st.solved || (s && s !== 'playing');
                return btn('tv_d_' + d.key, diffName(d.key), s === 'solved' ? ButtonStyle.Success : s === 'playing' ? ButtonStyle.Primary : locked ? ButtonStyle.Danger : ButtonStyle.Secondary,
                    s ? STATUS_ICON[s] : d.emoji, locked);
            });
            const nav = [btn('tv_home', tx('buttons.back'), ButtonStyle.Secondary, '↩')];
            if (st.solved) nav.push(btn('tv_today_menu', tx('buttons.todayWord'), ButtonStyle.Secondary, '📖'));
            return { content: lines.join('\n'), components: [row(...buttons.slice(0, 3)), row(...buttons.slice(3)), row(...nav)] };
        }

        // word = today's word (all languages); shown in the player's language (W.viewOf)
        function gameScreen(word, play) {
            const d = W.DIFF[diff];
            const v = W.viewOf(word, lang);
            const left = d.limit - play.wrong;
            const hints = play.hintsUsed.map(i => W.hintText(v.hints[i])).filter(Boolean);
            const lines = [TITLE, tx('game.header', { emoji: d.emoji, name: diffName(diff), left: tc('count.wrongLeft', left), hints: play.hintsLeft, max: W.HINTS_PER_GUESS }), '',
                W.renderBoxes(v.word, play.revealed, false, v.lang), ''];
            if (hints.length) lines.push(hints.map(h => '💡 ' + h).join('\n'));
            if (feedback) lines.push(feedback);
            return {
                content: lines.join('\n'),
                components: [row(
                    btn('tv_guess', tx('buttons.guess'), ButtonStyle.Primary, '✏️'),
                    btn('tv_hint', tx('buttons.hint'), ButtonStyle.Secondary, '💡', play.hintsLeft <= 0),
                    btn('tv_giveup', tx('buttons.giveUp'), ButtonStyle.Danger, '🏳️'),
                    btn('tv_back', tx('buttons.back'), ButtonStyle.Secondary, '↩'))]
            };
        }

        // Opens the chosen difficulty (or tells why it can't be played)
        async function openDiff() {
            const day = W.dayOf();
            const words = await T.wordsOf(day);
            if (!words) return warming();
            const r = await T.startPlay(userId, day, diff, guildId, lang, words[diff]);
            if (!r.ok) return menu();
            return gameScreen(words[diff], r.play);
        }

        // "About" block: only on the result screen after a solve (it would spoil the answer before)
        const aboutBlock = word => {
            const v = W.viewOf(word, lang);
            const lore = String((v && v.lore) || '').replace(/[_~`|]/g, '\\$&').replace(/@/g, '@\u200b');
            return lore ? ['', tx('about.title', { word: v.word.replace(/[*_~`|\\]/g, '\\$&') }), lore] : ['', tx('about.answer', { word: v.word })];
        };

        async function solvedScreen(play, award, word, allRevealed) {
            const d = W.DIFF[play.difficulty];
            const lines = [TITLE];
            if (allRevealed) lines.push(tx('solved.allRevealed'));
            lines.push(tx('solved.line', { emoji: d.emoji, name: diffName(play.difficulty), bits: award.bits, base: award.base, bonus: award.bonus }));
            lines.push(tx('solved.streak', { days: tc('count.streakDays', award.streak) }) + (award.milestone ? tx('solved.milestone', { bits: award.milestone }) : ''));
            lines.push(tx('solved.bits', { season: n(award.seasonBits), total: n(award.total) }));
            if (word) lines.push(...aboutBlock(word));
            lines.push('', tx('solved.done', { time: untilReset() }));
            const buttons = [btn('tv_back', tx('buttons.back'), ButtonStyle.Secondary, '↩')];
            if (guildId && !play.shared && await T.shareChannel(guildId)) buttons.unshift(btn('tv_share', tx('buttons.share'), ButtonStyle.Success, '📣'));
            return { content: lines.join('\n'), components: [row(...buttons)] };
        }

        function lockedScreen(play) {
            const name = diffName(play.difficulty);
            const why = play.status === 'gaveup' ? tx('locked.gaveup', { name }) : tx('locked.failed', { name });
            return {
                content: [TITLE, tx('locked.today', { why }), tx('locked.other')].join('\n'),
                components: [row(btn('tv_back', tx('buttons.back'), ButtonStyle.Secondary, '↩'))]
            };
        }

        // "Today's word": only the word of the difficulty they SOLVED today (the others are still playable, no spoilers).
        // back = 'tv_home' (from the start screen) or 'tv_back' (from the difficulty menu).
        async function todayScreen(back) {
            const day = W.dayOf();
            const [st, words] = await Promise.all([T.dayStatus(userId, day), T.wordsOf(day)]);
            if (!words) return warming();
            if (!st.solved) return back === 'tv_back' ? menu() : home();
            return {
                content: [TITLE, tx('today.solved', { name: diffName(st.solved.difficulty) }), ...aboutBlock(words[st.solved.difficulty])].join('\n'),
                components: [row(btn(back, tx('buttons.back'), ButtonStyle.Secondary, '↩'))],
                allowedMentions: { parse: [] }
            };
        }

        // ---------- actions ----------
        // The host can be slow and Discord wants an answer within 3 s: acknowledge first (deferUpdate), then show the
        // screen with editReply. False when it is already too late (interaction expired): logged once, nothing more sent.
        async function ack(x) {
            try {
                await x.deferUpdate();
                return true;
            } catch (err) {
                console.error('❌ [TRIVIA] too late to answer:', err.message);
                return false;
            }
        }

        // Called after ack(i): the screen is changed with editReply, notices go out as private follow-ups
        async function doShare(i) {
            const day = W.dayOf();
            const st = await T.dayStatus(userId, day);
            const chId = await shareInfo(st);
            if (!chId) return await i.followUp({ content: tx('share.nothing'), flags: [MessageFlags.Ephemeral] });
            const channel = await interaction.guild.channels.fetch(chId).catch(() => null);
            if (!channel || typeof channel.send !== 'function') return await i.followUp({ content: tx('share.gone'), flags: [MessageFlags.Ephemeral] });
            if (!(await T.markShared(userId, day, st.solved.difficulty))) return await i.followUp({ content: tx('share.already'), flags: [MessageFlags.Ephemeral] });
            const u = await T.getUser(userId);
            try {
                // A public post: the server's language
                await channel.send({ content: T.shareLine(displayNameOf(interaction), st.solved.difficulty, st.solved, W.liveStreak(u, day), userLanguage.forGuild(interaction.guild)), allowedMentions: { parse: [] } });
            } catch (err) {
                await T.markShared(userId, day, st.solved.difficulty, true).catch(() => {});
                return await i.followUp({ content: tx('share.cantPost', { channel: chId }), flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } });
            }
            await T.recordShare(userId, day, guildId, chId).catch(() => {}); // the website's Share box shows this server as shared
            const p = await home();
            p.content += '\n\n' + tx('share.done', { channel: chId });
            return await i.editReply({ ...p, allowedMentions: { parse: [] } });
        }

        async function doGuess(i, prev) {
            const modalId = 'tv_modal_' + i.id;
            const modal = new ModalBuilder().setCustomId(modalId).setTitle(tx('modal.title', { name: diffName(diff) }).slice(0, 45))
                .addComponents(row(new TextInputBuilder().setCustomId('answer').setLabel(tx('modal.label').slice(0, 45))
                    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
            await i.showModal(modal);
            const sub = await i.awaitModalSubmit({ filter: m => m.customId === modalId && m.user.id === userId, time: 10 * 60 * 1000 }).catch(() => null);
            if (!sub) return;
            if (!(await ack(sub))) { last = prev; return; }
            last = sub;
            try {
                const day = W.dayOf();
                const words = await T.wordsOf(day);
                if (!words) return await sub.editReply(warming());
                const answer = String(sub.fields.getTextInputValue('answer') || '').slice(0, 100);
                const r = await T.guess(userId, day, diff, words[diff], answer, lang);
                if (r.result === 'solved') return await sub.editReply({ ...(await solvedScreen(r.play, r.award, words[diff], r.allRevealed)), allowedMentions: { parse: [] } });
                if (r.result === 'failed') return await sub.editReply(lockedScreen(r.play));
                if (r.result === 'wrong') {
                    const left = W.DIFF[diff].limit - r.play.wrong;
                    const leftText = tc('count.wrongLeft', left);
                    feedback = r.shown ? tc('feedback.wrongShown', r.shown, { left: leftText }) : tx('feedback.wrong', { left: leftText });
                    return await sub.editReply(gameScreen(words[diff], r.play));
                }
                feedback = '';
                return await sub.editReply(await menu());
            } catch (err) {
                console.error('❌ [TRIVIA] guess:', err.message);
                await sub.editReply({ content: tx('error'), components: [] }).catch(() => {});
            }
        }

        const p0 = await home().catch(err => { console.error('❌ [TRIVIA] home:', err.message); return { content: tx('notAvailable'), components: [] }; });
        await interaction.editReply(p0);
        if (!p0.components || !p0.components.length) return;
        const message = await interaction.fetchReply();

        const collector = message.createMessageComponentCollector({ filter: i => i.user.id === userId && String(i.customId).startsWith('tv_'), idle: IDLE_MS });
        collector.on('collect', async i => {
            const prev = last;
            try {
                last = i;
                const id = i.customId;
                if (id === 'tv_home') {
                    if (!(await ack(i))) { last = prev; return; }
                    feedback = '';
                    return await i.editReply(await home());
                }
                if (id === 'tv_howto') {
                    if (!(await ack(i))) { last = prev; return; }
                    return await i.editReply(howTo());
                }
                if (id === 'tv_play' || id === 'tv_back') {
                    if (!(await ack(i))) { last = prev; return; }
                    feedback = '';
                    return await i.editReply(await menu());
                }
                if (id === 'tv_share') {
                    if (!(await ack(i))) { last = prev; return; }
                    return await doShare(i);
                }
                if (id === 'tv_today' || id === 'tv_today_menu') {
                    if (!(await ack(i))) { last = prev; return; }
                    return await i.editReply(await todayScreen(id === 'tv_today' ? 'tv_home' : 'tv_back'));
                }
                if (id.startsWith('tv_d_')) {
                    const key = id.slice(5);
                    if (!(await ack(i))) { last = prev; return; }
                    if (!W.DIFF[key]) return await i.editReply(await menu());
                    diff = key; feedback = '';
                    return await i.editReply(await openDiff());
                }
                if (!diff) {
                    if (!(await ack(i))) { last = prev; return; }
                    return await i.editReply(await menu());
                }
                if (id === 'tv_guess') return doGuess(i, prev);
                if (id === 'tv_hint') {
                    if (!(await ack(i))) { last = prev; return; }
                    const day = W.dayOf();
                    const words = await T.wordsOf(day);
                    if (!words) return await i.editReply(warming());
                    const r = await T.useHint(userId, day, diff, words[diff], lang);
                    if (r.result === 'solved') { feedback = ''; return await i.editReply({ ...(await solvedScreen(r.play, r.award, words[diff], true)), allowedMentions: { parse: [] } }); }
                    if (!r.play || r.play.status !== 'playing' || r.result) return await i.editReply(await menu());
                    feedback = r.position ? tx('hint.letter', { n: r.position }) : r.ok ? '' : r.limit ? tx('hint.limit', { n: W.HINTS_PER_GUESS }) : tx('hint.none');
                    return await i.editReply(gameScreen(words[diff], r.play));
                }
                if (id === 'tv_giveup') {
                    if (!(await ack(i))) { last = prev; return; }
                    return await i.editReply({
                        content: TITLE + '\n' + tx('giveup.ask'),
                        components: [row(btn('tv_giveup_yes', tx('buttons.giveUpYes'), ButtonStyle.Danger), btn('tv_giveup_no', tx('buttons.giveUpNo'), ButtonStyle.Secondary))]
                    });
                }
                if (id === 'tv_giveup_yes') {
                    if (!(await ack(i))) { last = prev; return; }
                    const play = await T.giveUp(userId, W.dayOf(), diff);
                    feedback = '';
                    if (!play || play.status === 'playing') return await i.editReply(await menu());
                    return await i.editReply(play.status === 'solved' ? await menu() : lockedScreen(play));
                }
                if (id === 'tv_giveup_no') {
                    if (!(await ack(i))) { last = prev; return; }
                    return await i.editReply(await openDiff());
                }
            } catch (err) {
                console.error('❌ [TRIVIA] button:', err.message);
                if (!i.replied && !i.deferred) await i.reply({ content: tx('error'), flags: [MessageFlags.Ephemeral] }).catch(() => {});
                else if (i.deferred) await i.editReply({ content: tx('error'), components: [] }).catch(() => {});
            }
        });
        collector.on('end', (c, reason) => {
            if (reason !== 'idle') return;
            last.editReply({ content: TITLE + '\n' + tx('ended'), components: [] }).catch(() => {});
        });
    }
};
