const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { pool } = require('../utils/db');
const axios = require('axios');
const cheerio = require('cheerio');
const sharp = require('sharp');
const QRCode = require('qrcode');
const { t, discordLocalizations } = require('../utils/i18n');
const userLanguage = require('../utils/userLanguage');
const ignClaims = require('../utils/ignClaims');
const ffxivCollect = require('../utils/ffxivCollect');
const cardStats = require('../utils/ignCardStats');
const safeImage = require('../utils/safeImage');
safeImage.blockUnsafeDecoders(sharp);

const jobIconMap = {
    'Paladin': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/paladin.png',
    'Warrior': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/warrior.png',
    'Dark Knight': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/darkknight.png',
    'Gunbreaker': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/gunbreaker.png',
    'White Mage': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/whitemage.png',
    'Scholar': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/scholar.png',
    'Astrologian': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/astrologian.png',
    'Sage': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/sage.png',
    'Monk': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/monk.png',
    'Dragoon': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/dragoon.png',
    'Ninja': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/ninja.png',
    'Samurai': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/samurai.png',
    'Reaper': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/reaper.png',
    'Viper': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/viper.png',
    'Bard': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/bard.png',
    'Machinist': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/machinist.png',
    'Dancer': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/dancer.png',
    'Black Mage': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/blackmage.png',
    'Summoner': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/summoner.png',
    'Red Mage': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/redmage.png',
    'Pictomancer': 'https://raw.githubusercontent.com/rkyle27/classjob-icons/766cb47831435a83f04d904146bd3472501564c5/icons/pictomancer.png'
};

async function fetchLodestoneData(lodestoneId) {
    try {
        const url = `https://na.finalfantasyxiv.com/lodestone/character/${lodestoneId}/`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);

        const title = $('.frame__chara__title').text().trim() || $('.entry__chara__title').text().trim();
        const name = $('.frame__chara__name').text().trim() || $('.entry__chara__name').text().trim();
        const worldServerLine = $('.frame__chara__world').text().trim() || $('.entry__chara__world').text().trim();

        let world = '';
        let datacenter = '';
        const match = worldServerLine.match(/^(.*?)\s*[\(\[](.*?)[\)\]]$/);
        if (match) {
            world = match[1].trim();
            datacenter = match[2].trim();
        } else {
            world = worldServerLine;
        }

        const portraitUrl = $('.js__image_popup').attr('href') || $('.entry__chara__image img').attr('src') || null;
        const freeCompany = $('.entry__free-company__name--side, .character__freecompany__name h4 a, .head-my-character__fc_name').first().text().trim();

        let race = '';
        let clanGender = '';
        let birthday = '';
        let guardian = '';
        let cityState = '';
        let grandCompany = '';

        let headshotFaceIcon = '';
        let namedayIcon = '';
        let cityStateIcon = '';
        let grandCompanyIcon = '';

        $('.character-block').each((i, block) => {
            const titleText = $(block).find('.character-block__title').text().trim();
            const nameHtml = $(block).find('.character-block__name').html() || '';
            const nameText = $(block).find('.character-block__name').text().trim();
            const birthText = $(block).find('.character-block__birth').text().trim();

            const blockImg = $(block).find('img').first().attr('src');

            if (titleText.includes('Race/Clan/Gender') || nameText.includes('Seeker') || nameText.includes('Keeper') || nameText.includes('Midlander') || nameText.includes('Highlander')) {
                if (blockImg) headshotFaceIcon = blockImg;
                if (nameHtml.includes('<br')) {
                    const parts = nameHtml.split(/<br\s*[\/]?>/i).map(p => cheerio.load(p).text().trim()).filter(Boolean);
                    if (parts.length >= 1) race = parts[0];
                    if (parts.length >= 2) clanGender = parts[1];
                } else {
                    const parts = nameText.split('\n').map(p => p.trim()).filter(Boolean);
                    if (parts.length >= 1) race = parts[0];
                    if (parts.length >= 2) clanGender = parts.slice(1).join(' / ');
                }
            }
            if (titleText.includes('Nameday') || titleText.includes('Birthday') || birthText) {
                if (blockImg) namedayIcon = blockImg;
                if (birthText) birthday = birthText;
            }
            if (titleText.includes('Guardian')) {
                guardian = nameText;
            }
            if (titleText.includes('City-state')) {
                if (blockImg) cityStateIcon = blockImg;
                cityState = nameText;
            }
            if (titleText.includes('Grand Company')) {
                if (blockImg) grandCompanyIcon = blockImg;
                grandCompany = nameText;
            }
        });

        let fcCrestLayers = [];
        $('.character__freecompany__crest__image img').each((i, imgEl) => {
            const src = $(imgEl).attr('src');
            if (src) fcCrestLayers.push(src);
        });

        const jobLevels = [];
        $('.character__level__list li').each((i, li) => {
            const levelText = $(li).text().trim();
            jobLevels.push(levelText || '-');
        });

        const bannerImgNode = $('.character__class__data img.character__classjob').attr('src');
        const classIconImgNode = $('.character__class__data .character__class_icon img').attr('src');

        return {
            success: true,
            name,
            title,
            world,
            datacenter,
            race,
            clanGender,
            birthday,
            guardian,
            cityState,
            grandCompany,
            freeCompany,
            portrait: portraitUrl,
            headshotFaceIcon,
            namedayIcon,
            cityStateIcon,
            grandCompanyIcon,
            fcCrestLayers,
            currentJobBannerIcon: bannerImgNode || '',
            currentJobClassIcon: classIconImgNode || '',
            jobLevels
        };
    } catch (err) {
        console.error('Lodestone scrape error:', err.message);
        return { success: false, error: err.message };
    }
}

async function generateCard(config, data) {
    const width = 1100;
    const height = 700;

    let backgroundAssets = [];
    let foregroundAssets = [];

    let finalLayers = [
        {
            input: await sharp({
                create: {
                    width: width,
                    height: height,
                    channels: 4,
                    background: { r: 6, g: 12, b: 24, alpha: 1 }
                }
            }).png().toBuffer(), left: 0, top: 0
        }
    ];

    // Full Background image (aetherialsea.png) on lowest layer
    try {
        const bgRes = await axios.get('https://raw.githubusercontent.com/rkyle27/pingway/refs/heads/main/misc/aetherialsea.png', { responseType: 'arraybuffer', timeout: 8000 });
        const bgBuffer = await sharp(Buffer.from(bgRes.data))
            .resize(width, height, { fit: 'cover', position: 'top' })
            .toBuffer();
        finalLayers.push({ input: bgBuffer, left: 0, top: 0 });
    } catch (e) {
        console.error('Failed to load aetherialsea.png background:', e.message);
    }

    // Full photo if present in database (covers background)
    if (config.full_photo_url) {
        try {
            const photoBuf = await safeImage.fetchUserImage(config.full_photo_url);
            const customBuffer = await sharp(photoBuf, safeImage.SHARP_INPUT_OPTIONS)
                .resize(width, height, { fit: 'cover', position: 'top' })
                .toBuffer();
            finalLayers.push({ input: customBuffer, left: 0, top: 0 });
        } catch (e) {
            console.error('Failed to load full photo:', e.message);
        }
    }

    // Portrait (whether Lodestone default or user given url) is rendered higher than full photo
    if (config.portrait_toggle) {
        let portraitSourceUrl = config.portrait_url ? config.portrait_url : data.portrait;
        if (portraitSourceUrl) {
            try {
                let resizedPortrait;
                if (config.portrait_url) {
                    // user-given link: safe download + pixel limit
                    const portraitBuf = await safeImage.fetchUserImage(portraitSourceUrl);
                    resizedPortrait = await sharp(portraitBuf, safeImage.SHARP_INPUT_OPTIONS)
                        .resize(420, 700, { fit: 'cover', position: 'top' })
                        .toBuffer();
                } else {
                const imgRes = await axios.get(portraitSourceUrl, { responseType: 'arraybuffer', timeout: 8000 });
                resizedPortrait = await sharp(Buffer.from(imgRes.data))
                    .resize(420, 700, { fit: 'cover', position: 'top' })
                    .toBuffer();
                }
                finalLayers.push({ input: resizedPortrait, left: 0, top: 0 });
            } catch (e) {
                console.error('Failed to load portrait:', e.message);
            }
        }
    }

    let jobsImgBuffer = null;
    try {
        const jobsRes = await axios.get('https://raw.githubusercontent.com/rkyle27/pingway/refs/heads/main/misc/JOBS.png', {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const originalMetadata = await sharp(Buffer.from(jobsRes.data)).metadata();
        const targetWidth = Math.round(originalMetadata.width * 0.7);

        jobsImgBuffer = await sharp(Buffer.from(jobsRes.data))
            .resize({ width: targetWidth })
            .toBuffer();
    } catch (e) {
        console.error('Failed to fetch/resize JOBS.png from repository:', e.message);
    }

    let qrCodeBuffer = null;
    try {
        const profileUrl = `https://na.finalfantasyxiv.com/lodestone/character/${config.lodestone_id}/`;
        const qrBuffer = await QRCode.toBuffer(profileUrl, {
            type: 'png',
            margin: 1,
            width: 135,
            color: { dark: '#000000ff', light: '#ffffffff' }
        });
        qrCodeBuffer = await sharp(qrBuffer).resize(135, 135).toBuffer();
    } catch (e) {
        console.error('Failed to generate QR code:', e.message);
    }

    // Tomestone QR and Badge (QR = 83, Badge width = 110, height = 60)
    let tomestoneQrBuffer = null;
    let tomestoneBadgeBuffer = null;
    if (config.tomestone_url && config.tomestone_url.trim() !== '') {
        try {
            const tmQrBuffer = await QRCode.toBuffer(config.tomestone_url.trim(), {
                type: 'png',
                margin: 1,
                width: 83,
                color: { dark: '#000000ff', light: '#ffffffff' }
            });
            tomestoneQrBuffer = await sharp(tmQrBuffer).resize(83, 83).toBuffer();

            const tmRes = await axios.get('https://raw.githubusercontent.com/rkyle27/pingway/refs/heads/main/misc/tomestone.png', {
                responseType: 'arraybuffer',
                timeout: 8000
            });
            tomestoneBadgeBuffer = await sharp(Buffer.from(tmRes.data))
                .resize(110, 60, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .toBuffer();
        } catch (e) {
            console.error('Failed to load tomestone assets:', e.message);
        }
    }

    // FFLogs QR and Badge (QR = 83, Badge width = 110, height = 60)
    let fflogsQrBuffer = null;
    let fflogsBadgeBuffer = null;
    if (config.fflogs_url && config.fflogs_url.trim() !== '') {
        try {
            const ffQrBuffer = await QRCode.toBuffer(config.fflogs_url.trim(), {
                type: 'png',
                margin: 1,
                width: 83,
                color: { dark: '#000000ff', light: '#ffffffff' }
            });
            fflogsQrBuffer = await sharp(ffQrBuffer).resize(83, 83).toBuffer();

            const ffRes = await axios.get('https://raw.githubusercontent.com/rkyle27/pingway/refs/heads/main/misc/fflogs_soUC.png', {
                responseType: 'arraybuffer',
                timeout: 8000
            });
            fflogsBadgeBuffer = await sharp(Buffer.from(ffRes.data))
                .resize(110, 60, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .toBuffer();
        } catch (e) {
            console.error('Failed to load fflogs assets:', e.message);
        }
    }

    let bannerIconBuffer = null;
    if (data.currentJobBannerIcon) {
        try {
            const iconRes = await axios.get(data.currentJobBannerIcon, { responseType: 'arraybuffer', timeout: 8000 });
            bannerIconBuffer = await sharp(iconRes.data)
                .resize(230, 24, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .toBuffer();
        } catch (e) {
            console.error('Failed to load banner icon asset:', e.message);
        }
    }

    let classIconBuffer = null;
    if (data.currentJobClassIcon) {
        try {
            const iconRes = await axios.get(data.currentJobClassIcon, { responseType: 'arraybuffer', timeout: 8000 });
            classIconBuffer = await sharp(Buffer.from(iconRes.data))
                .resize(64, 64, { kernel: sharp.kernel.nearest })
                .toBuffer();
        } catch (e) {
            console.error('Failed to load class icon asset:', e.message);
        }
    }

    async function processDynamicAsset(url, size, alpha = 255) {
        if (!url) return null;
        try {
            const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
            return await sharp(Buffer.from(res.data))
                .resize(Math.round(size), Math.round(size), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .ensureAlpha()
                .linear(1, 0)
                .composite([{ input: Buffer.from([255, 255, 255, alpha]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
                .toBuffer();
        } catch (e) {
            console.error('Failed to load extracted asset from URL:', e.message);
            return null;
        }
    }

    // Headshot Buffer with 2px sharp-cornered border
    const headshotBuffer = await processDynamicAsset(data.headshotFaceIcon, 80, 255);
    if (headshotBuffer) {
        const borderWidth = 2;
        const borderedHeadshot = await sharp(headshotBuffer)
            .extend({
                top: borderWidth,
                bottom: borderWidth,
                left: borderWidth,
                right: borderWidth,
                background: { r: 255, g: 255, b: 255, alpha: 0.8 }
            })
            .toBuffer();
        backgroundAssets.push({ input: borderedHeadshot, left: Math.round(965 - borderWidth), top: Math.round(35 - borderWidth) });
    }

    if (data.fcCrestLayers && data.fcCrestLayers.length > 0) {
        for (const crestUrl of data.fcCrestLayers) {
            const crestBuffer = await processDynamicAsset(crestUrl, 80, 191);
            if (crestBuffer) backgroundAssets.push({ input: crestBuffer, left: 595, top: 35 });
        }
    }

    const cityStateBuffer = await processDynamicAsset(data.cityStateIcon, 112, 191);
    if (cityStateBuffer) backgroundAssets.push({ input: cityStateBuffer, left: 445, top: 150 });

    const namedayBuffer = await processDynamicAsset(data.namedayIcon, 40, 191);
    if (namedayBuffer) backgroundAssets.push({ input: namedayBuffer, left: 850, top: 230 });

    const gcBuffer = await processDynamicAsset(data.grandCompanyIcon, 48, 255);
    if (gcBuffer) foregroundAssets.push({ input: gcBuffer, left: 935, top: 90 });

    if (config.main_job && jobIconMap[config.main_job]) {
        try {
            const mainJobUrl = jobIconMap[config.main_job];
            const mainJobBuffer = await processDynamicAsset(mainJobUrl, Math.round(336 * 1.3), 64);
            if (mainJobBuffer) {
                backgroundAssets.push({ input: mainJobBuffer, left: 600, top: 345 });
            }
        } catch (e) {
            console.error('Failed to load main job icon asset:', e.message);
        }
    }

    let jobLevelsSvg = '';
    if (data.jobLevels && data.jobLevels.length > 0) {
        const startX = 466;
        const startY = 418;
        const iconSpacingX = 33;

        const rowLayouts = [
            { count: 8, startIdx: 0, yOffset: 38 },
            { count: 10, startIdx: 8, yOffset: 90.5 },
            { count: 5, startIdx: 18, yOffset: 143 },
            { count: 8, startIdx: 23, yOffset: 195.5 },
            { count: 3, startIdx: 31, yOffset: 248 }
        ];

        rowLayouts.forEach(row => {
            for (let i = 0; i < row.count; i++) {
                const dataIndex = row.startIdx + i;
                if (dataIndex < data.jobLevels.length) {
                    const xPos = startX + (i * iconSpacingX) + 12;
                    const yPos = startY + row.yOffset;
                    const levelVal = data.jobLevels[dataIndex];
                    jobLevelsSvg += `<text x="${Math.round(xPos + 1)}" y="${Math.round(yPos + 1)}" class="job-level-shadow">${escapeXml(levelVal)}</text>\n`;
                    jobLevelsSvg += `<text x="${Math.round(xPos)}" y="${Math.round(yPos)}" class="job-level">${escapeXml(levelVal)}</text>\n`;
                }
            }
        });
    }

    const panelsSvg = `
    <svg width="${width}" height="${height}">
        <defs>
            <filter id="panelShadow" x="-10%" y="-10%" width="130%" height="130%">
                <feDropShadow dx="4" dy="6" stdDeviation="5" flood-color="#000000" flood-opacity="0.65" />
            </filter>
        </defs>
        <style>
            .panel { fill: rgba(255, 255, 255, 0.08); stroke: rgba(255, 255, 255, 0.15); stroke-width: 1px; rx: 6px; filter: url(#panelShadow); }
        </style>
        <rect x="440" y="20" width="635" height="110" class="panel" />
        <rect x="440" y="140" width="635" height="210" class="panel" />
        <rect x="440" y="360" width="635" height="320" class="panel" />
    </svg>
    `;

    const textSvg = `
    <svg width="${width}" height="${height}">
        <style>
            .header-title { font-family: sans-serif; font-size: 14px; fill: #cbd5e0; text-anchor: middle; letter-spacing: 1px; }
            .header-title-shd { font-family: sans-serif; font-size: 14px; fill: #000000; text-anchor: middle; letter-spacing: 1px; }

            .header-name { font-family: sans-serif; font-weight: bold; font-size: 28px; fill: #ffffff; text-anchor: middle; }
            .header-name-shd { font-family: sans-serif; font-weight: bold; font-size: 28px; fill: #000000; text-anchor: middle; }

            .header-server { font-family: sans-serif; font-size: 14px; fill: #a0aec0; text-anchor: middle; }
            .header-server-shd { font-family: sans-serif; font-size: 14px; fill: #000000; text-anchor: middle; }

            .label { font-family: sans-serif; font-size: 11px; fill: #94a3b8; font-weight: bold; }
            .label-shd { font-family: sans-serif; font-size: 11px; fill: #000000; font-weight: bold; }

            .value { font-family: sans-serif; font-size: 13px; fill: #ffffff; font-weight: bold; }
            .value-shd { font-family: sans-serif; font-size: 13px; fill: #000000; font-weight: bold; }

            .section-title { font-family: sans-serif; font-size: 13px; fill: #cbd5e0; font-weight: bold; letter-spacing: 1px; }
            .section-title-shd { font-family: sans-serif; font-size: 13px; fill: #000000; font-weight: bold; letter-spacing: 1px; }

            .job-level { font-family: sans-serif; font-size: 11px; fill: #ffffff; text-anchor: middle; font-weight: bold; }
            .job-level-shadow { font-family: sans-serif; font-size: 11px; fill: #000000; text-anchor: middle; font-weight: bold; }

            .legal-text { font-family: sans-serif; font-size: 9px; fill: #ffffff; fill-opacity: 0.5; text-anchor: middle; }
        </style>
        
        <text x="758" y="49" class="header-title-shd">${escapeXml(data.title)}</text>
        <text x="757" y="48" class="header-title">${escapeXml(data.title)}</text>

        <text x="758" y="83" class="header-name-shd">${escapeXml(data.name)}</text>
        <text x="757" y="82" class="header-name">${escapeXml(data.name)}</text>

        <text x="758" y="109" class="header-server-shd">${escapeXml(data.world)} ${data.datacenter ? `[${escapeXml(data.datacenter)}]` : ''}</text>
        <text x="757" y="108" class="header-server">${escapeXml(data.world)} ${data.datacenter ? `[${escapeXml(data.datacenter)}]` : ''}</text>

        <text x="466" y="171" class="label-shd">Race :</text>
        <text x="465" y="170" class="label">Race :</text>
        <text x="596" y="171" class="value-shd">${escapeXml(data.race)}</text>
        <text x="595" y="170" class="value">${escapeXml(data.race)}</text>

        <text x="466" y="197" class="label-shd">Clan / Gender :</text>
        <text x="465" y="196" class="label">Clan / Gender :</text>
        <text x="596" y="197" class="value-shd">${escapeXml(data.clanGender)}</text>
        <text x="595" y="196" class="value">${escapeXml(data.clanGender)}</text>

        <text x="466" y="223" class="label-shd">Birthday :</text>
        <text x="465" y="222" class="label">Birthday :</text>
        <text x="596" y="223" class="value-shd">${escapeXml(data.birthday)}</text>
        <text x="595" y="222" class="value">${escapeXml(data.birthday)}</text>

        <text x="466" y="249" class="label-shd">Guardian :</text>
        <text x="465" y="248" class="label">Guardian :</text>
        <text x="596" y="249" class="value-shd">${escapeXml(data.guardian)}</text>
        <text x="595" y="248" class="value">${escapeXml(data.guardian)}</text>

        <text x="466" y="275" class="label-shd">City-State :</text>
        <text x="465" y="274" class="label">City-State :</text>
        <text x="596" y="275" class="value-shd">${escapeXml(data.cityState)}</text>
        <text x="595" y="274" class="value">${escapeXml(data.cityState)}</text>

        <text x="466" y="301" class="label-shd">Grand Company :</text>
        <text x="465" y="300" class="label">Grand Company :</text>
        <text x="596" y="301" class="value-shd">${escapeXml(data.grandCompany)}</text>
        <text x="595" y="300" class="value">${escapeXml(data.grandCompany)}</text>

        <text x="466" y="327" class="label-shd">Free Company :</text>
        <text x="465" y="326" class="label">Free Company :</text>
        <text x="596" y="327" class="value-shd">${escapeXml(data.freeCompany)}</text>
        <text x="595" y="326" class="value">${escapeXml(data.freeCompany)}</text>

        <text x="466" y="391" class="section-title-shd">Jobs / Classes :</text>
        <text x="465" y="390" class="section-title">Jobs / Classes :</text>
        ${jobLevelsSvg}
    </svg>
    `;

    finalLayers.push({ input: Buffer.from(panelsSvg), left: 0, top: 0 });
    finalLayers.push(...backgroundAssets);

    if (jobsImgBuffer) {
        finalLayers.push({ input: jobsImgBuffer, left: 455, top: 410 });
    }

    finalLayers.push({ input: Buffer.from(textSvg), left: 0, top: 0 });

    if (qrCodeBuffer) {
        finalLayers.push({ input: qrCodeBuffer, left: Math.round(915), top: Math.round(177) });
    }

    // Determine presence of Tomestone and FFLogs
    const hasTomestone = config.tomestone_url && config.tomestone_url.trim() !== '';
    const hasFFLogs = config.fflogs_url && config.fflogs_url.trim() !== '';

    const qrWidth = 83;
    const badgeWidth = 110;
    const spacing = 20;
    const rightMargin = 30;

    let activeItemsCount = (hasTomestone ? 1 : 0) + (hasFFLogs ? 1 : 0);
    if (activeItemsCount > 0) {
        const totalGroupWidth = (activeItemsCount * qrWidth) + ((activeItemsCount - 1) * spacing);
        let groupStartX = width - rightMargin - totalGroupWidth;

        const qrY = 580;
        const badgeY = 515;
        let currentIndex = 0;

        const badgeXOffset = (badgeWidth - qrWidth) / 2;

        if (hasTomestone) {
            const itemBaseX = groupStartX + (currentIndex * (qrWidth + spacing));
            if (tomestoneQrBuffer) {
                foregroundAssets.push({ input: tomestoneQrBuffer, left: Math.round(itemBaseX), top: Math.round(qrY) });
            }
            if (tomestoneBadgeBuffer) {
                foregroundAssets.push({ input: tomestoneBadgeBuffer, left: Math.round(itemBaseX - badgeXOffset), top: Math.round(badgeY) });
            }
            currentIndex++;
        }

        if (hasFFLogs) {
            const itemBaseX = groupStartX + (currentIndex * (qrWidth + spacing));
            if (fflogsQrBuffer) {
                foregroundAssets.push({ input: fflogsQrBuffer, left: Math.round(itemBaseX), top: Math.round(qrY) });
            }
            if (fflogsBadgeBuffer) {
                foregroundAssets.push({ input: fflogsBadgeBuffer, left: Math.round(itemBaseX - badgeXOffset), top: Math.round(badgeY) });
            }
            currentIndex++;
        }
    }

    // FFXIV Collect stats row (verified Main only, switches on the website): right of the gatherer icons, left of the QR codes
    if (Array.isArray(config.collectStats) && config.collectStats.length) {
        const statsLayout = cardStats.layout(config.collectStats, { hasTomestone, hasFFLogs });
        if (statsLayout.boxes.length) foregroundAssets.push({ input: Buffer.from(cardStats.svg(statsLayout, width, height)), left: 0, top: 0 });
    }

    if (bannerIconBuffer) {
        foregroundAssets.push({ input: bannerIconBuffer, left: 460, top: 25 });
    }

    if (classIconBuffer) {
        foregroundAssets.push({ input: classIconBuffer, left: 458, top: 53 });
    }

    // FFXIV Logo and Legal Copyright text centered in the portrait bottom area (portrait width is 420px, so center is x: 210)
    try {
        const logoRes = await axios.get('https://raw.githubusercontent.com/rkyle27/pingway/refs/heads/main/misc/logo_ffxiv.png', { responseType: 'arraybuffer', timeout: 8000 });
        const logoBuffer = await sharp(Buffer.from(logoRes.data))
            .resize(160, null, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .ensureAlpha()
            .linear(1, 0)
            .composite([{ input: Buffer.from([255, 255, 255, 127]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
            .toBuffer();

        const logoMeta = await sharp(logoBuffer).metadata();
        const logoLeft = Math.round(210 - (logoMeta.width / 2));
        const logoTop = 600; // bottom area of the 700px high portrait

        foregroundAssets.push({ input: logoBuffer, left: logoLeft, top: logoTop });
    } catch (e) {
        console.error('Failed to load logo_ffxiv.png:', e.message);
    }

    const legalTextSvg = `
    <svg width="420" height="40">
        <style>
            .legal { font-family: sans-serif; font-size: 7.5px; fill: #ffffff; fill-opacity: 0.5; text-anchor: middle; }
        </style>
        <text x="210" y="12" class="legal">FINAL FANTASY XIV © SQUARE ENIX CO., LTD.</text>
        <text x="210" y="24" class="legal">All Rights Reserved. FINAL FANTASY is a</text>
        <text x="210" y="36" class="legal">registered trademark of Square Enix Holdings Co., Ltd.</text>
    </svg>
    `;
    foregroundAssets.push({ input: Buffer.from(legalTextSvg), left: 0, top: 650 });

    finalLayers.push(...foregroundAssets);

    // Top left corner decoration asset scaled to 1/4 size, 50% transparent, exactly 20px from top and left edge, absolute top layer
    try {
        const cornerRes = await axios.get('https://raw.githubusercontent.com/rkyle27/pingway/refs/heads/main/misc/d7xn4e7-531cd7bf-e2e4-40f2-88e7-ba524acd0803.png', { responseType: 'arraybuffer', timeout: 8000 });
        const originalCornerMeta = await sharp(Buffer.from(cornerRes.data)).metadata();
        const quarterWidth = Math.round(originalCornerMeta.width / 4);
        const quarterHeight = Math.round(originalCornerMeta.height / 4);

        const cornerBuffer = await sharp(Buffer.from(cornerRes.data))
            .resize(quarterWidth, quarterHeight)
            .ensureAlpha()
            .linear(1, 0)
            .composite([{ input: Buffer.from([255, 255, 255, 127]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
            .toBuffer();
        finalLayers.push({ input: cornerBuffer, left: 20, top: 20 });
    } catch (e) {
        console.error('Failed to load top-left corner asset:', e.message);
    }

    const cardBuffer = await sharp({
        create: {
            width: width,
            height: height,
            channels: 4,
            background: { r: 6, g: 12, b: 24, alpha: 1 }
        }
    })
        .composite(finalLayers)
        .png()
        .toBuffer();

    // Apply rounded corners mask mimicking a real-world card
    const roundedCornerMask = Buffer.from(
        `<svg width="${width}" height="${height}">
            <rect x="0" y="0" width="${width}" height="${height}" rx="24" ry="24" fill="#ffffff" />
        </svg>`
    );

    return await sharp(cardBuffer)
        .composite([{ input: roundedCornerMask, blend: 'dest-in' }])
        .png()
        .toBuffer();
}

// FFXIV Collect stats for the card (the stats switched on for this character); none when the character is not on
// FFXIV Collect, private, or the site is down with nothing saved
async function collectStatsFor(userId, lodestoneId) {
    try {
        const toggles = await ffxivCollect.readStatToggles(pool, userId, lodestoneId);
        if (!Object.values(toggles).some(Boolean)) return null;
        const r = await ffxivCollect.getCharacter(pool, lodestoneId);
        return r && r.data ? cardStats.itemsFor(r.data, toggles) : null;
    } catch (e) {
        console.error('FFXIV Collect stats for the IGN card failed:', e.message);
        return null;
    }
}

function escapeXml(str) {
    if (!str) return '';
    return String(str).replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

module.exports = {
    generateCard, collectStatsFor,
    data: new SlashCommandBuilder()
        .setName('ign')
        .setDescription(t('en', 'ign.cmd.description')).setDescriptionLocalizations(discordLocalizations('ign.cmd.description')),

    async execute(interaction) {
        const lang = await userLanguage.forInteraction(interaction);
        const userId = interaction.user.id;
        const [rows] = await pool.execute('SELECT * FROM user_ign_config WHERE user_id = ?', [userId]);

        if (rows.length === 0 || !rows[0].lodestone_id) {
            return interaction.reply({
                content: t(lang, 'ign.notConfigured'),
                flags: [MessageFlags.Ephemeral]
            });
        }

        // Only a verified (claimed) Main is shown; older not verified cards need ✅ Verify first
        const main = await ffxivCollect.verifiedMain(pool, userId);
        if (!main || String(main.lodestone_id) !== String(rows[0].lodestone_id)) {
            return interaction.reply({ content: t(lang, 'ign.needVerified'), flags: [MessageFlags.Ephemeral] });
        }

        await interaction.deferReply();

        // v2.2: user_ign_config is the Main character; Tomestone / FFLogs / custom image can be switched off on the website
        const config = ignClaims.cardConfig(rows[0]);
        config.collectStats = await collectStatsFor(userId, main.lodestone_id);
        const data = await fetchLodestoneData(config.lodestone_id);

        if (!data.success) {
            return interaction.editReply({ content: t(lang, 'ign.fetchFailed') });
        }

        const cardBuffer = await generateCard(config, data);
        if (!cardBuffer) {
            return interaction.editReply({ content: t(lang, 'ign.cardFailed') });
        }

        const attachment = new AttachmentBuilder(cardBuffer, { name: 'character_card.png' });
        return interaction.editReply({ files: [attachment] });
    }
};