// One text clean-up used before EVERY AI keyword check (events/messageCreate.js) and by the AI knowledge search.
// "Release recollection." / "RELEASE   recollection!!" / "@Pingway release recollection" / "ｒｅｌｅａｓｅ　ｒｅｃｏｌｌｅｃｔｉｏｎ。"
// all become "release recollection".
// - full-width letters/numbers/spaces -> normal width (NFKC), then lower-case
// - Discord mentions (<@id>, <@!id>, <@&role>, <#channel>), @everyone/@here and typed @names are removed anywhere
// - custom Discord emoji (<:name:id>) and normal emoji are removed
// - punctuation and symbols are removed (also Japanese 。、！？「」『』・…), quotes included
// - spaces collapsed
// No typo / fuzzy matching: the words themselves must be right.

function normalize(text) {
    let s = String(text == null ? '' : text).normalize('NFKC').toLowerCase();
    s = s.replace(/<(?:@[!&]?|#)\d+>/g, ' ');           // Discord user / role / channel mentions
    s = s.replace(/<a?:[\w~]+:\d+>/g, ' ');             // custom Discord emoji
    s = s.replace(/@[^\s@]+/g, ' ');                     // @everyone, @here, typed @Pingway
    s = s.replace(/[\p{P}\p{S}\p{Extended_Pictographic}‍️⃣]/gu, ' '); // punctuation, symbols, emoji
    return s.replace(/\s+/g, ' ').trim();
}

module.exports = { normalize };
