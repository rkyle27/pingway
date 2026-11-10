// /collect - your FFXIV collections (FFXIV Collect, utils/ffxivCollect.js) for your verified Main character.
// One ephemeral panel: 🔎 Check item, 📋 Missing, 🏆 Leaderboard (📢 Show posts it in the channel), 🔄 Refresh.
// Component ids carry everything they need (no memory): collect_<action>_<ownerId>[_<arg>...], so the panel keeps
// working after a restart. Only the person who opened the panel can use it. Data by FFXIV Collect.
'use strict';

const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits
} = require('discord.js');
const { pool } = require('../utils/db');
const { t, discordLocalizations, localeOf } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');
const fc = require('../utils/ffxivCollect');

const PAGE_SIZE = 10;
const LB_SIZE = 10;
const SHOW_GAP_MS = 60 * 1000;
const MISSING_CATS = ['mounts', 'minions', 'achievements', 'orchestrions', 'emotes', 'hairstyles', 'bardings', 'cards'];
const LB_CATS = ['mounts', 'minions', 'achievements', 'orchestrions', 'cards', 'emotes', 'hairstyles', 'bardings'];
const SEARCH_CATS = MISSING_CATS;
const COLOR = { ok: 0x2ecc71, no: 0xe74c3c, info: 0x5865f2, warn: 0xf1c40f };
const lastShow = new Map(); // channelId -> time of the last 📢 Show

const num = (n, lang) => Number(n || 0).toLocaleString(localeOf(lang));
const pctText = (p, lang) => Number(p || 0).toLocaleString(localeOf(lang), { maximumFractionDigits: 1 });
const catName = (lang, c) => t(lang, 'collect.cat.' + c);
const lbCatName = (lang, c) => (c === 'achievements' ? t(lang, 'collect.achPoints') : catName(lang, c));
const cid = (action, owner, ...args) => ['collect', action, owner, ...args].join('_');
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

function parseId(customId) {
    const p = String(customId || '').split('_');
    if (p[0] !== 'collect' || p.length < 3) return null;
    return { action: p[1], owner: p[2], args: p.slice(3) };
}

// ---------- panel ----------
function stateLine(lang, r, main) {
    if (!r) return '';
    const name = main.character_name || main.lodestone_id;
    if (r.state === 'notfound') return t(lang, 'collect.state.notfound', { name });
    if (r.state === 'private') return t(lang, 'collect.state.private');
    if (r.state === 'down') return t(lang, 'collect.state.down');
    return r.stale ? t(lang, 'collect.state.stale') : '';
}

function panel(lang, owner, main, r, note) {
    const lines = [];
    if (note) lines.push(note);
    const st = stateLine(lang, r, main);
    if (st) lines.push(st);
    const data = r && r.data;
    if (data) {
        const sum = [];
        for (const c of fc.COLLECTION_KEYS) {
            const x = data.c[c];
            if (!x) continue;
            const emoji = fc.COLLECTIONS[c].emoji;
            if (!x.public) sum.push(t(lang, 'collect.hiddenLine', { emoji, cat: catName(lang, c) }));
            else if (c === 'achievements') sum.push(t(lang, 'collect.achLine', { emoji, cat: catName(lang, c), count: num(x.count, lang), total: num(x.total, lang), points: num(x.points, lang) }));
            else sum.push(t(lang, 'collect.line', { emoji, cat: catName(lang, c), count: num(x.count, lang), total: num(x.total, lang) }));
        }
        lines.push(sum.join('\n'));
        const a = data.c.achievements;
        if (a && (!a.public || (!a.count && !a.points))) lines.push(t(lang, 'collect.state.achHidden'));
        if (r.fetchedAt) lines.push(t(lang, 'collect.synced', { when: '<t:' + Math.floor(r.fetchedAt / 1000) + ':R>' }));
    }
    const embed = new EmbedBuilder()
        .setTitle(t(lang, 'collect.title', { name: main.character_name || main.lodestone_id, world: main.world || '?' }))
        .setURL(fc.ffxivCollectUrl(main.lodestone_id))
        .setDescription(lines.filter(Boolean).join('\n\n') || '​')
        .setColor(r && r.state !== 'ok' && r.state !== 'limited' ? COLOR.warn : COLOR.info)
        .setFooter({ text: t(lang, 'collect.credit') });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(cid('check', owner)).setLabel('🔎 ' + t(lang, 'collect.btn.check')).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(cid('missing', owner)).setLabel('📋 ' + t(lang, 'collect.btn.missing')).setStyle(ButtonStyle.Secondary).setDisabled(!data),
        new ButtonBuilder().setCustomId(cid('lb', owner)).setLabel('🏆 ' + t(lang, 'collect.btn.leaderboard')).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(cid('refresh', owner)).setLabel('🔄 ' + t(lang, 'collect.btn.refresh')).setStyle(ButtonStyle.Secondary)
    );
    return { content: '', embeds: [embed], components: [row] };
}

const backRow = (lang, owner, extra) => new ActionRowBuilder().addComponents(
    ...(extra || []),
    new ButtonBuilder().setCustomId(cid('home', owner)).setLabel('◀ ' + t(lang, 'collect.btn.back')).setStyle(ButtonStyle.Secondary)
);

// ---------- 🔎 Check item ----------
async function searchSources(lang) {
    const out = [];
    for (const c of SEARCH_CATS) {
        const items = await fc.getList(pool, c, lang);
        const en = lang === 'en' ? items : await fc.getList(pool, c, 'en');
        out.push({ collection: c, items, en });
    }
    return out;
}

function itemAnswer(lang, owner, collection, item, data) {
    const has = data ? fc.owns(data, collection, item.id) : null;
    const lines = [has === true ? t(lang, 'collect.have') : has === false ? t(lang, 'collect.haveNot') : t(lang, 'collect.unknown')];
    const embed = new EmbedBuilder()
        .setTitle(clip(fc.COLLECTIONS[collection].emoji + ' ' + item.name, 256))
        .setDescription(lines.join('\n'))
        .setColor(has === true ? COLOR.ok : has === false ? COLOR.no : COLOR.warn)
        .setFooter({ text: t(lang, 'collect.credit') });
    if (item.icon) embed.setThumbnail(item.icon);
    let how = '';
    if (collection === 'achievements') how = item.desc || '';
    else how = (item.sources || []).map(s => '• ' + (s.type && s.text && s.type !== s.text ? s.type + ': ' + s.text : s.text || s.type)).join('\n');
    const fields = [
        { name: t(lang, 'collect.category'), value: catName(lang, collection), inline: true },
        { name: t(lang, 'collect.rarity'), value: t(lang, 'collect.rarityValue', { pct: pctText(item.owned, lang) }), inline: true }
    ];
    if (collection === 'achievements' && item.points) fields.push({ name: t(lang, 'collect.points'), value: String(item.points), inline: true });
    fields.push({ name: t(lang, 'collect.howTo'), value: clip(how || t(lang, 'collect.noSource'), 1024), inline: false });
    embed.addFields(fields);
    const row = backRow(lang, owner, [new ButtonBuilder().setCustomId(cid('check', owner)).setLabel('🔎 ' + t(lang, 'collect.btn.checkAgain')).setStyle(ButtonStyle.Primary)]);
    return { content: '', embeds: [embed], components: [row] };
}

function didYouMean(lang, owner, query, results) {
    const embed = new EmbedBuilder()
        .setTitle(t(lang, 'collect.suggestions'))
        .setDescription(t(lang, 'collect.didYouMean', { query: clip(query, 100) }) + '\n\n' +
            results.map((r, i) => '**' + (i + 1) + '.** ' + fc.COLLECTIONS[r.collection].emoji + ' ' + r.item.name + ' · *' + catName(lang, r.collection) + '*').join('\n'))
        .setColor(0xff9900)
        .setFooter({ text: t(lang, 'collect.credit') });
    const menu = new StringSelectMenuBuilder()
        .setCustomId(cid('pick', owner))
        .setPlaceholder(t(lang, 'collect.pickPlaceholder'))
        .addOptions(results.map((r, i) => ({ label: clip((i + 1) + '. ' + r.item.name, 100), description: clip(catName(lang, r.collection), 100), value: r.collection + ':' + r.item.id, emoji: fc.COLLECTIONS[r.collection].emoji })));
    return { content: '', embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), backRow(lang, owner)] };
}

// The item lists file (data/ffxivcollect-lists.json) isn't there yet -> friendly note in the panel
function listsMissingView(lang, owner) {
    const embed = new EmbedBuilder().setDescription(t(lang, 'collect.listsMissing')).setColor(COLOR.warn).setFooter({ text: t(lang, 'collect.credit') });
    return { content: '', embeds: [embed], components: [backRow(lang, owner)] };
}

/** Answer for a typed item name -> message payload */
async function checkAnswer(lang, owner, query, data) {
    const sources = await searchSources(lang);
    if (sources.some(src => src.items.notLoaded)) return listsMissingView(lang, owner);
    const results = fc.search(query, sources, 10);
    if (!results.length) {
        const embed = new EmbedBuilder().setDescription(t(lang, 'collect.noResult', { query: clip(query, 100) })).setColor(COLOR.warn).setFooter({ text: t(lang, 'collect.credit') });
        return { content: '', embeds: [embed], components: [backRow(lang, owner, [new ButtonBuilder().setCustomId(cid('check', owner)).setLabel('🔎 ' + t(lang, 'collect.btn.checkAgain')).setStyle(ButtonStyle.Primary)])] };
    }
    if (fc.isConfident(results)) return itemAnswer(lang, owner, results[0].collection, results[0].item, data);
    return didYouMean(lang, owner, query, results);
}

// ---------- 📋 Missing ----------
function categoryMenu(lang, owner, action, cats, current) {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(cid(action, owner))
        .setPlaceholder(t(lang, 'collect.categoryPlaceholder'))
        .addOptions(cats.map(c => ({ label: action === 'lbcat' ? lbCatName(lang, c) : catName(lang, c), value: c, emoji: fc.COLLECTIONS[c].emoji, default: c === current }))));
}

async function missingPage(lang, owner, data, collection, page) {
    const items = await fc.getList(pool, collection, lang);
    if (items.notLoaded) return listsMissingView(lang, owner);
    const list = fc.missing(data, collection, items);
    const embed = new EmbedBuilder().setColor(COLOR.info);
    const comps = [categoryMenu(lang, owner, 'misscat', MISSING_CATS, collection)];
    if (!list) {
        embed.setTitle(t(lang, 'collect.missingTitle', { cat: catName(lang, collection), n: '?' })).setDescription(t(lang, 'collect.missingHidden'));
    } else if (!list.length) {
        embed.setTitle(t(lang, 'collect.missingTitle', { cat: catName(lang, collection), n: 0 })).setDescription(t(lang, 'collect.missingNone'));
    } else {
        const pages = Math.ceil(list.length / PAGE_SIZE);
        const p = Math.min(Math.max(0, page | 0), pages - 1);
        const shown = list.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
        embed.setTitle(t(lang, 'collect.missingTitle', { cat: catName(lang, collection), n: num(list.length, lang) }))
            .setDescription(shown.map((it, i) => {
                const src = collection === 'achievements' ? it.desc : (it.sources || []).map(s => s.text || s.type).filter(Boolean).slice(0, 2).join(' · ');
                return t(lang, 'collect.missingLine', { n: p * PAGE_SIZE + i + 1, name: it.name, pct: pctText(it.owned, lang) }) + (src ? '\n↳ ' + clip(src, 120) : '');
            }).join('\n'))
            .setFooter({ text: t(lang, 'collect.page', { page: p + 1, pages }) + ' · ' + t(lang, 'collect.credit') });
        comps.push(backRow(lang, owner, [
            new ButtonBuilder().setCustomId(cid('mpage', owner, collection, p - 1)).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
            new ButtonBuilder().setCustomId(cid('mpage', owner, collection, p + 1)).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages - 1)
        ]));
        return { content: '', embeds: [embed], components: comps };
    }
    embed.setFooter({ text: t(lang, 'collect.credit') });
    comps.push(backRow(lang, owner));
    return { content: '', embeds: [embed], components: comps };
}

// ---------- 🏆 Leaderboard ----------
/** Verified Main characters of this server's members, ranked from saved data -> { rows, syncing } */
async function leaderboard(db, guild, collection, opts) {
    const o = opts || {};
    await fc.ensureTables(db);
    const [mains] = await db.execute('SELECT user_id, lodestone_id, character_name, world FROM ign_characters WHERE is_main = 1 AND claim_key IS NOT NULL');
    const byUser = new Map(mains.map(m => [String(m.user_id), m]));
    const ids = [...byUser.keys()];
    const members = new Set();
    for (let i = 0; i < ids.length; i += 100) {
        const part = ids.slice(i, i + 100);
        const got = await guild.members.fetch({ user: part }).catch(() => null);
        if (got && typeof got.keys === 'function') for (const k of got.keys()) members.add(String(k));
        else for (const id of part) if (guild.members.cache && guild.members.cache.has(id)) members.add(id);
    }
    const here = ids.filter(id => members.has(id)).map(id => byUser.get(id));
    const cache = await fc.cachedMany(db, here.map(m => m.lodestone_id));
    const now = o.now || Date.now();
    const rows = [], stale = [];
    let never = 0;
    for (const m of here) {
        const c = cache.get(String(m.lodestone_id));
        if (!c) { never++; stale.push(m.lodestone_id); continue; } // never synced: fetched in the background
        if (!c.data) continue; // not on FFXIV Collect / private
        if (now - (c.fetchedAt || 0) > fc.CHAR_TTL_MS) stale.push(m.lodestone_id);
        const v = fc.statValue(c.data, collection);
        if (!v) continue;
        rows.push({ userId: String(m.user_id), name: m.character_name || c.data.name || '', world: m.world || c.data.server || '', value: v.value, total: v.total });
    }
    rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    if (o.refresh !== false) fc.refreshLater(db, stale, 10);
    return { rows: rows.slice(0, LB_SIZE), syncing: never, stale: stale.length, members: here.length };
}

function leaderboardEmbed(lang, collection, lb, sharedBy) {
    const medal = i => ['🥇', '🥈', '🥉'][i] || '**' + (i + 1) + '.**';
    const lines = lb.rows.map((r, i) => medal(i) + ' <@' + r.userId + '> — ' + (r.name || '?') + (r.world ? ' (' + r.world + ')' : '') + ': **' +
        num(r.value, lang) + (collection === 'achievements' ? '' : ' / ' + num(r.total, lang)) + '**');
    let desc = lines.length ? lines.join('\n') : t(lang, 'collect.lbEmpty');
    if (lb.syncing) desc += '\n\n' + t(lang, 'collect.lbSyncing', { n: lb.syncing });
    if (sharedBy) desc += '\n\n' + t(lang, 'collect.showBy', { user: sharedBy });
    return new EmbedBuilder()
        .setTitle(t(lang, 'collect.lbTitle', { cat: fc.COLLECTIONS[collection].emoji + ' ' + lbCatName(lang, collection) }))
        .setDescription(desc)
        .setColor(0xf1c40f)
        .setFooter({ text: t(lang, 'collect.lbFooter') + ' · ' + t(lang, 'collect.credit') });
}

async function leaderboardView(lang, owner, guild, collection) {
    const lb = await leaderboard(pool, guild, collection);
    return {
        content: '', embeds: [leaderboardEmbed(lang, collection, lb)],
        components: [categoryMenu(lang, owner, 'lbcat', LB_CATS, collection), backRow(lang, owner, [
            new ButtonBuilder().setCustomId(cid('lbshow', owner, collection)).setLabel('📢 ' + t(lang, 'collect.btn.show')).setStyle(ButtonStyle.Success)
        ])]
    };
}

/** 📢 Show: can Pingway post here, and was it posted here in the last minute? -> null (ok) | { key, sec } */
function showCheck(channel, guild, now) {
    const me = guild && guild.members && guild.members.me;
    const perms = channel && me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
    if (!perms || !need.every(p => perms.has(p))) return { key: 'collect.showNoPerm' };
    const last = lastShow.get(String(channel.id));
    if (last && now - last < SHOW_GAP_MS) return { key: 'collect.showWait', sec: Math.ceil((SHOW_GAP_MS - (now - last)) / 1000) };
    return null;
}

// ---------- command ----------
async function openPanel(interaction, lang, main) {
    const r = await fc.getCharacter(pool, main.lodestone_id);
    return panel(lang, interaction.user.id, main, r);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('collect')
        .setDescription(t('en', 'collect.cmd.description')).setDescriptionLocalizations(discordLocalizations('collect.cmd.description')),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        const main = await fc.verifiedMain(pool, interaction.user.id);
        if (!main) return interaction.reply({ content: t(lang, 'ign.needVerified'), flags: [MessageFlags.Ephemeral] });
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            return await interaction.editReply(await openPanel(interaction, lang, main));
        } catch (e) {
            console.error('❌ [COLLECT] panel:', e.message);
            return interaction.editReply({ content: t(lang, 'collect.error'), embeds: [], components: [] });
        }
    },

    async handleInteraction(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        const id = parseId(interaction.customId);
        if (!id) return;
        if (id.owner !== String(interaction.user.id)) return interaction.reply({ content: t(lang, 'collect.onlyOwner'), flags: [MessageFlags.Ephemeral] });

        // the modal is shown right away (no database first: Discord wants it within 3 seconds)
        if (id.action === 'check') {
            const modal = new ModalBuilder().setCustomId(cid('checkm', id.owner)).setTitle(t(lang, 'collect.modal.title')).addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item').setLabel(t(lang, 'collect.modal.label'))
                    .setPlaceholder(t(lang, 'collect.modal.placeholder')).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100))
            );
            return interaction.showModal(modal);
        }

        const main = await fc.verifiedMain(pool, interaction.user.id);
        if (!main) return interaction.reply({ content: t(lang, 'ign.needVerified'), flags: [MessageFlags.Ephemeral] });

        if (id.action === 'lbshow') {
            const collection = LB_CATS.includes(id.args[0]) ? id.args[0] : 'mounts';
            if (!interaction.guild) return interaction.reply({ content: t(lang, 'collect.lbGuildOnly'), flags: [MessageFlags.Ephemeral] });
            const now = Date.now();
            const bad = showCheck(interaction.channel, interaction.guild, now);
            if (bad) return interaction.reply({ content: t(lang, bad.key, { sec: bad.sec }), flags: [MessageFlags.Ephemeral] });
            lastShow.set(String(interaction.channel.id), now);
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const glang = userLanguage.forGuild(interaction.guild); // public post: the server's language
            const lb = await leaderboard(pool, interaction.guild, collection, { refresh: false });
            try {
                await interaction.channel.send({ embeds: [leaderboardEmbed(glang, collection, lb, '<@' + interaction.user.id + '>')], allowedMentions: { parse: [] } });
            } catch (e) {
                lastShow.delete(String(interaction.channel.id));
                return interaction.editReply({ content: t(lang, 'collect.showNoPerm') });
            }
            return interaction.editReply({ content: t(lang, 'collect.showDone') });
        }

        // everything else updates the panel
        await interaction.deferUpdate();
        try {
            if (id.action === 'home') return await interaction.editReply(await openPanel(interaction, lang, main));
            if (id.action === 'refresh') {
                const r = await fc.getCharacter(pool, main.lodestone_id, { force: true });
                if (r.state === 'limited') {
                    const shown = r.saved || await fc.getCharacter(pool, main.lodestone_id, { cacheOnly: true });
                    return await interaction.editReply(panel(lang, id.owner, main, shown && shown.state ? shown : null, t(lang, 'collect.refreshWait', { min: r.waitMin })));
                }
                return await interaction.editReply(panel(lang, id.owner, main, r, r.state === 'ok' && !r.stale ? t(lang, 'collect.refreshed') : ''));
            }
            if (id.action === 'checkm') {
                const query = String(interaction.fields.getTextInputValue('item') || '').trim();
                const r = await fc.getCharacter(pool, main.lodestone_id);
                return await interaction.editReply(await checkAnswer(lang, id.owner, query, r.data));
            }
            if (id.action === 'pick') {
                const [collection, itemId] = String((interaction.values || [])[0] || '').split(':');
                if (!fc.COLLECTIONS[collection]) return;
                const items = await fc.getList(pool, collection, lang);
                if (items.notLoaded) return await interaction.editReply(listsMissingView(lang, id.owner));
                const item = items.find(x => String(x.id) === itemId);
                const r = await fc.getCharacter(pool, main.lodestone_id);
                if (!item) return await interaction.editReply(await openPanel(interaction, lang, main));
                return await interaction.editReply(itemAnswer(lang, id.owner, collection, item, r.data));
            }
            if (id.action === 'missing') {
                const embed = new EmbedBuilder().setDescription(t(lang, 'collect.missingPick')).setColor(COLOR.info).setFooter({ text: t(lang, 'collect.credit') });
                return await interaction.editReply({ content: '', embeds: [embed], components: [categoryMenu(lang, id.owner, 'misscat', MISSING_CATS), backRow(lang, id.owner)] });
            }
            if (id.action === 'misscat' || id.action === 'mpage') {
                const collection = id.action === 'misscat' ? (interaction.values || [])[0] : id.args[0];
                if (!MISSING_CATS.includes(collection)) return;
                const r = await fc.getCharacter(pool, main.lodestone_id);
                if (!r.data) return await interaction.editReply(panel(lang, id.owner, main, r));
                return await interaction.editReply(await missingPage(lang, id.owner, r.data, collection, id.action === 'mpage' ? parseInt(id.args[1], 10) || 0 : 0));
            }
            if (id.action === 'lb' || id.action === 'lbcat') {
                if (!interaction.guild) {
                    const embed = new EmbedBuilder().setDescription(t(lang, 'collect.lbGuildOnly')).setColor(COLOR.warn);
                    return await interaction.editReply({ content: '', embeds: [embed], components: [backRow(lang, id.owner)] });
                }
                const collection = id.action === 'lbcat' && LB_CATS.includes((interaction.values || [])[0]) ? interaction.values[0] : 'mounts';
                return await interaction.editReply(await leaderboardView(lang, id.owner, interaction.guild, collection));
            }
        } catch (e) {
            console.error('❌ [COLLECT] ' + id.action + ':', e.message);
            return interaction.editReply({ content: t(lang, 'collect.error'), embeds: [], components: [backRow(lang, id.owner)] }).catch(() => {});
        }
    },

    // for the tests
    _: { parseId, panel, listsMissingView, itemAnswer, didYouMean, checkAnswer, missingPage, leaderboard, leaderboardEmbed, showCheck, lastShow, PAGE_SIZE, SHOW_GAP_MS, MISSING_CATS, LB_CATS }
};
