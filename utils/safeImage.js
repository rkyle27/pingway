// Safe download of user-supplied image links (IGN card full photo / portrait).
// Only https links, size-capped, and only PNG / JPEG / WebP / GIF by their real first bytes,
// so a crafted SVG / HEIF / TIFF / PDF never reaches sharp's decoders.
const axios = require('axios');

const MAX_BYTES = 8 * 1024 * 1024;
const SHARP_INPUT_OPTIONS = { limitInputPixels: 4096 * 4096 };

function isHttpsUrl(text) {
    try {
        return new URL(String(text)).protocol === 'https:';
    } catch (e) {
        return false;
    }
}

// Returns 'png' | 'jpeg' | 'webp' | 'gif', or null for anything else.
function sniffImageType(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
        buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'png';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    const gif = buf.toString('latin1', 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
    return null;
}

// Throws on any problem, so callers keep their existing catch/fallback path.
async function fetchUserImage(url, opts = {}) {
    const http = opts.http || axios;
    if (!isHttpsUrl(url)) throw new Error('image link must be https');
    const res = await http.get(String(url), {
        responseType: 'arraybuffer',
        timeout: 8000,
        maxContentLength: MAX_BYTES,
        maxBodyLength: MAX_BYTES,
        maxRedirects: 3
    });
    const buf = Buffer.from(res.data);
    if (buf.length > MAX_BYTES) throw new Error('image too large');
    if (!sniffImageType(buf)) throw new Error('unsupported image type');
    return buf;
}

// sharp security advisory workaround: Pingway never needs HEIF/AVIF input.
// (SVG is NOT blocked here: the block is process-wide and the IGN card draws its own SVG text/panel layers.)
function blockUnsafeDecoders(sharpLib) {
    try {
        if (sharpLib && typeof sharpLib.block === 'function') {
            sharpLib.block({ operation: ['VipsForeignLoadHeif'] });
            return true;
        }
    } catch (e) { /* never crash on load */ }
    return false;
}

module.exports = { fetchUserImage, sniffImageType, isHttpsUrl, blockUnsafeDecoders, MAX_BYTES, SHARP_INPUT_OPTIONS };
