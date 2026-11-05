'use strict';
// Pingway welcome card renderer.
// Draws a pre-baked card background (assets/welcome/bg/<id>.png, 1120x520) and puts the
// member's avatar, name, welcome message and member number on it with node-canvas.
// Layout of the dynamic parts comes from assets/welcome/layout.json (made by build/bake.js).

const fs = require('fs');
const path = require('path');

let Canvas;
let LIB;
try { Canvas = require('canvas'); LIB = 'canvas'; } catch (e) {
  Canvas = require('@napi-rs/canvas'); LIB = 'napi'; // dev/test fallback only
}
let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache(false); // no libvips operation cache: keeps RSS low on a 512 MB host
  sharp.concurrency(1);
} catch (e) { /* optional: used to decode webp/gif avatars */ }

const ASSET_DIR = path.join(__dirname, '..', 'assets', 'welcome');
const BG_DIR = path.join(ASSET_DIR, 'bg');
const FONT_DIR = path.join(ASSET_DIR, 'fonts');
const SCALE = 2;
const W = 560, H = 260; // CSS px; output is 1120x520
const BG_CACHE_MAX = 8;
// glyphs missing from a design font (Japanese, emoji, ...) come from these, in order;
// fonts.json entries with "fallback" are added in front at load time
const FALLBACK_FAMILIES = ['Welcome Fallback JP', 'Welcome Fallback Emoji'];

const DEFAULT_POOL = Array.from({ length: 20 }, (_, i) => 'pw' + String(i + 1).padStart(2, '0'));
const CUSTOM_DESIGNS = ['c20', 'c22', 'c28', 'c30', 'c31', 'c36', 'c37', 'c39', 'c41', 'c42', 'c50', 'f2', 'w3', 'e4', 'a1', 'i1', 'l5', 's3', 'k1', 'k2', 'k4', 'k5'];
const ALL_DESIGNS = DEFAULT_POOL.concat(CUSTOM_DESIGNS);

let layout = null;
let fontsReady = false;
const bgCache = new Map(); // id -> Image (LRU by insertion order)

function randomDefault() {
  return DEFAULT_POOL[Math.floor(Math.random() * DEFAULT_POOL.length)];
}

function loadLayout() {
  if (layout) return layout;
  layout = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'layout.json'), 'utf8'));
  // use the exact font face the reference was rendered with (see build/bake.js usedFace)
  for (const d of Object.values(layout)) for (const k of ['name', 'message', 'count']) {
    const t = d[k];
    if (!t || !t.face) continue;
    Object.assign(t.font, { family: t.face.family, weight: t.face.weight, style: t.face.italic ? 'italic' : 'normal', synthBold: t.face.synthBold, synthItalic: t.face.synthItalic });
  }
  return layout;
}

function registerFonts() {
  if (fontsReady) return;
  fontsReady = true;
  const list = [];
  try { list.push(...JSON.parse(fs.readFileSync(path.join(FONT_DIR, 'fonts.json'), 'utf8'))); } catch (e) { /* none */ }
  // fallbacks for glyphs the design fonts don't have (Japanese, emoji, ...)
  const fb = { 'fallback-jp': FALLBACK_FAMILIES[0], 'fallback-emoji': FALLBACK_FAMILIES[1] };
  try {
    for (const f of fs.readdirSync(FONT_DIR)) {
      const m = f.match(/^(fallback-[a-z]+)(?:-(\d+))?\.(ttf|otf)$/i);
      if (m && fb[m[1]]) list.push({ family: fb[m[1]], weight: Number(m[2] || 400), style: 'normal', file: f });
    }
  } catch (e) { /* no font dir */ }
  for (const f of list) if (f.fallback && !FALLBACK_FAMILIES.includes(f.family)) FALLBACK_FAMILIES.unshift(f.family);
  for (const f of list) {
    const file = path.join(FONT_DIR, f.file);
    if (!fs.existsSync(file)) continue;
    try {
      if (LIB === 'canvas') Canvas.registerFont(file, { family: f.family, weight: String(f.weight), style: f.style });
      else Canvas.GlobalFonts.registerFromPath(file, f.family);
    } catch (e) { console.warn('[welcomeCards] font failed:', f.file, e.message); }
  }
}

async function getBackground(id) {
  if (bgCache.has(id)) {
    const img = bgCache.get(id);
    bgCache.delete(id); bgCache.set(id, img); // mark as recently used
    return img;
  }
  const img = await Canvas.loadImage(await fs.promises.readFile(path.join(BG_DIR, id + '.png')));
  bgCache.set(id, img);
  while (bgCache.size > BG_CACHE_MAX) bgCache.delete(bgCache.keys().next().value);
  return img;
}

// ---------- text helpers ----------
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function graphemes(s) {
  return segmenter ? Array.from(segmenter.segment(s), x => x.segment) : Array.from(s);
}
function clean(s, oneLine) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B\u2028\u2029]/g, oneLine ? ' ' : '');
  if (oneLine) s = s.replace(/\s+/g, ' ');
  return s.trim();
}
function applyCase(s, c) {
  if (c === 'upper') return s.toUpperCase();
  if (c === 'lower') return s.toLowerCase();
  if (c === 'lower_underscore') return s.toLowerCase().replace(/\s+/g, '_');
  return s;
}
function cssTransform(s, t) {
  if (t === 'uppercase') return s.toUpperCase();
  if (t === 'lowercase') return s.toLowerCase();
  if (t === 'capitalize') return s.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
  return s;
}
function fontString(f, size) {
  setSynth(f, size);
  const fam = ['"' + f.family + '"'].concat(FALLBACK_FAMILIES.map(x => '"' + x + '"'), ['sans-serif']).join(', ');
  return (f.style === 'italic' ? 'italic ' : '') + f.weight + ' ' + size.toFixed(2) + 'px ' + fam;
}
function textWidth(ctx, s, ls) {
  if (!s) return 0;
  if (!ls) return ctx.measureText(s).width;
  let w = 0;
  for (const g of graphemes(s)) w += ctx.measureText(g).width + ls;
  return w;
}
let synth = null; // { bold: px stroke width, italic: bool } for the font currently drawn
function fillOne(ctx, s, x, y) {
  if (synth && synth.italic) { ctx.save(); ctx.translate(x, y); ctx.transform(1, 0, -0.2, 1, 0, 0); x = 0; y = 0; }
  ctx.fillText(s, x, y);
  if (synth && synth.bold) { ctx.save(); ctx.lineWidth = synth.bold; ctx.strokeStyle = ctx.fillStyle; ctx.lineJoin = 'round'; ctx.strokeText(s, x, y); ctx.restore(); }
  if (synth && synth.italic) ctx.restore();
}
function drawRun(ctx, s, x, y, ls) {
  if (!ls) { fillOne(ctx, s, x, y); return; }
  for (const g of graphemes(s)) { fillOne(ctx, g, x, y); x += ctx.measureText(g).width + ls; }
}
function setSynth(f, size) {
  // like Chromium/Skia fake bold (outline grows ~1/24..1/32 of the size) and fake italic (skew)
  const k = size <= 9 ? 1 / 24 : size >= 36 ? 1 / 32 : 1 / 24 + (1 / 32 - 1 / 24) * (size - 9) / 27;
  synth = f.synthBold || f.synthItalic ? { bold: f.synthBold ? size * k : 0, italic: !!f.synthItalic } : null;
}
// Draw one line with the block's effects (text-shadow list, stroke) at baseline y.
function drawLine(ctx, spec, s, x, y, ls, scaleK) {
  const w = textWidth(ctx, s, ls);
  let left = x;
  if (spec.align === 'center') left = x + (spec.w - w) / 2;
  else if (spec.align === 'right') left = x + spec.w - w;
  const shadows = (spec.shadows || []).slice().reverse(); // CSS paints the first shadow on top
  for (const sh of shadows) {
    ctx.save();
    if (!sh.blur) {
      ctx.fillStyle = sh.color;
      drawRun(ctx, s, left + sh.x * scaleK, y + sh.y * scaleK, ls);
    } else {
      // render only the shadow: draw the glyphs far off-canvas and shift the shadow back
      const FAR = 4000;
      ctx.shadowColor = sh.color;
      ctx.shadowBlur = sh.blur * SCALE * scaleK;
      ctx.shadowOffsetX = (FAR + sh.x * scaleK) * SCALE;
      ctx.shadowOffsetY = sh.y * scaleK * SCALE;
      ctx.fillStyle = '#000';
      drawRun(ctx, s, left - FAR, y, ls);
    }
    ctx.restore();
  }
  ctx.fillStyle = spec.color;
  drawRun(ctx, s, left, y, ls);
  if (spec.stroke) {
    ctx.save();
    ctx.lineWidth = spec.stroke.width;
    ctx.strokeStyle = spec.stroke.color;
    ctx.lineJoin = 'round';
    if (!ls) ctx.strokeText(s, left, y);
    else { let xx = left; for (const g of graphemes(s)) { ctx.strokeText(g, xx, y); xx += ctx.measureText(g).width + ls; } }
    ctx.restore();
  }
}
// Cut text to fit maxW, adding "…".
function ellipsize(ctx, s, maxW, ls) {
  if (textWidth(ctx, s, ls) <= maxW) return s;
  const g = graphemes(s);
  let lo = 0, hi = g.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(ctx, g.slice(0, mid).join('').trimEnd() + '…', ls) <= maxW) lo = mid; else hi = mid - 1;
  }
  return g.slice(0, lo).join('').trimEnd() + '…';
}

// Single line (name). Shrinks to 70% then ellipsizes the {name} part of the template.
function drawSingleLine(ctx, spec, rawName, minScale) {
  const f = spec.font;
  const ls = spec.letterSpacing || 0;
  const [pre, post] = (spec.template || '{name}').split('{name}');
  const name = cssTransform(applyCase(rawName, spec.case), spec.transform);
  let k = 1;
  ctx.font = fontString(f, f.size);
  const full = pre + name + (post || '');
  const w0 = textWidth(ctx, full, ls);
  if (w0 > spec.w) k = Math.max(minScale, spec.w / w0 * 0.995);
  ctx.font = fontString(f, f.size * k);
  let text = full;
  if (textWidth(ctx, text, ls * k) > spec.w) {
    const room = spec.w - textWidth(ctx, pre + (post || ''), ls * k);
    text = pre + ellipsize(ctx, name, Math.max(room, 0), ls * k) + (post || '');
  }
  const L = f.lineHeight;
  const baseline = spec.y + L / 2 + (f.baseline - L / 2) * k;
  drawLine(ctx, spec, text, spec.x, baseline, ls * k, k);
}

// Wrap text into lines that fit maxW (words first, long words split by grapheme).
function wrap(ctx, text, maxW, ls) {
  const lines = [];
  for (const para of text.split(/\n/)) {
    const tokens = para.match(/\S+\s*/g) || [''];
    let line = '';
    for (let tok of tokens) {
      if (textWidth(ctx, (line + tok).trimEnd(), ls) <= maxW) { line += tok; continue; }
      if (line) { lines.push(line.trimEnd()); line = ''; }
      if (textWidth(ctx, tok.trimEnd(), ls) <= maxW) { line = tok; continue; }
      // a single token wider than the line (long URL, CJK text): break by grapheme
      for (const g of graphemes(tok)) {
        if (textWidth(ctx, line + g, ls) > maxW && line) { lines.push(line.trimEnd()); line = ''; }
        line += g;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function drawParagraph(ctx, spec, text) {
  const f = spec.font;
  const ls = spec.letterSpacing || 0;
  text = cssTransform(applyCase(text, spec.case), spec.transform);
  ctx.font = fontString(f, f.size);
  const L = f.lineHeight;
  const maxLines = Math.max(1, Math.floor((spec.maxBottom - spec.y + 0.5) / L));
  let lines = wrap(ctx, text, spec.w, ls);
  if (lines.length > maxLines) {
    const rest = lines.slice(maxLines - 1).join(' ');
    lines = lines.slice(0, maxLines - 1);
    lines.push(ellipsize(ctx, rest, spec.w, ls));
  }
  lines.forEach((line, i) => drawLine(ctx, spec, line, spec.x, spec.y + f.baseline + i * L, ls, 1));
}

function drawCount(ctx, spec, count) {
  const f = spec.font;
  const ls = spec.letterSpacing || 0;
  let text = spec.template || '#{count}';
  if (Number.isFinite(count)) text = text.replace('{count}', String(Math.trunc(count)));
  else text = text.replace(/\s*[·•\-|]?\s*#?\{count\}/, '');
  text = cssTransform(text, spec.transform);
  ctx.save();
  ctx.translate(spec.cx, spec.cy);
  ctx.rotate((spec.angle || 0) * Math.PI / 180);
  ctx.font = fontString(f, f.size);
  let k = 1;
  const w0 = textWidth(ctx, text, ls);
  if (w0 > spec.maxLen) { k = spec.maxLen / w0; ctx.font = fontString(f, f.size * k); }
  const w = textWidth(ctx, text, ls * k);
  const L = f.lineHeight;
  const sub = Object.assign({}, spec, { align: 'left', w });
  drawLine(ctx, sub, text, -w / 2, (f.baseline - L / 2) * k, ls * k, k); // CSS box includes the trailing letter-spacing
  ctx.restore();
}

// ---------- avatar ----------
async function decodeAvatar(buf, px) {
  if (!buf || !Buffer.isBuffer(buf) || !buf.length) return null;
  try {
    if (sharp) {
      const png = await sharp(buf, { pages: 1, failOn: 'none', limitInputPixels: 4096 * 4096 })
        .resize(px, px, { fit: 'cover' }).png({ compressionLevel: 0 }).toBuffer();
      return await Canvas.loadImage(png);
    }
    return await Canvas.loadImage(buf);
  } catch (e) {
    return null;
  }
}
function drawCover(ctx, img, x, y, size) {
  const iw = img.width, ih = img.height;
  const s = Math.max(size / iw, size / ih);
  const w = iw * s, h = ih * s;
  ctx.drawImage(img, x + (size - w) / 2, y + (size - h) / 2, w, h);
}
function drawPlaceholder(ctx, a) {
  // same silhouette as the design's placeholder (svg viewBox 0 0 120 120 filling the inner circle)
  const s = (a.r * 2) / 120, ox = a.cx - a.r, oy = a.cy - a.r;
  ctx.fillStyle = a.placeholder && a.placeholder.fill || '#C8C8D0';
  ctx.beginPath();
  ctx.arc(ox + 60 * s, oy + 46 * s, 22 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(ox + 16 * s, oy + 120 * s);
  ctx.bezierCurveTo(ox + 20 * s, oy + 92 * s, ox + 38 * s, oy + 78 * s, ox + 60 * s, oy + 78 * s);
  ctx.bezierCurveTo(ox + 82 * s, oy + 78 * s, ox + 100 * s, oy + 92 * s, ox + 104 * s, oy + 120 * s);
  ctx.closePath();
  ctx.fill();
}

function encodePng(canvas) {
  if (LIB === 'napi') return canvas.encode('png');
  return new Promise((resolve, reject) => canvas.toBuffer((err, buf) => (err ? reject(err) : resolve(buf)), 'image/png', { compressionLevel: 6 }));
}

/**
 * Render a welcome card.
 * @param {{design?:string, avatar?:Buffer|null, name?:string, message?:string, count?:number}} opts
 * @returns {Promise<Buffer>} PNG, 1120x520
 */
async function renderWelcomeCard({ design, avatar = null, name = '', message = '', count } = {}) {
  const L = loadLayout();
  registerFonts();
  const id = ALL_DESIGNS.includes(design) && L[design] ? design : randomDefault();
  const spec = L[id];
  const [bg, avatarImg] = await Promise.all([
    getBackground(id),
    decodeAvatar(avatar, Math.ceil(spec.avatar.r * 2 * SCALE)),
  ]);

  const canvas = Canvas.createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bg, 0, 0, W * SCALE, H * SCALE);
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // avatar, clipped to the circle inside the ring (+0.5px under the ring to avoid a seam)
  const a = spec.avatar;
  ctx.save();
  ctx.beginPath();
  ctx.arc(a.cx, a.cy, a.r + 0.5, 0, Math.PI * 2);
  ctx.clip();
  if (avatarImg) drawCover(ctx, avatarImg, a.cx - a.r - 0.5, a.cy - a.r - 0.5, a.r * 2 + 1);
  else drawPlaceholder(ctx, a);
  ctx.restore();

  // text never leaves the card
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  drawSingleLine(ctx, spec.name, clean(name, true) || 'New member', 0.7);
  if (spec.message) drawParagraph(ctx, spec.message, clean(message, false).slice(0, 300));
  if (spec.count) drawCount(ctx, spec.count, Number(count));
  ctx.restore();

  return encodePng(canvas);
}

// node-canvas only uses fonts registered before the first createCanvas() in the process,
// so register at require time (require this module early in the bot).
registerFonts();

module.exports = { DEFAULT_POOL, CUSTOM_DESIGNS, ALL_DESIGNS, randomDefault, renderWelcomeCard };
