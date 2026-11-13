// utils/safeImage.js: user image links (IGN card) - https only, size cap, PNG/JPEG/WebP/GIF by magic bytes only.
// No real network: axios is stubbed. Run: node --test test/safe-image.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const safeImage = require('../utils/safeImage');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
const HEIF = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
const RANDOM = Buffer.from('this is not an image at all, nope');

function stub(data) {
    const calls = [];
    return { calls, get: async (url, opts) => { calls.push({ url, opts }); return { data }; } };
}

test('only https links are accepted', async () => {
    assert.equal(safeImage.isHttpsUrl('https://example.com/a.png'), true);
    for (const bad of ['http://example.com/a.png', 'file:///etc/passwd', 'ftp://x/y.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'not a url', '']) {
        assert.equal(safeImage.isHttpsUrl(bad), false, bad);
        const http = stub(PNG);
        await assert.rejects(safeImage.fetchUserImage(bad, { http }), /https/);
        assert.equal(http.calls.length, 0, 'no download for ' + bad);
    }
});

test('download options: arraybuffer, 8 s timeout, 8 MB caps, 3 redirects', async () => {
    const http = stub(PNG);
    await safeImage.fetchUserImage('https://example.com/a.png', { http });
    const o = http.calls[0].opts;
    assert.equal(o.responseType, 'arraybuffer');
    assert.equal(o.timeout, 8000);
    assert.equal(o.maxContentLength, 8 * 1024 * 1024);
    assert.equal(o.maxBodyLength, 8 * 1024 * 1024);
    assert.equal(o.maxRedirects, 3);
});

test('PNG / JPEG / WebP / GIF accepted by magic bytes', async () => {
    for (const [name, buf] of [['png', PNG], ['jpeg', JPEG], ['webp', WEBP], ['gif', GIF]]) {
        assert.equal(safeImage.sniffImageType(buf), name);
        const out = await safeImage.fetchUserImage('https://example.com/x', { http: stub(buf) });
        assert.ok(Buffer.isBuffer(out));
        assert.deepEqual(out, buf);
    }
});

test('SVG / HEIF / random bytes rejected (even if named .png)', async () => {
    for (const buf of [SVG, HEIF, RANDOM, Buffer.alloc(0)]) {
        assert.equal(safeImage.sniffImageType(buf), null);
        await assert.rejects(safeImage.fetchUserImage('https://example.com/fake.png', { http: stub(buf) }), /unsupported/);
    }
});

test('oversize download rejected', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(safeImage.MAX_BYTES)]);
    await assert.rejects(safeImage.fetchUserImage('https://example.com/big.png', { http: stub(big) }), /too large/);
    // axios' own maxContentLength error is passed through to the caller's catch
    const http = { get: async () => { throw new Error('maxContentLength size of 8388608 exceeded'); } };
    await assert.rejects(safeImage.fetchUserImage('https://example.com/big.png', { http }), /maxContentLength/);
});

test('sharp pixel limit option for user images', () => {
    assert.deepEqual(safeImage.SHARP_INPUT_OPTIONS, { limitInputPixels: 4096 * 4096 });
});

test('blockUnsafeDecoders: blocks HEIF only, never crashes', () => {
    const calls = [];
    assert.equal(safeImage.blockUnsafeDecoders({ block: o => calls.push(o) }), true);
    assert.deepEqual(calls, [{ operation: ['VipsForeignLoadHeif'] }]);
    assert.equal(safeImage.blockUnsafeDecoders(null), false);
    assert.equal(safeImage.blockUnsafeDecoders({}), false);
    assert.equal(safeImage.blockUnsafeDecoders({ block: () => { throw new Error('x'); } }), false);
});

test('real sharp: HEIF loader blocked, own SVG card layers still work', async (t) => {
    let sharp;
    try { sharp = require('sharp'); } catch (e) { return t.skip('sharp not installed'); }
    safeImage.blockUnsafeDecoders(sharp);
    const blocked = sharp.block && sharp.format.heif ? true : false;
    if (!blocked) return t.skip('this sharp has no block/heif');
    // the IGN card composites its own SVG text/panels, so SVG must keep working
    const svg = Buffer.from('<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const png = await sharp(svg).png().toBuffer();
    assert.equal(safeImage.sniffImageType(png), 'png');
    // a HEIF-branded buffer must not decode
    await assert.rejects(sharp(HEIF).metadata());
});
