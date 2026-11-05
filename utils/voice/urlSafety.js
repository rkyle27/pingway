// SSRF-safe opening of user-given audio links.
// - only http/https, no credentials in the URL
// - every hostname is resolved and EVERY address must be public (no private / loopback / link-local /
//   multicast / reserved IPv4 or IPv6); the connection is then pinned to the checked address
//   (no second DNS lookup = no DNS-rebinding)
// - redirects are followed by hand (max 3) and each hop is checked again
// - response headers must arrive within 10 s
// - content-type must look like audio; HLS (m3u8) is refused; small .pls/.m3u playlists are opened once
// Node does the fetching and pipes the body into ffmpeg's stdin, so ffmpeg never touches the network.

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const USER_AGENT = 'PingwayBot/1.0';
const MAX_REDIRECTS = 3;
const HEADER_TIMEOUT_MS = 10000;
const STALL_TIMEOUT_MS = 30000;
const MAX_PLAYLIST_BYTES = 64 * 1024;

class UrlRefused extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'UrlRefused';
        this.code = code;
    }
}

// ---------- blocked address ranges ----------
const v4 = new net.BlockList();
for (const [a, p] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) v4.addSubnet(a, p, 'ipv4');

const v6 = new net.BlockList();
for (const [a, p] of [
    ['::', 128], ['::1', 128], ['::', 96] /* IPv4-compatible */, ['64:ff9b::', 96], ['64:ff9b:1::', 48],
    ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
]) v6.addSubnet(a, p, 'ipv6');

function isBlockedIp(ip) {
    let addr = String(ip || '').trim();
    if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
    const zone = addr.indexOf('%');
    if (zone !== -1) return true; // scoped (link-local) addresses
    const fam = net.isIP(addr);
    if (fam === 4) return v4.check(addr, 'ipv4');
    if (fam === 6) {
        const lower = addr.toLowerCase();
        // IPv4-mapped ::ffff:a.b.c.d / ::ffff:7f00:1
        const mapped = lower.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isBlockedIp(mapped[1]);
        const mappedHex = lower.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (mappedHex) {
            const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
            return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
        }
        return v6.check(addr, 'ipv6');
    }
    return true; // not an IP at all
}

// ---------- unsupported services ----------
const UNSUPPORTED = [
    ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['youtube-nocookie.com', 'YouTube'],
    ['spotify.com', 'Spotify'], ['spotify.link', 'Spotify'], ['spoti.fi', 'Spotify'],
    ['soundcloud.com', 'SoundCloud'], ['snd.sc', 'SoundCloud'], ['soundcloud.app.goo.gl', 'SoundCloud']
];

function unsupportedService(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
    for (const [d, label] of UNSUPPORTED) if (h === d || h.endsWith('.' + d)) return label;
    return null;
}

function looksLikeUrl(input) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(input || '').trim());
}

// ---------- URL + DNS check ----------
async function defaultLookup(hostname) {
    return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/**
 * @returns {Promise<{url: URL, address: string, family: number}>}
 */
async function checkUrl(input, { lookup = defaultLookup } = {}) {
    let url;
    try {
        url = new URL(String(input).trim());
    } catch {
        throw new UrlRefused('bad_url', 'That is not a valid link.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UrlRefused('bad_scheme', 'Only http:// and https:// links are supported.');
    }
    if (url.username || url.password) throw new UrlRefused('credentials', 'Links with a user name or password are not supported.');
    const svc = unsupportedService(url.hostname);
    if (svc) throw new UrlRefused('unsupported_service', `${svc} links are not supported. Use a direct audio file link or an internet radio stream.`);

    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host || host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
        throw new UrlRefused('private_address', 'That link points to a private address.');
    }
    let addrs;
    if (net.isIP(host)) {
        addrs = [{ address: host, family: net.isIP(host) }];
    } else {
        try {
            addrs = await lookup(host);
        } catch {
            throw new UrlRefused('dns', 'I could not find that website.');
        }
    }
    if (!Array.isArray(addrs) || addrs.length === 0) throw new UrlRefused('dns', 'I could not find that website.');
    if (addrs.some(a => isBlockedIp(a.address))) throw new UrlRefused('private_address', 'That link points to a private address.');
    return { url, address: addrs[0].address, family: addrs[0].family || net.isIP(addrs[0].address) };
}

// ---------- content types ----------
const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const PLAYLIST_TYPES = ['audio/x-scpls', 'application/pls+xml', 'audio/scpls'];

function classifyContentType(ct, pathname = '') {
    const type = String(ct || '').split(';')[0].trim().toLowerCase();
    const path = String(pathname).toLowerCase();
    if (path.endsWith('.m3u8')) return 'hls';
    if (HLS_TYPES.includes(type)) return path.endsWith('.m3u') ? 'm3u' : 'm3u_or_hls';
    if (PLAYLIST_TYPES.includes(type) || path.endsWith('.pls')) return 'pls';
    if (!type) return 'audio'; // many small radio servers send none
    if (type.startsWith('audio/') || type === 'application/ogg' || type === 'application/octet-stream' || type === 'binary/octet-stream') return 'audio';
    return 'refused';
}

function parsePlaylist(text) {
    const urls = [];
    for (const line of String(text).split(/\r?\n/)) {
        const l = line.trim();
        if (!l || l.startsWith('#') && !l.startsWith('#EXT-X')) continue;
        if (l.startsWith('#EXT-X')) return { hls: true, urls: [] };
        const m = l.match(/^(?:File\d+=)?(https?:\/\/\S+)$/i);
        if (m) urls.push(m[1]);
    }
    return { hls: false, urls };
}

// ---------- the request ----------
function requestOnce(checked, { headers = {}, transport, headerTimeoutMs = HEADER_TIMEOUT_MS } = {}) {
    const { url, address, family } = checked;
    const mod = transport || (url.protocol === 'https:' ? https : http);
    return new Promise((resolve, reject) => {
        let done = false;
        const req = mod.request({
            protocol: url.protocol,
            hostname: url.hostname.replace(/^\[|\]$/g, ''),
            port: url.port || undefined,
            path: url.pathname + url.search,
            method: 'GET',
            agent: false,
            headers: { 'User-Agent': USER_AGENT, Accept: 'audio/*, application/ogg;q=0.9, */*;q=0.5', 'Icy-MetaData': '0', ...headers },
            // pin the connection to the address we checked (both lookup callback styles)
            lookup: (_h, opts, cb) => {
                if (typeof opts === 'function') cb = opts;
                if (opts && opts.all) return cb(null, [{ address, family }]);
                return cb(null, address, family);
            }
        }, res => {
            if (done) return res.destroy();
            done = true;
            clearTimeout(timer);
            resolve(res);
        });
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            req.destroy();
            reject(new UrlRefused('timeout', 'That link did not answer within 10 seconds.'));
        }, headerTimeoutMs);
        req.on('error', err => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(new UrlRefused('network', 'I could not open that link (' + (err.code || 'network error') + ').'));
        });
        req.end();
    });
}

function readSmallBody(res, max = MAX_PLAYLIST_BYTES) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        res.on('data', c => {
            size += c.length;
            if (size > max) {
                res.destroy();
                return reject(new UrlRefused('playlist_too_big', 'That playlist is too big.'));
            }
            chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
    });
}

/**
 * Opens a user-given audio URL safely.
 * @returns {Promise<{stream, url: string, contentType: string, live: boolean, title: string|null, seekable: boolean}>}
 */
async function openAudioUrl(input, opts = {}, depth = 0) {
    let checked = await checkUrl(input, opts);
    let res;
    for (let hop = 0; ; hop++) {
        res = await requestOnce(checked, opts);
        const code = res.statusCode;
        if (code >= 300 && code < 400 && res.headers.location) {
            res.destroy();
            if (hop >= MAX_REDIRECTS) throw new UrlRefused('too_many_redirects', 'That link redirects too many times.');
            const next = new URL(res.headers.location, checked.url).toString();
            checked = await checkUrl(next, opts); // re-check every hop
            continue;
        }
        break;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy();
        throw new UrlRefused('http_status', `That link answered with HTTP ${res.statusCode}.`);
    }

    const ct = res.headers['content-type'] || '';
    const kind = classifyContentType(ct, checked.url.pathname);
    if (kind === 'hls') {
        res.destroy();
        throw new UrlRefused('hls', 'HLS streams (.m3u8) are not supported. Try another stream link of that station (mp3 / aac / ogg).');
    }
    if (kind === 'refused') {
        res.destroy();
        throw new UrlRefused('not_audio', `That link is not audio (it sent "${String(ct).split(';')[0].slice(0, 40)}").`);
    }
    if (kind === 'pls' || kind === 'm3u' || kind === 'm3u_or_hls') {
        const body = await readSmallBody(res);
        const pl = parsePlaylist(body);
        if (pl.hls) throw new UrlRefused('hls', 'HLS streams (.m3u8) are not supported. Try another stream link of that station (mp3 / aac / ogg).');
        if (!pl.urls.length) throw new UrlRefused('empty_playlist', 'That playlist has no stream links.');
        if (depth >= 1) throw new UrlRefused('nested_playlist', 'That playlist points to another playlist.');
        return openAudioUrl(pl.urls[0], opts, depth + 1);
    }

    const len = Number(res.headers['content-length']);
    const isIcy = Object.keys(res.headers).some(h => h.startsWith('icy-'));
    const live = isIcy || !Number.isFinite(len) || len <= 0;
    res.setTimeout(STALL_TIMEOUT_MS, () => res.destroy(new Error('stream stalled')));
    const icyName = res.headers['icy-name'] ? String(res.headers['icy-name']).slice(0, 80) : null;
    return {
        stream: res,
        url: checked.url.toString(),
        contentType: String(ct).split(';')[0].trim(),
        live,
        seekable: !live && /bytes/i.test(String(res.headers['accept-ranges'] || '')),
        title: icyName
    };
}

module.exports = {
    USER_AGENT, MAX_REDIRECTS, HEADER_TIMEOUT_MS, UrlRefused,
    isBlockedIp, unsupportedService, looksLikeUrl, checkUrl, classifyContentType, parsePlaylist, openAudioUrl
};
