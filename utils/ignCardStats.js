// IGN card: the small FFXIV Collect stats row (icon + count) in the Jobs panel, right of the last (gatherer) icon row and
// left of the Tomestone / FFLogs QR codes. Two lines at most, never on top of a job icon / level or a QR code
// (bounding boxes below use the same numbers as commands/ign.js generateCard). "Data by FFXIV Collect" under it.
'use strict';

const CARD_W = 1100;
// Jobs panel (ign.js: <rect x="440" y="360" width="635" height="320">)
const PANEL = { x0: 440, y0: 360, x1: 1075, y1: 680 };

// Job icon rows: JOBS.png at 70 % placed at (455, 410); level numbers under each icon (ign.js rowLayouts)
const JOB_ROWS = [
    { count: 8, top: 10, yOffset: 38 }, { count: 10, top: 85, yOffset: 90.5 }, { count: 5, top: 160, yOffset: 143 },
    { count: 8, top: 235, yOffset: 195.5 }, { count: 3, top: 310, yOffset: 248 }
];
function jobBoxes() {
    return JOB_ROWS.map(r => ({
        name: 'jobs-row', x0: 455 + 0.7 * 18, y0: 410 + 0.7 * r.top,
        x1: Math.max(455 + 0.7 * (18 + 47 * (r.count - 1) + 36), 466 + 33 * (r.count - 1) + 12 + 12),
        y1: 418 + r.yOffset + 3
    }));
}

// Tomestone / FFLogs: QR 83x83 at y 580, badge 110x60 at y 515, right aligned (ign.js)
function qrBoxes(hasTomestone, hasFFLogs) {
    const n = (hasTomestone ? 1 : 0) + (hasFFLogs ? 1 : 0);
    const out = [];
    if (!n) return out;
    const qr = 83, badge = 110, spacing = 20, right = 30;
    const start = CARD_W - right - (n * qr + (n - 1) * spacing);
    for (let i = 0; i < n; i++) {
        const x = start + i * (qr + spacing);
        out.push({ name: 'qr', x0: x, y0: 580, x1: x + qr, y1: 580 + qr });
        out.push({ name: 'badge', x0: x - (badge - qr) / 2, y0: 515, x1: x - (badge - qr) / 2 + badge, y1: 515 + 60 });
    }
    return out;
}

// The stats area: right of the gatherer row, under the crafter row, left of the QR codes
const AREA = { x0: 572, firstBaseline: 635, lineHeight: 20, maxLines: 2, gapRight: 10 };
const ICON = 16, ICON_GAP = 4, ITEM_GAP = 12, FONT = 12;
// sans-serif bold 12 px, a little wider than real so the estimate never undercounts
const charW = ch => (/[0-9]/.test(ch) ? 7.2 : /[,./ ]/.test(ch) ? 3.8 : /[A-Z]/.test(ch) ? 8.8 : 7.4);
const textWidth = s => Math.ceil([...String(s)].reduce((w, ch) => w + charW(ch), 0));

function areaRight(hasTomestone, hasFFLogs) {
    const q = qrBoxes(hasTomestone, hasFFLogs).filter(b => b.name === 'qr');
    return q.length ? Math.min(...q.map(b => b.x0)) - AREA.gapRight : PANEL.x1 - 15;
}

/**
 * items: [{ key, text }] (key = mounts / minions / achievements / orchestrions / cards)
 * -> { boxes: [{ key, text, x0, y0, x1, y1, iconX, iconY, textX, baseline }], credit: { x, baseline, x1, y0, y1 }, dropped: [keys] }
 */
function layout(items, opts) {
    const o = opts || {};
    const right = areaRight(!!o.hasTomestone, !!o.hasFFLogs);
    const boxes = [];
    const dropped = [];
    let line = 0, x = AREA.x0;
    for (const it of items) {
        const w = ICON + ICON_GAP + textWidth(it.text);
        if (x + w > right && x > AREA.x0) { line++; x = AREA.x0; }
        if (line >= AREA.maxLines || x + w > right) { dropped.push(it.key); continue; }
        const baseline = AREA.firstBaseline + line * AREA.lineHeight;
        boxes.push({ key: it.key, text: it.text, x0: x, y0: baseline - 14, x1: x + w, y1: baseline + 4, iconX: x, iconY: baseline - 13, textX: x + ICON + ICON_GAP, baseline });
        x += w + ITEM_GAP;
    }
    const lines = boxes.length ? Math.max(...boxes.map(b => (b.baseline - AREA.firstBaseline) / AREA.lineHeight)) + 1 : 0;
    const creditBase = AREA.firstBaseline + Math.max(lines, 1) * AREA.lineHeight - 6;
    const credit = boxes.length ? { x: AREA.x0, baseline: creditBase, x0: AREA.x0, x1: AREA.x0 + 105, y0: creditBase - 8, y1: creditBase + 2 } : null;
    return { boxes, credit, dropped, right };
}

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

// Small badge icons (16 x 16), the same rounded-square look as the job icons
const COLORS = { mounts: '#b7832f', minions: '#3d8b57', achievements: '#3b6cc0', orchestrions: '#7651ad', cards: '#ad4444' };
const GLYPHS = {
    mounts: '<path d="M5 3.5v4.5a3 3 0 0 0 6 0V3.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
    minions: '<circle cx="8" cy="10" r="2.7" fill="#fff"/><circle cx="4.6" cy="6.6" r="1.3" fill="#fff"/><circle cx="8" cy="4.9" r="1.3" fill="#fff"/><circle cx="11.4" cy="6.6" r="1.3" fill="#fff"/>',
    achievements: '<path d="M4.8 3h6.4v3.2a3.2 3.2 0 0 1-6.4 0z" fill="#fff"/><rect x="7.2" y="9" width="1.6" height="2.4" fill="#fff"/><rect x="5.3" y="11.4" width="5.4" height="1.7" rx="0.5" fill="#fff"/>',
    orchestrions: '<circle cx="6.2" cy="11.4" r="2" fill="#fff"/><rect x="7.4" y="3.4" width="1.4" height="8" fill="#fff"/><path d="M8.6 3.6c2.4.6 3.4 1.8 3.2 3.8" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>',
    cards: '<rect x="3.2" y="4.6" width="6" height="8.2" rx="1" fill="#fff" fill-opacity="0.55"/><rect x="6.8" y="3.2" width="6" height="8.2" rx="1" fill="#fff"/>'
};
const esc = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function svg(l, width, height) {
    let body = '';
    for (const b of l.boxes) {
        body += `<g transform="translate(${b.iconX},${b.iconY})"><rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="${COLORS[b.key] || '#555'}" stroke="#ffffff" stroke-opacity="0.35"/>${GLYPHS[b.key] || ''}</g>`;
        body += `<text x="${b.textX + 1}" y="${b.baseline + 1}" class="cs-shd">${esc(b.text)}</text><text x="${b.textX}" y="${b.baseline}" class="cs">${esc(b.text)}</text>`;
    }
    if (l.credit) body += `<text x="${l.credit.x}" y="${l.credit.baseline}" class="cs-credit">Data by FFXIV Collect</text>`;
    return `<svg width="${width || CARD_W}" height="${height || 700}" xmlns="http://www.w3.org/2000/svg"><style>
        .cs { font-family: sans-serif; font-size: ${FONT}px; font-weight: bold; fill: #ffffff; }
        .cs-shd { font-family: sans-serif; font-size: ${FONT}px; font-weight: bold; fill: #000000; }
        .cs-credit { font-family: sans-serif; font-size: 8px; fill: #ffffff; fill-opacity: 0.55; }
    </style>${body}</svg>`;
}

const num = n => Number(n || 0).toLocaleString('en-US');
/** Card stat items from FFXIV Collect data + the character's switches (order = CARD_STATS) */
function itemsFor(data, toggles) {
    const fc = require('./ffxivCollect');
    const out = [];
    for (const key of fc.CARD_STATS) {
        if (!toggles || !toggles[key]) continue;
        const v = fc.statValue(data, key);
        if (key === 'achievements') {
            // achievements hidden on the Lodestone: points are 0 -> the stat is left out
            if (!v || !v.value) continue;
            out.push({ key, text: num(v.value) + ' pts' });
        } else {
            if (!v || !v.total) continue;
            out.push({ key, text: num(v.value) + '/' + num(v.total) });
        }
    }
    return out;
}

module.exports = { PANEL, AREA, jobBoxes, qrBoxes, layout, overlaps, svg, itemsFor, textWidth, areaRight };
