// Fake XIVAPI v2 data for the Trivia tests, in en / fr / de / ja (same row ids, names in each language).
// rawFor(lang) gives the rows as utils/trivia.js fetches them ({ classJobs, territories, ... }); fakeGet(url) answers
// the /sheet and /search URLs the bank builder asks for (?language=xx, &after=, pages of 500), like XIVAPI v2 does:
// { rows: [{ row_id, fields }] } for sheets and { next, results: [{ row_id, fields }] } for searches.
// Some names are made to fail in one language on purpose (see BAD): those words must never be the word of the day.
'use strict';

const LANGS = ['en', 'fr', 'de', 'ja'];
const link = (sheet, id, fields) => ({ value: id, sheet, row_id: id, fields });
const by = (o, lang) => (o && typeof o === 'object' && !Array.isArray(o) && 'en' in o ? o[lang] : o);

// [en, fr, de, ja]
const ANIMALS = [
    ['Chocobo', 'chocobo', 'Chocobo', 'チョコボ'], ['Wolf', 'loup', 'Wolf', 'ウルフ'], ['Tiger', 'tigre', 'Tiger', 'タイガー'],
    ['Bear', 'ours', 'Bär', 'ベア'], ['Eagle', 'aigle', 'Adler', 'イーグル'], ['Dragon', 'dragon', 'Drache', 'ドラゴン'],
    ['Lion', 'lion', 'Löwe', 'ライオン'], ['Horse', 'cheval', 'Pferd', 'ホース'], ['Unicorn', 'licorne', 'Einhorn', 'ユニコーン'],
    ['Phoenix', 'phénix', 'Phönix', 'フェニックス'], ['Panther', 'panthère', 'Panther', 'パンサー'], ['Falcon', 'faucon', 'Falke', 'ファルコン'],
    ['Raven', 'corbeau', 'Rabe', 'レイヴン'], ['Serpent', 'serpent', 'Schlange', 'サーペント'], ['Griffin', 'griffon', 'Greif', 'グリフィン'],
    ['Turtle', 'tortue', 'Schildkröte', 'タートル'], ['Goat', 'chèvre', 'Ziege', 'ゴート'], ['Coeurl', 'coeurl', 'Coeurl', 'クァール'],
    ['Behemoth', 'béhémoth', 'Behemoth', 'ベヒーモス'], ['Stag', 'cerf', 'Hirsch', 'スタッグ']
];
const ADJ = [['Swift', 'rapide', 'Schnell', '疾風'], ['Iron', 'de fer', 'Eisen', '鉄'], ['Holy', 'sacré', 'Heilig', '聖'],
    ['Shadow', 'de l\'ombre', 'Schatten', '影'], ['Flame', 'de feu', 'Flammen', '炎']];
const tr = (arr, lang) => arr[LANGS.indexOf(lang)];

// Names that don't work in one language (the word must be skipped as word of the day)
const BAD = {
    // mount 900: ja name too long; mount 901: ja name empty; minion 902: fr name with odd characters; item 903: ja with 【】
    mount900: { en: 'Moogle', fr: 'mog', de: 'Mogry', ja: 'モーグリモーグリモーグリモーグリモーグリモーグリ' },
    mount901: { en: 'Kirin', fr: 'qilin', de: 'Kirin', ja: '' },
    minion902: { en: 'Wind-up Leader', fr: 'chef {mécanique}', de: 'Aufzieh-Anführer', ja: 'ゼンマイ指導者' },
    item903: { en: 'Grade Seven Tincture', fr: 'Teinture de grade 7', de: 'Stufe-7-Tinktur', ja: '【強化薬】グレード7' }
};

const JOBS = [
    // id, [en, fr, de, ja], jobIndex, parent id, role, stat, abbr per lang, category id, town
    [1, ['gladiator', 'gladiateur', 'Gladiator', '剣術士'], 0, 1, 1, 1, ['GLA', 'GLA', 'GLA', '剣'], 30, 1],
    [19, ['paladin', 'paladin', 'Paladin', 'ナイト'], 1, 1, 1, 1, ['PLD', 'PLD', 'PLD', 'ナ'], 30, 1],
    [2, ['pugilist', 'pugiliste', 'Faustkämpfer', '格闘士'], 0, 2, 2, 2, ['PGL', 'PUG', 'FAU', '格'], 30, 3],
    [20, ['monk', 'moine', 'Mönch', 'モンク'], 2, 2, 2, 2, ['MNK', 'MOI', 'MÖN', 'モ'], 30, 3],
    [3, ['marauder', 'maraudeur', 'Marodeur', '斧術士'], 0, 3, 1, 1, ['MRD', 'MRD', 'MAR', '斧'], 30, 2],
    [21, ['warrior', 'guerrier', 'Krieger', '戦士'], 3, 3, 1, 1, ['WAR', 'GUE', 'KRG', '戦'], 30, 2],
    [4, ['lancer', 'maître d\'hast', 'Pikenier', '槍術士'], 0, 4, 2, 1, ['LNC', 'MHT', 'PIK', '槍'], 30, 2],
    [22, ['dragoon', 'chevalier dragon', 'Dragoon', '竜騎士'], 4, 4, 2, 1, ['DRG', 'CDR', 'DRG', '竜'], 30, 2],
    [5, ['archer', 'archer', 'Waldläufer', '弓術士'], 0, 5, 3, 2, ['ARC', 'ARC', 'WLD', '弓'], 30, 2],
    [23, ['bard', 'barde', 'Barde', '吟遊詩人'], 5, 5, 3, 2, ['BRD', 'BAR', 'BAR', '詩'], 30, 2],
    [6, ['conjurer', 'élémentaliste', 'Druide', '幻術士'], 0, 6, 4, 5, ['CNJ', 'ÉLM', 'DRU', '幻'], 31, 2],
    [24, ['white mage', 'mage blanc', 'Weißmagier', '白魔道士'], 6, 6, 4, 5, ['WHM', 'MBL', 'WMA', '白'], 31, 2],
    [7, ['thaumaturge', 'occultiste', 'Thaumaturg', '呪術士'], 0, 7, 3, 4, ['THM', 'OCC', 'THA', '呪'], 31, 3],
    [25, ['black mage', 'mage noir', 'Schwarzmagier', '黒魔道士'], 7, 7, 3, 4, ['BLM', 'MNO', 'SMA', '黒'], 31, 3],
    [30, ['ninja', 'ninja', 'Ninja', '忍者'], 8, 30, 2, 2, ['NIN', 'NIN', 'NIN', '忍'], 30, 0],
    [32, ['dark knight', 'chevalier noir', 'Dunkelritter', '暗黒騎士'], 9, 32, 1, 1, ['DRK', 'CHN', 'DKR', '暗'], 30, 0],
    [37, ['gunbreaker', 'pistosabreur', 'Revolverklinge', 'ガンブレイカー'], 10, 37, 1, 1, ['GNB', 'PSB', 'RVK', 'ガ'], 30, 0],
    [38, ['dancer', 'danseur', 'Tänzer', '踊り子'], 11, 38, 3, 2, ['DNC', 'DNS', 'TÄN', '踊'], 30, 0],
    [36, ['blue mage', 'mage bleu', 'Blaumagier', '青魔道士'], 12, 36, 3, 4, ['BLU', 'MBU', 'BMA', '青'], 31, 3],
    [8, ['carpenter', 'menuisier', 'Zimmerer', '木工師'], 0, 8, 0, 0, ['CRP', 'MEN', 'ZMR', '木'], 33, 2],
    [9, ['blacksmith', 'forgeron', 'Grobschmied', '鍛冶師'], 0, 9, 0, 0, ['BSM', 'FRG', 'GRS', '鍛'], 33, 1],
    [0, ['adventurer', 'aventurier', 'Abenteurer', '冒険者'], 0, 0, 0, 0, ['ADV', 'AVT', 'ABT', '冒'], 0, 0]
];
const CATEGORIES = { 30: ['Disciple of War', 'Disciple de la guerre', 'Disziplin des Krieges', 'ファイター'],
    31: ['Disciple of Magic', 'Disciple de la magie', 'Disziplin der Magie', 'ソーサラー'],
    33: ['Disciple of the Hand', 'Disciple de la main', 'Disziplin der Handfertigkeit', 'クラフター'], 0: ['', '', '', ''] };
const TOWNS = { 1: ['Limsa Lominsa', 'Limsa Lominsa', 'Limsa Lominsa', 'リムサ・ロミンサ'], 2: ['Gridania', 'Gridania', 'Gridania', 'グリダニア'],
    3: ['Ul\'dah', 'Ul\'dah', 'Ul\'dah', 'ウルダハ'], 0: ['Nowheresville', 'Nulle part', 'Nirgendwo', 'どこでもない町'] };

const REGIONS = { 22: ['La Noscea', 'La Noscea', 'La Noscea', 'ラノシア'], 23: ['The Black Shroud', 'Forêt de Sombrelinceul', 'Dunkelwald', '黒衣森'],
    24: ['Thanalan', 'Thanalan', 'Thanalan', 'ザナラーン'] };
const EXP = ['A Realm Reborn', 'A Realm Reborn', 'A Realm Reborn', '新生エオルゼア'];
const PLACES = [
    // territory id, place id, names, region id, use (0 city, 1 zone)
    [128, 28, ['Limsa Lominsa', 'Limsa Lominsa', 'Limsa Lominsa', 'リムサ・ロミンサ'], 22, 0],
    [132, 52, ['Gridania', 'Gridania', 'Gridania', 'グリダニア'], 23, 0],
    [130, 40, ['Ul\'dah', 'Ul\'dah', 'Ul\'dah', 'ウルダハ'], 24, 0],
    [134, 30, ['Middle La Noscea', 'Noscea centrale', 'Zentrales La Noscea', '中央ラノシア'], 22, 1],
    [135, 31, ['Lower La Noscea', 'Basse-Noscea', 'Unteres La Noscea', '低地ラノシア'], 22, 1],
    [137, 32, ['Eastern La Noscea', 'Noscea orientale', 'Östliches La Noscea', '東ラノシア'], 22, 1],
    [138, 33, ['Western La Noscea', 'Noscea occidentale', 'Westliches La Noscea', '西ラノシア'], 22, 1],
    [148, 54, ['Central Shroud', 'Forêt centrale', 'Tiefer Wald', '黒衣森：中央森林'], 23, 1],
    [140, 42, ['Western Thanalan', 'Thanalan occidental', 'Westliches Thanalan', '西ザナラーン'], 24, 1],
    [141, 43, ['Central Thanalan', 'Thanalan central', 'Zentrales Thanalan', '中央ザナラーン'], 24, 1],
    [145, 44, ['Eastern Thanalan', 'Thanalan oriental', 'Östliches Thanalan', '東ザナラーン'], 24, 1],
    [146, 45, ['Southern Thanalan', 'Thanalan méridional', 'Südliches Thanalan', '南ザナラーン'], 24, 1]
];
const DUTIES = [
    // id, names, type (en), level
    [4, ['Sastasha', 'Sastasha', 'Sastasha', 'サスタシャ浸食洞'], 'Dungeons', 15],
    [2, ['the Tam-Tara Deepcroft', 'l\'Hypogée de Tam-Tara', 'Tam-Tara-Gruft', 'タムタラの墓所'], 'Dungeons', 16],
    [3, ['Copperbell Mines', 'les Mines de Clochecuivre', 'Kupferglocken-Mine', 'カッパーベル銅山'], 'Dungeons', 17],
    [6, ['Haukke Manor', 'le Manoir des Haukke', 'Haukke-Herrenhaus', 'ハウケタ御用邸'], 'Dungeons', 28],
    [56, ['the Bowl of Embers', 'le Cratère des tisons', 'Das Grab der Lohe', 'イフリート討伐戦'], 'Trials', 20],
    [57, ['the Navel', 'le Nombril', 'Der Nabel', 'タイタン討伐戦'], 'Trials', 34],
    [58, ['the Howling Eye', 'Hurlœil', 'Das Tosende Auge', 'ガルーダ討伐戦'], 'Trials', 44],
    [92, ['the Labyrinth of the Ancients', 'le Labyrinthe des Anciens', 'Das Labyrinth der Alten', '古代の民の迷宮'], 'Raids', 50],
    [93, ['the Binding Coil of Bahamut', 'le Labyrinthe de Bahamut', 'Verschlungene Schatten', '大迷宮バハムート'], 'Raids', 50],
    [94, ['the Unending Coil of Bahamut', 'l\'Abîme infini de Bahamut', 'Endlose Schatten', '絶バハムート討滅戦'], 'Ultimate Raids', 70]
];

function names4(i) { return ANIMALS[i]; }

function rawFor(lang) {
    const L = arr => tr(arr, lang);
    const raw = { classJobs: [], territories: [], content: [], contentLore: [], mounts: [], mountLore: [], minions: [], minionLore: [], actions: [], actionLore: [], items: [], recipes: [] };
    for (const [id, nm, jobIndex, parent, role, stat, abbr, cat, town] of JOBS) {
        const parentRow = JOBS.find(j => j[0] === parent) || JOBS[0];
        raw.classJobs.push({ row_id: id, fields: {
            Name: L(nm), Abbreviation: L(abbr), Role: role, JobIndex: jobIndex, PrimaryStat: stat, StartingLevel: jobIndex >= 8 && jobIndex <= 11 ? (jobIndex === 8 ? 1 : 60) : 1,
            IsLimitedJob: id === 36,
            ClassJobParent: link('ClassJob', parent, { Name: L(parentRow[1]) }),
            ClassJobCategory: link('ClassJobCategory', cat, { Name: L(CATEGORIES[cat]) }),
            StartingTown: link('Town', town, { Name: L(TOWNS[town]) })
        } });
    }
    for (const [tid, pid, nm, rid, use] of PLACES) {
        raw.territories.push({ row_id: tid, fields: {
            PlaceName: link('PlaceName', pid, { Name: L(nm) }), PlaceNameRegion: link('PlaceName', rid, { Name: L(REGIONS[rid]) }),
            PlaceNameZone: link('PlaceName', rid, { Name: L(REGIONS[rid]) }), ExVersion: link('ExVersion', 0, { Name: L(EXP) }), TerritoryIntendedUse: use
        } });
    }
    const TYPE = { Dungeons: ['Dungeons', 'Donjons', 'Dungeons', 'ダンジョン'], Trials: ['Trials', 'Défis', 'Prüfungen', '討伐・討滅戦'],
        Raids: ['Raids', 'Raids', 'Raids', 'レイド'], 'Ultimate Raids': ['Ultimate Raids', 'Raids fatals', 'Fatale Raids', '絶']};
    for (const [id, nm, type, level] of DUTIES) {
        raw.content.push({ row_id: id, fields: {
            Name: L(nm), ContentType: link('ContentType', 2, { Name: L(TYPE[type]) }), ClassJobLevelRequired: level, ClassJobLevelSync: level,
            ItemLevelRequired: 0, ItemLevelSync: 0, HighEndDuty: type === 'Ultimate Raids', LevelingRoulette: type === 'Dungeons', TrialRoulette: type === 'Trials',
            TerritoryType: link('TerritoryType', 1000 + id, { PlaceName: link('PlaceName', 2000 + id, { Name: L(nm) }),
                PlaceNameRegion: link('PlaceName', 22, { Name: L(REGIONS[22]) }), ExVersion: link('ExVersion', 0, { Name: L(EXP) }) })
        } });
        raw.contentLore.push({ row_id: id, fields: { Description: {
            en: 'A dangerous place full of monsters and old secrets waiting for brave adventurers. Bring friends.',
            fr: 'Un lieu dangereux rempli de monstres et de vieux secrets qui attendent des aventuriers courageux. Venez à plusieurs.',
            de: 'Ein gefährlicher Ort voller Monster und alter Geheimnisse, die auf mutige Abenteurer warten. Bringt Freunde mit.',
            ja: '魔物と古い秘密に満ちた危険な場所。勇敢な冒険者を待っている。仲間を連れて行こう。'
        }[lang] } });
    }
    // Mounts: 20 short (Normal) + 20 long (Ultimate) + bad ones
    ANIMALS.forEach((a, i) => {
        raw.mounts.push({ row_id: 1 + i, fields: { Singular: L(a), ExtraSeats: i % 3 === 0 ? 1 : 0 } });
        raw.mountLore.push({ row_id: 1 + i, fields: {
            Description: { en: 'A loyal ' + a[0] + ' that carries you across the realm.', fr: 'Un fidèle ' + a[1] + ' qui vous porte à travers le monde.',
                de: 'Ein treuer ' + a[2] + ', der dich durch die Welt trägt.', ja: '世界中を運んでくれる忠実な' + a[3] + '。' }[lang],
            Tooltip: { en: 'It never tires, even after a very long ride.', fr: 'Il ne se fatigue jamais, même après une très longue course.',
                de: 'Es wird nie müde, selbst nach einem sehr langen Ritt.', ja: 'とても長く走っても、決して疲れない頼もしい相棒だ。' }[lang]
        } });
        const long = { en: 'magitek armored ' + a[0].toLowerCase(), fr: 'armure magitek ' + a[1], de: 'Magitek-Rüstung ' + a[2], ja: '魔導アーマー' + a[3] }[lang];
        raw.mounts.push({ row_id: 101 + i, fields: { Singular: long, ExtraSeats: 0 } });
    });
    raw.mounts.push({ row_id: 900, fields: { Singular: BAD.mount900[lang], ExtraSeats: 0 } });
    raw.mounts.push({ row_id: 901, fields: { Singular: BAD.mount901[lang], ExtraSeats: 0 } });
    // Minions: 20 short (Extreme) + 20 long (Ultimate)
    ANIMALS.forEach((a, i) => {
        const short = { en: 'wind-up ' + a[0].toLowerCase(), fr: a[1] + ' mécanique', de: 'Aufzieh-' + a[2], ja: 'ゼンマイ' + a[3] }[lang];
        raw.minions.push({ row_id: 1 + i, fields: { Singular: short, MinionRace: link('MinionRace', 1, { Name: { en: 'Monsters', fr: 'Monstres', de: 'Monster', ja: 'モンスター' }[lang] }),
            Behavior: link('CompanionMove', 1, { Name: { en: 'Normal', fr: 'Normal', de: 'Normal', ja: 'ノーマル' }[lang] }) } });
        raw.minionLore.push({ row_id: 1 + i, fields: { Description: { en: 'This tiny toy moves around on its own when you wind it up.', fr: 'Ce petit jouet bouge tout seul quand on le remonte.',
            de: 'Dieses kleine Spielzeug bewegt sich von selbst, wenn man es aufzieht.', ja: 'ゼンマイを巻くと勝手に動き回る小さなおもちゃ。' }[lang],
            Tooltip: '', SpecialActionName: '', MinionSkillType: link('MinionSkillType', 1, { Name: { en: 'Gate', fr: 'Porte', de: 'Tor', ja: 'ゲート' }[lang] }), Attack: 3, Defense: 2, Speed: 1 } });
        const long = { en: 'the lord of the ' + a[0].toLowerCase() + 's', fr: 'seigneur des ' + a[1] + 's', de: 'Herr der ' + a[2], ja: a[3] + 'の王' }[lang];
        raw.minions.push({ row_id: 101 + i, fields: { Singular: long } });
    });
    raw.minions.push({ row_id: 902, fields: { Singular: BAD.minion902[lang] } });
    // Actions: 20 (level 10..48 -> Hard and Savage) + 20 (level 60..98 -> Savage)
    for (let i = 0; i < 40; i++) {
        const a = ANIMALS[i % 20], adj = ADJ[i % 5];
        const nm = { en: (i < 20 ? '' : 'Greater ') + adj[0] + ' ' + a[0] + ' Strike', fr: 'Frappe ' + a[1] + ' ' + adj[1] + (i < 20 ? '' : ' supérieure'),
            de: (i < 20 ? '' : 'Große ') + adj[2] + '-' + a[2] + '-Schlag', ja: (i < 20 ? '' : '大') + adj[3] + a[3] + 'ストライク' }[lang];
        const job = JOBS[1 + (i % 10)];
        raw.actions.push({ row_id: 5000 + i, fields: { Name: nm, ClassJob: link('ClassJob', job[0], { Name: L(job[1]) }), ClassJobLevel: i < 20 ? 10 + i * 2 : 60 + (i - 20) * 2,
            IsPvP: false, IsPlayerAction: true, ActionCategory: link('ActionCategory', 2, { Name: { en: 'Weaponskill', fr: 'Technique d\'arme', de: 'Waffenfertigkeit', ja: 'ウェポンスキル' }[lang] }),
            ClassJobCategory: link('ClassJobCategory', 1, { Name: L(job[1]) }), Cast100ms: i % 4 === 0 ? 25 : 0, Recast100ms: 25, Range: 3, EffectRange: 0, MaxCharges: 0,
            IsRoleAction: false, CanTargetHostile: true, CanTargetParty: false, CanTargetSelf: false, TargetArea: false } });
        raw.actionLore.push({ row_id: 5000 + i, fields: { Description: { en: 'Delivers an attack with a potency of 200 to the target in front of you.',
            fr: 'Inflige des dégâts d\'une puissance de 200 à la cible devant vous.', de: 'Fügt dem Ziel vor dir Schaden mit einer Wirkungsstärke von 200 zu.',
            ja: '対象に物理攻撃。威力は200。前方の敵に攻撃する。' }[lang] } });
    }
    // Items: 20 rings (2+ words in English -> Ultimate) + a bad one + a one-word item (never used)
    for (let i = 0; i < 20; i++) {
        const a = ANIMALS[i], adj = ADJ[i % 5];
        const nm = { en: adj[0] + ' ' + a[0] + ' Ring', fr: 'Bague ' + a[1] + ' ' + adj[1], de: adj[2] + '-' + a[2] + '-Ring', ja: adj[3] + a[3] + 'リング' }[lang];
        raw.items.push({ row_id: 7000 + i, fields: { Name: nm, Description: { en: 'A ring made by a famous artisan of the realm.', fr: 'Une bague faite par un artisan célèbre du royaume.',
            de: 'Ein Ring, den ein berühmter Handwerker des Reiches gefertigt hat.', ja: '有名な職人が作った指輪。とても美しい。' }[lang],
            ItemSearchCategory: link('ItemSearchCategory', 40, { Name: { en: 'Rings', fr: 'Bagues', de: 'Ringe', ja: '指輪' }[lang] }), LevelItem: 100 + i,
            ItemUICategory: link('ItemUICategory', 43, { Name: { en: 'Ring', fr: 'Bague', de: 'Ring', ja: '指輪' }[lang] }), LevelEquip: 50,
            ClassJobCategory: link('ClassJobCategory', 1, { Name: { en: 'All Classes', fr: 'Toutes les classes', de: 'Alle Klassen', ja: '全クラス' }[lang] }),
            Rarity: 1 + (i % 3), GrandCompany: link('GrandCompany', 0, { Name: '' }), ItemSeries: link('ItemSeries', 0, { Name: '' }),
            MateriaSlotCount: i % 3, DyeCount: 0, StackSize: 1, CanBeHq: true, IsUnique: false, IsCollectable: false } });
        raw.recipes.push({ row_id: 300 + i, fields: { ItemResult: link('Item', 7000 + i, { Name: nm }), CraftType: link('CraftType', i % 2,
            { Name: [['Woodworking', 'Menuiserie', 'Zimmerei', '木工'], ['Smithing', 'Forge', 'Schmiedekunst', '鍛冶']][i % 2][LANGS.indexOf(lang)] }), IsExpert: i === 3 } });
    }
    raw.items.push({ row_id: 903, fields: { Name: BAD.item903[lang], ItemSearchCategory: link('ItemSearchCategory', 40, { Name: 'x' }), LevelItem: 1 } });
    raw.items.push({ row_id: 904, fields: { Name: { en: 'Potion', fr: 'Potion', de: 'Trank', ja: 'ポーション' }[lang], ItemSearchCategory: link('ItemSearchCategory', 40, { Name: 'x' }), LevelItem: 1 } });
    return raw;
}

// Which raw key each sheet fills
const SHEETS = { ClassJob: 'classJobs', TerritoryType: 'territories', ContentFinderCondition: 'content', ContentFinderConditionTransient: 'contentLore',
    Mount: 'mounts', MountTransient: 'mountLore', Companion: 'minions', CompanionTransient: 'minionLore', Action: 'actions', ActionTransient: 'actionLore',
    Item: 'items', Recipe: 'recipes' };

// Answers like XIVAPI v2 (only what the bank builder uses). calls: every URL asked for.
function makeFakeGet({ failLang } = {}) {
    const calls = [];
    const cache = {};
    const rows = (lang, key) => { cache[lang] = cache[lang] || rawFor(lang); return cache[lang][key] || []; };
    async function get(url) {
        calls.push(url);
        const u = new URL(url);
        const lang = u.searchParams.get('language') || 'en';
        if (failLang && lang === failLang) { const e = new Error('XIVAPI down for ' + lang); throw e; }
        if (!LANGS.includes(lang)) throw new Error('bad language ' + lang);
        const limit = Number(u.searchParams.get('limit')) || 100;
        if (u.pathname.endsWith('/search')) {
            const sheet = u.searchParams.get('sheets') || 'Action';
            const cursor = u.searchParams.get('cursor');
            const all = rows(lang, SHEETS[sheet] || 'actions');
            const from = cursor ? Number(cursor) : 0;
            const page = all.slice(from, from + limit);
            return { data: { next: from + limit < all.length ? String(from + limit) : null, results: page.map(r => ({ score: 1, sheet, row_id: r.row_id, fields: r.fields })) } };
        }
        const m = /\/sheet\/(\w+)$/.exec(u.pathname);
        if (!m) throw new Error('unknown url ' + url);
        const all = rows(lang, SHEETS[m[1]]).slice().sort((a, b) => a.row_id - b.row_id);
        const after = u.searchParams.has('after') ? Number(u.searchParams.get('after')) : -1;
        return { data: { rows: all.filter(r => r.row_id > after).slice(0, limit) } };
    }
    return { get, calls };
}

module.exports = { LANGS, rawFor, makeFakeGet, BAD, by };
