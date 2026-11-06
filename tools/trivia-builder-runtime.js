// Browser side of the Trivia data builder (inlined into misc/trivia-builder.html by tools/build-trivia-builder.js).
// Fetches with the browser's fetch() (polite pacing and retries like the server), builds the bank with the shared code
// in utils/triviaBank.js and gives back the exact text of data/trivia_bank.json and its SHA-256.

const TB = require('./triviaBank');
const W = require('./triviaWords');

const wait = ms => new Promise(res => setTimeout(res, ms));

// A fetch() that the browser blocked (CORS, offline, blocked by an extension) only gives a TypeError, no status
class BlockedError extends Error {}

function makeGetJson(o) {
    const retryMs = o.retryMs === undefined ? 1500 : o.retryMs;
    return async function getJson(url) {
        let lastErr;
        for (let attempt = 0; attempt < 3; attempt++) {
            let timer = null;
            try {
                const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
                if (ctrl) timer = setTimeout(() => ctrl.abort(), 30000);
                let r;
                try {
                    r = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
                } catch (err) {
                    if (err && err.name === 'AbortError') throw new Error('XIVAPI did not answer within 30 s');
                    throw new BlockedError('the browser could not reach XIVAPI (' + (err && err.message ? err.message : err) + ')');
                }
                if (!r.ok) {
                    const e = new Error('XIVAPI answered HTTP ' + r.status);
                    e.status = r.status;
                    throw e;
                }
                return await r.json();
            } catch (err) {
                lastErr = err;
                if (o.onRetry && attempt < 2) o.onRetry(err, attempt + 1, url);
                // Too many requests: wait longer
                await wait((err && err.status === 429 ? 4 : 1) * retryMs * (attempt + 1));
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        throw lastErr;
    };
}

// One small request first, so a blocked browser (CORS) is found before the long download
async function probe(o) {
    const getJson = makeGetJson(Object.assign({}, o, { onRetry: null }));
    try {
        await getJson(TB.XIV + '/sheet/ClassJob?limit=1&fields=Name');
        return { ok: true };
    } catch (err) {
        return { ok: false, blocked: err instanceof BlockedError, message: err.message };
    }
}

// opts: { onProgress, onRetry, warn, strict (default true), pauseMs (150), retryMs (1500), now }
// Returns { text (the file), bytes (Uint8Array), sha256 (hex), summary }
async function build(opts) {
    const o = opts || {};
    const pauseMs = o.pauseMs === undefined ? 150 : o.pauseMs;
    const { bank, complete, failed } = await TB.buildBankData({
        getJson: makeGetJson(o), pause: () => wait(pauseMs), onProgress: o.onProgress, warn: o.warn,
        strict: o.strict !== false, now: o.now
    });
    const text = JSON.stringify(bank);
    const bytes = new TextEncoder().encode(text);
    const summary = {
        format: bank.format, langs: bank.langs, incomplete: !!bank.incomplete, failed, builtAt: bank.builtAt, size: bytes.length,
        difficulties: W.DIFFICULTIES.map(d => ({ key: d.key, name: d.name, emoji: d.emoji, words: bank.pools[d.key].length, complete: complete[d.key] }))
    };
    return { text, bytes, sha256: await sha256Hex(bytes), summary };
}

// SHA-256 (hex) of bytes: the browser's crypto.subtle when it is there, else the small version below
async function sha256Hex(bytes) {
    const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle;
    if (subtle) {
        const h = new Uint8Array(await subtle.digest('SHA-256', bytes));
        return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
    }
    return sha256Plain(bytes);
}
function sha256Plain(bytes) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const len = bytes.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const m = new Uint8Array(total);
    m.set(bytes);
    m[len] = 0x80;
    const bits = len * 8;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(total - 4, bits >>> 0);
    const w = new Uint32Array(64);
    const rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
            const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(x => x.toString(16).padStart(8, '0')).join('');
}

module.exports = { build, probe, sha256Hex, sha256Plain, BANK_FORMAT: TB.BANK_FORMAT, TOTAL_STEPS: TB.TOTAL_STEPS, LANGS: W.LANGS };
