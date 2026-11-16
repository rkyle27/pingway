// IGN Card: the Tomestone / FFLogs links saved on a character must belong to THAT character.
// The same file on both sides (bot utils/ignLinks.js and website lib/ignLinks.js): keep them identical.
//
// check(url, kind, character) -> { ok: true, normalizedUrl } | { ok: false, code, suggest? }
//   kind: 'tomestone' | 'fflogs'; character: { lodestoneId, name, world } (world may be "Gilgamesh [Aether]", as the Lodestone shows it)
//   codes: 'wrong_site' | 'not_https' | 'wrong_character' | 'wrong_world' | 'unverifiable_id' | 'bad_format'
// Rules: https only, no user / password in the link, 300 characters at most; ?query and #fragment are allowed but dropped.
//   Tomestone  https://tomestone.gg/character/<LodestoneID>/<anything>[/more]  (the text after the id doesn't matter)
//              -> https://tomestone.gg/character/<id>/<the slug given, or one made from the name>
//   FFLogs     host www.fflogs.com, fflogs.com or de. / fr. / ja. / ko. / cn.fflogs.com, the form and host given are kept:
//              /character/lodestone-id/<LodestoneID>          the Lodestone id must match
//              /character/<na|eu|jp|oc>/<world>/<name>        world + name must match (no case, URL-decoded, + and %20 = space),
//                                                             and the region must be the world's region
//              /character/id/<FFLogs id>                      can't be checked: refused, with the lodestone-id link as suggest
// usable(url, kind, character) -> the normalized link when it passes, else '' (older saved links that don't match are kept
// in the database but never shown or sent).

const MAX_LEN = 300;
const FFLOGS_HOSTS = ['fflogs.com', 'www.fflogs.com', 'de.fflogs.com', 'fr.fflogs.com', 'ja.fflogs.com', 'ko.fflogs.com', 'cn.fflogs.com'];
const TOMESTONE_HOSTS = ['tomestone.gg', 'www.tomestone.gg'];
const ID_RE = /^\d{1,20}$/;

// World -> FFLogs region (the same worlds as the bot's data/datacenter.json)
const REGION_WORLDS = {
    na: ['Adamantoise', 'Cactuar', 'Faerie', 'Gilgamesh', 'Jenova', 'Midgardsormr', 'Sargatanas', 'Siren',
        'Behemoth', 'Excalibur', 'Exodus', 'Famfrit', 'Hyperion', 'Lamia', 'Leviathan', 'Ultros',
        'Balmung', 'Brynhildr', 'Coeurl', 'Diabolos', 'Goblin', 'Malboro', 'Mateus', 'Zalera',
        'Cuchulainn', 'Golem', 'Halicarnassus', 'Kraken', 'Maduin', 'Marilith', 'Rafflesia', 'Seraph'],
    eu: ['Cerberus', 'Louisoix', 'Moogle', 'Omega', 'Phantom', 'Ragnarok', 'Sagittarius', 'Spriggan',
        'Alpha', 'Lich', 'Odin', 'Phoenix', 'Raiden', 'Shiva', 'Twintania', 'Zodiark'],
    oc: ['Bismarck', 'Ravana', 'Sephirot', 'Sophia', 'Zurvan'],
    jp: ['Aegis', 'Atomos', 'Carbuncle', 'Garuda', 'Gungnir', 'Kujata', 'Tonberry', 'Typhon',
        'Alexander', 'Bahamut', 'Durandal', 'Fenrir', 'Ifrit', 'Ridill', 'Tiamat', 'Ultima',
        'Anima', 'Asura', 'Chocobo', 'Hades', 'Ixion', 'Masamune', 'Pandaemonium', 'Titan',
        'Belias', 'Mandragora', 'Ramuh', 'Shinryu', 'Unicorn', 'Valefor', 'Yojimbo', 'Zeromus']
};
const WORLD_REGION = {};
for (const [region, worlds] of Object.entries(REGION_WORLDS)) for (const w of worlds) WORLD_REGION[w.toLowerCase()] = region;

// "Kro%20Lex" / "kro+lex" / " KRO  lex " -> "kro lex"; null when it can't be decoded
function plain(s) {
    let out;
    try { out = decodeURIComponent(String(s || '').replace(/\+/g, ' ')); } catch (e) { return null; }
    return out.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}
// "Gilgamesh [Aether]" / "Gilgamesh (Aether)" / "Gilgamesh" -> "gilgamesh"
const worldOf = w => String(w || '').replace(/\s*[[(].*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const nameOf = n => String(n || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const slugOf = n => nameOf(n).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const lodestoneLink = id => 'https://www.fflogs.com/character/lodestone-id/' + id;

function check(url, kind, character) {
    const c = character || {};
    const id = ID_RE.test(String(c.lodestoneId || '')) ? String(c.lodestoneId) : '';
    const raw = typeof url === 'string' ? url.trim() : '';
    if (!raw || raw.length > MAX_LEN) return { ok: false, code: 'bad_format' };
    let u;
    try { u = new URL(raw); } catch (e) { return { ok: false, code: 'bad_format' }; }
    if (u.protocol !== 'https:') return { ok: false, code: 'not_https' };
    if (u.username || u.password || u.port) return { ok: false, code: 'bad_format' };
    const host = u.hostname.toLowerCase();
    // "/character/1/x/" -> ['character', '1', 'x'] (one ending / is fine, an empty part like "//" is not)
    const parts = u.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');
    if (parts.some(p => p === '')) return { ok: false, code: 'bad_format' };

    if (kind === 'tomestone') {
        if (!TOMESTONE_HOSTS.includes(host)) return { ok: false, code: 'wrong_site' };
        if (parts[0] !== 'character' || !ID_RE.test(parts[1] || '')) return { ok: false, code: 'bad_format' };
        if (!id || parts[1] !== id) return { ok: false, code: 'wrong_character' };
        const slug = parts[2] || slugOf(c.name);
        return { ok: true, normalizedUrl: 'https://tomestone.gg/character/' + id + '/' + slug };
    }

    if (kind !== 'fflogs') return { ok: false, code: 'wrong_site' };
    if (!FFLOGS_HOSTS.includes(host)) return { ok: false, code: 'wrong_site' };
    if (parts[0] !== 'character') return { ok: false, code: 'bad_format' };
    const suggest = id ? { suggest: lodestoneLink(id) } : {};
    const base = 'https://' + host + '/character/';
    if (parts[1] === 'lodestone-id' && parts.length === 3) {
        if (!ID_RE.test(parts[2])) return { ok: false, code: 'bad_format' };
        if (!id || parts[2] !== id) return Object.assign({ ok: false, code: 'wrong_character' }, suggest);
        return { ok: true, normalizedUrl: base + 'lodestone-id/' + parts[2] };
    }
    if (parts[1] === 'id' && parts.length === 3) return Object.assign({ ok: false, code: 'unverifiable_id' }, suggest);
    if (parts.length === 4 && REGION_WORLDS[parts[1].toLowerCase()]) {
        const region = parts[1].toLowerCase();
        const world = plain(parts[2]), name = plain(parts[3]);
        if (!world || !name) return { ok: false, code: 'bad_format' };
        const myWorld = worldOf(c.world), myName = nameOf(c.name);
        if (!myWorld || !myName || world !== myWorld || name !== myName) return Object.assign({ ok: false, code: 'wrong_world' }, suggest);
        // a world missing from the list (a new one) is checked by its name only
        if (WORLD_REGION[myWorld] && WORLD_REGION[myWorld] !== region) return Object.assign({ ok: false, code: 'wrong_world' }, suggest);
        return { ok: true, normalizedUrl: base + parts.slice(1).join('/') };
    }
    return { ok: false, code: 'bad_format' };
}

function usable(url, kind, character) {
    if (!url) return '';
    const r = check(url, kind, character);
    return r.ok ? r.normalizedUrl : '';
}

module.exports = { check, usable, REGION_WORLDS, WORLD_REGION, MAX_LEN, FFLOGS_HOSTS, TOMESTONE_HOSTS };
