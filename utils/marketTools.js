// Bot copy of the website's lib/market.js (Supporter Perks market tools), used by /bestsellers and /buysell.
// Keep the two in step. The popularity scan (scanPopular) only runs on the website; the bot reads mkt_popular.
// Tools: best sellers, buy & sell, price history,
// best time to sell, crafting profit. Data comes from Universalis (prices, sales) and XIVAPI (items, recipes).
//
// "Popular items": an every-10-minutes cron job (api/cron.js -> scanPopular) walks through all marketable items,
// 100 at a time, and saves each region's sales per day in mkt_popular. The tools then only look at the most
// popular items of a region, so each request needs just a few Universalis calls.

const axios = require('axios');

// Same lists as the website (lib/config.js)
const REGIONS = {"North America (NA)":{"Aether":["Adamantoise","Cactuar","Faerie","Gilgamesh","Jenova","Midgardsormr","Sargatanas","Siren"],"Primal":["Behemoth","Excalibur","Exodus","Famfrit","Hyperion","Lamia","Leviathan","Ultros"],"Crystal":["Balmung","Brynhildr","Coeurl","Diabolos","Goblin","Malboro","Mateus","Zalera"],"Dynamis":["Cuchulainn","Golem","Halicarnassus","Kraken","Maduin","Marilith","Rafflesia","Seraph"]},"Europe (EU)":{"Chaos":["Cerberus","Louisoix","Moogle","Omega","Phantom","Ragnarok","Sagittarius","Spriggan"],"Light":["Alpha","Lich","Odin","Phoenix","Raiden","Shiva","Twintania","Zodiark"]},"Oceania (OCE)":{"Materia":["Bismarck","Ravana","Sephirot","Sophia","Zurvan"]},"Japan (JP)":{"Elemental":["Aegis","Atomos","Carbuncle","Garuda","Gungnir","Kujata","Tonberry","Typhon"],"Gaia":["Alexander","Bahamut","Durandal","Fenrir","Ifrit","Ridill","Tiamat","Ultima"],"Mana":["Anima","Asura","Chocobo","Hades","Ixion","Masamune","Pandaemonium","Titan"],"Meteor":["Belias","Mandragora","Ramuh","Shinryu","Unicorn","Valefor","Yojimbo","Zeromus"]}};
const DATA_CENTERS = {};
for (const dcs of Object.values(REGIONS)) Object.assign(DATA_CENTERS, dcs);

const UNI = 'https://universalis.app/api/v2';
const XIV = 'https://v2.xivapi.com/api';
const UNI_REGION = { 'North America (NA)': 'North-America', 'Europe (EU)': 'Europe', 'Oceania (OCE)': 'Oceania', 'Japan (JP)': 'Japan' };
const CANDIDATES = 300;          // popular items looked at per request
const SCAN_ROUNDS_PER_RUN = 6;    // 600 items per region per cron run
const CRYSTAL_IDS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]); // shards, crystals, clusters

let tablesReady = false;
async function ensureTables(pool) {
    if (tablesReady) return;
    await pool.execute(`CREATE TABLE IF NOT EXISTS mkt_popular (
        region VARCHAR(20) NOT NULL,
        item_id INT NOT NULL,
        velocity DOUBLE NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (region, item_id),
        KEY idx_region_vel (region, velocity)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS mkt_scan (
        region VARCHAR(20) PRIMARY KEY,
        next_index INT NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS market_prefs (
        user_id VARCHAR(32) PRIMARY KEY,
        world VARCHAR(40) DEFAULT NULL,
        best_scope VARCHAR(8) NOT NULL DEFAULT 'world',
        deal_mode VARCHAR(8) NOT NULL DEFAULT 'dc',
        materia TINYINT(1) NOT NULL DEFAULT 0,
        min_diff INT NOT NULL DEFAULT 0,
        min_sales DOUBLE NOT NULL DEFAULT 0,
        sorts VARCHAR(40) NOT NULL DEFAULT 'profit',
        updated_at BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    tablesReady = true;
}

// Market tool settings (the website saves them; /bestsellers and /buysell use them)
const SORT_KEYS = ['profit', 'percent', 'fast', 'cheap'];
function cleanPrefs(p) {
    p = p && typeof p === 'object' ? p : {};
    const sorts = String(p.sorts || 'profit').split(',').filter(s => SORT_KEYS.includes(s)).slice(0, 4);
    return {
        world: regionOfWorld(String(p.world || '')) ? String(p.world) : null,
        bestScope: p.bestScope === 'dc' ? 'dc' : 'world',
        dealMode: p.dealMode === 'region' ? 'region' : 'dc',
        materia: p.materia === true || p.materia === '1' || p.materia === 1,
        minDiff: Math.max(0, Math.min(1e9, Math.floor(Number(p.minDiff) || 0))),
        minSales: Math.max(0, Math.min(1000, Number(p.minSales) || 0)),
        sorts: (sorts.length ? sorts : ['profit']).join(',')
    };
}
async function loadPrefs(pool, userId) {
    await ensureTables(pool);
    const [[r]] = await pool.execute('SELECT * FROM market_prefs WHERE user_id = ?', [String(userId)]);
    if (!r) return null;
    return cleanPrefs({ world: r.world, bestScope: r.best_scope, dealMode: r.deal_mode, materia: Number(r.materia) === 1, minDiff: r.min_diff, minSales: r.min_sales, sorts: r.sorts });
}
async function savePrefs(pool, userId, input) {
    await ensureTables(pool);
    const p = cleanPrefs(input);
    await pool.execute(
        'INSERT INTO market_prefs (user_id, world, best_scope, deal_mode, materia, min_diff, min_sales, sorts, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE world = VALUES(world), best_scope = VALUES(best_scope), deal_mode = VALUES(deal_mode), materia = VALUES(materia), ' +
        'min_diff = VALUES(min_diff), min_sales = VALUES(min_sales), sorts = VALUES(sorts), updated_at = VALUES(updated_at)',
        [String(userId), p.world, p.bestScope, p.dealMode, p.materia ? 1 : 0, p.minDiff, p.minSales, p.sorts, Date.now()]
    );
    return p;
}

// ---------- small helpers ----------
async function getJson(url, ms) {
    const r = await axios.get(url, { timeout: ms || 8000, headers: { 'User-Agent': 'Pingway (FFXIV Discord bot; pingway.app)' } });
    return r.data;
}

function regionOfWorld(world) {
    for (const [region, dcs] of Object.entries(REGIONS)) {
        for (const [dc, worlds] of Object.entries(dcs)) if (worlds.includes(world)) return { region, dc, uniRegion: UNI_REGION[region] };
    }
    return null;
}

let worldNames = null; // Universalis world ID -> name
async function worldName(id) {
    if (!worldNames) {
        const list = await getJson(UNI + '/worlds', 6000);
        worldNames = new Map(list.map(w => [Number(w.id), w.name]));
    }
    return worldNames.get(Number(id)) || null;
}

const itemCache = new Map(); // id (English) or 'lang:id' -> { id, name, icon }
// lang: en (default), fr, de or ja - XIVAPI has the item names in all four; cached per language
async function itemNames(ids, lang = 'en') {
    const key = id => (lang === 'en' ? id : lang + ':' + id);
    const need = [...new Set(ids)].filter(id => !itemCache.has(key(id)));
    for (let i = 0; i < need.length; i += 100) {
        const part = need.slice(i, i + 100);
        const data = await getJson(XIV + '/sheet/Item?rows=' + part.join(',') + '&fields=Name' + (lang === 'en' ? '' : '&language=' + lang), 8000);
        for (const row of data.rows || []) itemCache.set(key(row.row_id), { id: row.row_id, name: row.fields && row.fields.Name || ('Item ' + row.row_id) });
    }
    return new Map(ids.map(id => [id, itemCache.get(key(id)) || { id, name: 'Item ' + id }]));
}

// Item search with suggestions (marketable items only: ItemSearchCategory > 0)
async function searchItems(text) {
    const q = String(text || '').replace(/["\\]/g, '').trim().slice(0, 60);
    if (q.length < 2) return [];
    const query = '+Name~"' + q + '" +ItemSearchCategory>0';
    const data = await getJson(XIV + '/search?sheets=Item&fields=Name&limit=12&query=' + encodeURIComponent(query), 6000);
    const out = (data.results || []).map(r => ({ id: r.row_id, name: r.fields && r.fields.Name })).filter(x => x.name);
    // exact and "starts with" matches first
    const low = q.toLowerCase();
    out.sort((a, b) => (b.name.toLowerCase() === low) - (a.name.toLowerCase() === low) || (b.name.toLowerCase().startsWith(low)) - (a.name.toLowerCase().startsWith(low)) || a.name.length - b.name.length);
    return out.slice(0, 8);
}

// Universalis "aggregated" data, up to 100 items per call, NQ and HQ merged (the better of the two)
async function aggregated(scope, ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 100) {
        const part = ids.slice(i, i + 100);
        const data = await getJson(UNI + '/aggregated/' + encodeURIComponent(scope) + '/' + part.join(','), 10000);
        for (const r of data.results || []) out.set(r.itemId, r);
    }
    return out;
}

const pick = (r, kind, level) => {
    const nq = r && r.nq && r.nq[kind] && r.nq[kind][level];
    const hq = r && r.hq && r.hq[kind] && r.hq[kind][level];
    return { nq, hq };
};
const velocity = (r, level) => {
    const { nq, hq } = pick(r, 'dailySaleVelocity', level);
    return (nq && nq.quantity || 0) + (hq && hq.quantity || 0);
};
const avgPrice = (r, level) => {
    const { nq, hq } = pick(r, 'averageSalePrice', level);
    return Math.round((nq && nq.price) || (hq && hq.price) || 0);
};
// Cheapest listing (NQ or HQ) at a level: { price, worldId }
const minListing = (r, level) => {
    const { nq, hq } = pick(r, 'minListing', level);
    const all = [nq, hq].filter(x => x && x.price > 0);
    if (!all.length) return null;
    return all.reduce((a, b) => (b.price < a.price ? b : a));
};

// ---------- popular items (cron) ----------
let marketable = null;
async function marketableIds() {
    if (!marketable) marketable = (await getJson(UNI + '/marketable', 8000)).filter(id => !CRYSTAL_IDS.has(id)).sort((a, b) => a - b);
    return marketable;
}

// One cron step: up to 6 rounds; each round takes the next 100 items of every region at once (4 calls in parallel).
// A full pass over ~16,800 items takes about 28 runs (under 5 hours at one run every 10 minutes).
async function scanPopular(pool, deadline) {
    await ensureTables(pool);
    const ids = await marketableIds();
    const regions = Object.values(UNI_REGION);
    const pos = {};
    for (const region of regions) {
        const [[row]] = await pool.execute('SELECT next_index FROM mkt_scan WHERE region = ?', [region]);
        pos[region] = row && Number(row.next_index) < ids.length ? Number(row.next_index) : 0;
    }
    const report = Object.fromEntries(regions.map(r => [r, 0]));
    const wrapped = new Set(); // a region that reached the end stops for this run
    for (let round = 0; round < SCAN_ROUNDS_PER_RUN && Date.now() < deadline - 2500; round++) {
        await Promise.all(regions.filter(r => !wrapped.has(r)).map(async region => {
            const part = ids.slice(pos[region], pos[region] + 100);
            if (!part.length) { pos[region] = 0; wrapped.add(region); return; }
            const data = await aggregated(region, part);
            const now = Date.now();
            const values = [];
            for (const id of part) values.push(region, id, velocity(data.get(id), 'region'), now);
            await pool.execute('INSERT INTO mkt_popular (region, item_id, velocity, updated_at) VALUES ' + part.map(() => '(?, ?, ?, ?)').join(', ') +
                ' ON DUPLICATE KEY UPDATE velocity = VALUES(velocity), updated_at = VALUES(updated_at)', values);
            if (pos[region] + part.length >= ids.length) { pos[region] = 0; wrapped.add(region); } else pos[region] += part.length;
            report[region] += part.length;
        }));
    }
    const now = Date.now();
    for (const region of regions) {
        await pool.execute('INSERT INTO mkt_scan (region, next_index, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE next_index = VALUES(next_index), updated_at = VALUES(updated_at)',
            [region, pos[region], now]);
    }
    return report;
}

async function popularIds(pool, uniRegion, limit) {
    await ensureTables(pool);
    const [rows] = await pool.execute('SELECT item_id FROM mkt_popular WHERE region = ? AND velocity > 0 ORDER BY velocity DESC LIMIT ' + Number(limit || CANDIDATES), [uniRegion]);
    return rows.map(r => Number(r.item_id));
}

// ---------- tools ----------
// Best sellers on a world or a whole data center
async function bestSellers(pool, { world, scope, lang = 'en' }) {
    const where = regionOfWorld(world);
    if (!where) throw new Error('Unknown world');
    const ids = await popularIds(pool, where.uniRegion);
    if (!ids.length) return { warming: true, items: [] };
    const level = scope === 'dc' ? 'dc' : 'world';
    const data = await aggregated(world, ids);
    const rows = ids.map(id => ({ id, perDay: velocity(data.get(id), level), avg: avgPrice(data.get(id), level) }))
        .filter(r => r.perDay > 0).sort((a, b) => b.perDay - a.perDay).slice(0, 25);
    const names = await itemNames(rows.map(r => r.id), lang);
    return { scope: level, place: level === 'dc' ? where.dc : world, items: rows.map(r => ({ ...r, perDay: Math.round(r.perDay * 10) / 10, name: names.get(r.id).name })) };
}

// Buy cheap on another world, sell on your home world.
// mode 'dc' = your data center, 'region' = your whole region; materia = also look at Materia (travel rules: NA, EU and
// JP characters may visit Materia; Materia characters may not leave Oceania).
// sorts: any of 'profit', 'percent', 'fast', 'cheap' (equal weight: sum of ranks).
async function buySell(pool, { world, mode, materia, minDiff, minSales, sorts, lang = 'en' }) {
    const where = regionOfWorld(world);
    if (!where) throw new Error('Unknown world');
    const ids = await popularIds(pool, where.uniRegion);
    if (!ids.length) return { warming: true, items: [] };
    const level = mode === 'region' ? 'region' : 'dc';
    const home = await aggregated(world, ids);
    const useMateria = !!materia && where.dc !== 'Materia';
    const mat = useMateria ? await aggregated('Materia', ids) : null;

    const rows = [];
    for (const id of ids) {
        const r = home.get(id);
        const homeMin = minListing(r, 'world');
        const sellAt = homeMin ? homeMin.price : avgPrice(r, 'world');
        if (!sellAt) continue;
        const options = [];
        const away = minListing(r, level);
        if (away && away.worldId && (await worldName(away.worldId)) !== world) options.push(away);
        if (mat) { const m = minListing(mat.get(id), 'dc'); if (m) options.push(m); }
        if (!options.length) continue;
        const buy = options.reduce((a, b) => (b.price < a.price ? b : a));
        const profit = sellAt - buy.price;
        const perDay = velocity(r, 'world');
        if (profit <= 0 || profit < (Number(minDiff) || 0) || perDay < (Number(minSales) || 0)) continue;
        rows.push({ id, buyPrice: buy.price, buyWorldId: buy.worldId, sellAt, profit, percent: Math.round((profit / sellAt) * 100), perDay: Math.round(perDay * 10) / 10 });
    }
    const keys = { profit: r => -r.profit, percent: r => -r.percent, fast: r => -r.perDay, cheap: r => r.buyPrice };
    const chosen = (Array.isArray(sorts) ? sorts : []).filter(k => keys[k]);
    const use = chosen.length ? chosen : ['profit'];
    const score = new Map(rows.map(r => [r.id, 0]));
    for (const k of use) {
        [...rows].sort((a, b) => keys[k](a) - keys[k](b)).forEach((r, i) => score.set(r.id, score.get(r.id) + i));
    }
    const top = rows.sort((a, b) => score.get(a.id) - score.get(b.id) || b.profit - a.profit).slice(0, 10);
    const names = await itemNames(top.map(r => r.id), lang);
    for (const r of top) { r.name = names.get(r.id).name; r.buyWorld = await worldName(r.buyWorldId); delete r.buyWorldId; }
    return { mode: level, materia: useMateria, items: top };
}

// Sales of one item on a world over the last 30 days: [[unixSeconds, pricePerUnit, quantity, hq], ...]
async function history(world, itemId) {
    const data = await getJson(UNI + '/history/' + encodeURIComponent(world) + '/' + Number(itemId) + '?entriesToReturn=3000&entriesWithin=' + 30 * 86400, 10000);
    const names = await itemNames([Number(itemId)]);
    return {
        id: Number(itemId), name: names.get(Number(itemId)).name, world,
        sales: (data.entries || []).map(e => [Number(e.timestamp), Number(e.pricePerUnit), Number(e.quantity), e.hq ? 1 : 0])
    };
}

// Crafting profit: recipe from game data, each material at its cheapest price on your data center (and where),
// sub-recipes as buy or craft (whichever is cheaper). Shards, crystals and clusters are left out.
async function recipeFor(itemId) {
    const data = await getJson(XIV + '/search?sheets=Recipe&limit=1&fields=AmountResult,Ingredient[].row_id,AmountIngredient,CraftType.Name&query=' + encodeURIComponent('ItemResult=' + Number(itemId)), 8000);
    const row = data.results && data.results[0];
    if (!row) return null;
    const f = row.fields;
    const mats = (f.Ingredient || []).map((ing, i) => ({ id: Number(ing.row_id), amount: Number((f.AmountIngredient || [])[i]) || 0 }))
        .filter(m => m.id > 0 && m.amount > 0 && !CRYSTAL_IDS.has(m.id));
    return { yields: Number(f.AmountResult) || 1, craft: f.CraftType && f.CraftType.fields && f.CraftType.fields.Name || '', mats };
}

async function craftProfit(world, itemId) {
    const where = regionOfWorld(world);
    if (!where) throw new Error('Unknown world');
    const recipe = await recipeFor(itemId);
    if (!recipe) return { noRecipe: true };
    const subRecipes = new Map();
    for (const m of recipe.mats) subRecipes.set(m.id, await recipeFor(m.id));
    const allIds = new Set([Number(itemId), ...recipe.mats.map(m => m.id)]);
    for (const sub of subRecipes.values()) if (sub) sub.mats.forEach(m => allIds.add(m.id));
    const prices = await aggregated(world, [...allIds]);
    const cheapest = async id => {
        const best = minListing(prices.get(id), 'dc');
        const r = prices.get(id);
        const up = (r && r.worldUploadTimes || []).reduce((a, w) => Math.max(a, Number(w.timestamp) || 0), 0);
        return best ? { price: best.price, world: await worldName(best.worldId), updated: up || null } : { price: null, world: null, updated: up || null };
    };
    const names = await itemNames([...allIds]);
    let total = 0, missing = false;
    const lines = [];
    for (const m of recipe.mats) {
        const buy = await cheapest(m.id);
        const sub = subRecipes.get(m.id);
        let craft = null;
        if (sub) {
            let subTotal = 0, subMissing = false;
            const parts = [];
            for (const s of sub.mats) {
                const p = await cheapest(s.id);
                if (p.price === null) subMissing = true; else subTotal += p.price * s.amount;
                parts.push({ id: s.id, name: names.get(s.id).name, amount: s.amount, ...p });
            }
            craft = { perItem: subMissing ? null : Math.round(subTotal / sub.yields), yields: sub.yields, parts };
        }
        const options = [buy.price, craft && craft.perItem].filter(x => x !== null && x !== undefined);
        const unit = options.length ? Math.min(...options) : null;
        const choice = unit === null ? 'none' : (craft && craft.perItem === unit && (buy.price === null || craft.perItem < buy.price) ? 'craft' : 'buy');
        if (unit === null) missing = true; else total += unit * m.amount;
        lines.push({ id: m.id, name: names.get(m.id).name, amount: m.amount, buy, craft, choice, unit });
    }
    const sale = minListing(prices.get(Number(itemId)), 'world');
    const sellAt = sale ? sale.price : avgPrice(prices.get(Number(itemId)), 'world');
    const costPerItem = missing ? null : Math.round(total / recipe.yields);
    return {
        id: Number(itemId), name: names.get(Number(itemId)).name, craft: recipe.craft, yields: recipe.yields, world, dc: where.dc,
        lines, total: missing ? null : total, costPerItem, sellAt: sellAt || null,
        profitPerItem: costPerItem !== null && sellAt ? sellAt - costPerItem : null
    };
}

module.exports = {
    ensureTables, scanPopular, popularIds, loadPrefs, savePrefs, cleanPrefs, regionOfWorld, searchItems, itemNames,
    bestSellers, buySell, history, craftProfit, CRYSTAL_IDS, UNI_REGION, DATA_CENTERS
};
