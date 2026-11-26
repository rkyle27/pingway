// Builds data/ai/faq.json (the AI channel's Pingway FAQ) from the WEBSITE's FAQ, so the bot FAQ = the website FAQ.
// Run it again every time the website FAQ changes.
//   node tools/build-ai-faq.js <website repo folder> [git ref, default origin/main] [output, default data/ai/faq.json]
// Reads (never changes) the website repo with "git show":
//   public/assets/app.js                       - the FAQ list (id, link, link label, English keywords)
//   public/assets/i18n/{en,fr,de,ja}.json      - faq.<id>.q / .a / .k in each language
// The output is a data file the owner uploads himself (data/ai/ is not in git).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LANGS = ['en', 'fr', 'de', 'ja'];
const SITE = 'https://pingway.app';
// Console commands are never public: a FAQ text that talks about the console is refused
const CONSOLE_RE = /console|konsole|コンソール|cybrancee/i;

function plain(text) {
    return String(text || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/`/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

// Site links become full https://pingway.app addresses (clean URLs, no .html)
function absLink(link) {
    if (!link) return null;
    if (link === 'invite') return SITE + '/'; // the website builds the invite link in the browser: "Invite Pingway" is on the home page
    if (/^https?:\/\//.test(link)) return link;
    if (!link.startsWith('/')) link = '/' + link;
    link = link.replace(/\.html(?=$|[?#])/, '');
    return SITE + link;
}

// The FAQ list in app.js: lines like { id: 'f02', lk: 'faq.lnkInvite', link: 'invite', k: '...' }
function parseFaqList(appJs) {
    const consts = {};
    for (const m of appJs.matchAll(/const\s+([A-Z_]+)\s*=\s*'([^']*)'\s*;/g)) consts[m[1]] = m[2];
    const start = appJs.indexOf('const FAQ = [');
    if (start < 0) throw new Error('FAQ list not found in app.js');
    const end = appJs.indexOf('];', start);
    const block = appJs.slice(start, end);
    const list = [];
    for (const line of block.split('\n')) {
        const id = line.match(/\bid:\s*'(f\d+)'/);
        if (!id) continue;
        const lk = line.match(/\blk:\s*'([^']*)'/);
        const linkStr = line.match(/\blink:\s*'([^']*)'/);
        const linkConst = line.match(/\blink:\s*([A-Z_]+)/);
        const k = line.match(/\bk:\s*'([^']*)'/);
        const link = linkStr ? linkStr[1] : (linkConst ? consts[linkConst[1]] : null);
        if (linkConst && !linkStr && !link) throw new Error('Unknown link constant ' + linkConst[1] + ' for ' + id[1]);
        list.push({ id: id[1], lk: lk ? lk[1] : null, link: link || null, k: k ? k[1] : '' });
    }
    return list;
}

// i18n: { en: {...}, fr: {...}, ... } (the website language files)
function buildFaq(appJs, i18n, date) {
    const list = parseFaqList(appJs);
    const entries = [];
    for (const f of list) {
        const e = { id: f.id, q: {}, a: {}, k: {} };
        for (const l of LANGS) {
            const tr = i18n[l] || {};
            const q = tr['faq.' + f.id + '.q'] || i18n.en['faq.' + f.id + '.q'];
            const a = tr['faq.' + f.id + '.a'] || i18n.en['faq.' + f.id + '.a'];
            if (!q || !a) continue;
            e.q[l] = plain(q);
            e.a[l] = plain(a);
            e.k[l] = plain(tr['faq.' + f.id + '.k'] || (l === 'en' ? f.k : '')) || (l === 'en' ? f.k : '');
        }
        if (!e.q.en) continue;
        if (!e.k.en) e.k.en = f.k;
        if (f.link) {
            e.link = absLink(f.link);
            if (f.lk) {
                e.linkLabel = {};
                for (const l of LANGS) e.linkLabel[l] = plain((i18n[l] || {})[f.lk] || i18n.en[f.lk] || '');
            }
        }
        const all = JSON.stringify(e);
        if (CONSOLE_RE.test(all)) throw new Error('FAQ ' + f.id + ' mentions the console - console commands are never public. Not written.');
        entries.push(e);
    }
    return { source: 'pingway.app FAQ', generated: date || new Date().toISOString().slice(0, 10), count: entries.length, entries };
}

function gitShow(repo, ref, file) {
    return execFileSync('git', ['-C', repo, 'show', ref + ':' + file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main() {
    const repo = process.argv[2];
    const ref = process.argv[3] || 'origin/main';
    const out = process.argv[4] || path.join(__dirname, '..', 'data', 'ai', 'faq.json');
    if (!repo) {
        console.error('Usage: node tools/build-ai-faq.js <website repo folder> [git ref] [output file]');
        process.exit(1);
    }
    const appJs = gitShow(repo, ref, 'public/assets/app.js');
    const i18n = {};
    for (const l of LANGS) i18n[l] = JSON.parse(gitShow(repo, ref, 'public/assets/i18n/' + l + '.json'));
    const faq = buildFaq(appJs, i18n);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(faq, null, 1) + '\n');
    console.log('✅ Wrote ' + faq.count + ' FAQ entries to ' + out);
}

if (require.main === module) main();

module.exports = { buildFaq, parseFaqList, absLink, plain };
