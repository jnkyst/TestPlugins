/*
 * SkyStream MovieLinkBD provider
 * Use only media you are authorized to access.
 *
 * Home screen (getHome) is arranged as:
 *   Latest Release  ->  /
 *   BOLLYWOOD       ->  /bollywood
 *   HINDI           ->  /language/hindi
 *   HINDI DUB       ->  /language/hindi-dubbed
 *
 * The site renders every listing as a <div class="movie-card"> inside
 * <div class="movie-cards-container">, so listingScope() slices that
 * grid out of the page. On the homepage that grid is only the
 * "Recently Updated" block, which keeps the Top 10 / rail items from
 * leaking into the Latest Release row. The old <article class="post">
 * markup and the #moviesGridMain grid are kept as fallbacks.
 *
 * Search uses MovieLinkBD's HTML endpoint GET /search?q=...&page=N
 * (the inherited /lookup.php JSON API 404s on this site) and reuses
 * the movie-card parser, 30 results per page. "Found 0 Results"
 * pages return an empty list instead of an error.
 *
 * HTTP is strictly ONE request at a time: when requests are fired in
 * parallel (Promise.all), the SkyStream runtime answers 500 for every
 * request except the first. get() also retries 5xx/429 once after a
 * short wait, so transient rate-limit 500s recover on their own.
 *
 * Series episodes and movie downloads sit behind MovieLinkBD's
 * encrypted data-dl anchors -> /file/<token> server choosers -> final
 * direct URL (FSL Cloudflare Worker, Range-capable video). The
 * decoder, the /file/ follow logic and the worker media pattern all
 * live in this file; ZIP packs are deliberately never offered.
 */

(function () {
'use strict';

// The site's generated subdomain rotates often (cmzguz ->
// x7ykrg -> ywqpaz -> ...). Old hosts 302 to the live one, and every
// live page declares its own host in rel=canonical / og:url, so
// noteOrigin() re-anchors the origin for the rest of the session on
// the first page fetched. manifest.baseUrl may point at the stable
// primary/landing domain (e.g. https://movielinkbd.info/) - landing
// pages link out to the content subdomain, which noteOrigin()
// resolves. Editing plugin.json while the plugin runs is also picked
// up: a changed manifest.baseUrl discards the cached origin.
var liveOrigin = '';
var lastManifestBase = String((manifest && manifest.baseUrl) || '');

function base() {
var configured = String((manifest && manifest.baseUrl) || '');

// baseUrl value changed at runtime (plugin.json edited / reloaded):
// forget the page-derived origin so the new value takes effect on the
// very next request.
if (configured && configured !== lastManifestBase) {
lastManifestBase = configured;
liveOrigin = '';
}

return String(liveOrigin || configured || lastManifestBase).replace(/\/+$/, '');
}

function noteOrigin(responseUrl, html) {
var host = '';
var scheme = 'https';

// 1) Final URL after redirects, when the runtime exposes it.
var fromUrl = String(responseUrl || '').match(/^(https?):\/\/([^\/:?#]+)/i);
if (fromUrl && /(^|\.)movielinkbd\.[a-z.]+$/i.test(fromUrl[2])) {
scheme = fromUrl[1].toLowerCase();
host = fromUrl[2];
}

var body = String(html || '');

// 2) rel=canonical / og:url of the fetched page.
if (!host && body) {
var declared =
body.match(/<link[^>]*rel=["']canonical["'][^>]*href=["'](https?):\/\/([^"\/]+)["']/i) ||
body.match(/<meta[^>]*property=["']og:url["'][^>]*content=["'](https?):\/\/([^"\/]+)["']/i);

if (declared && /(^|\.)movielinkbd\.[a-z.]+$/i.test(declared[2])) {
scheme = declared[1].toLowerCase();
host = declared[2];
}
}

// 3) Primary/landing domains (apex hosts like movielinkbd.info)
//    declare themselves as canonical but link out to the real
//    content subdomain (the generated subdomain rotates often).
//    Prefer the subdomain the page points at, so baseUrl set to
//    the stable primary domain still resolves the working site.
if (body && (!host || /^movielinkbd\.[a-z.]+$/i.test(host))) {
var found = body.match(/https:\/\/([a-z0-9-]+\.movielinkbd\.[a-z.]+)/i);
if (found) {
scheme = 'https';
host = found[1];
}
}

if (!host || !/(^|\.)movielinkbd\.[a-z.]+$/i.test(host)) return;

var origin = scheme + '://' + host.toLowerCase();

if (origin !== liveOrigin) {
liveOrigin = origin;
}

// Reflect the live origin back into manifest.baseUrl, so the baseUrl
// value itself changes at runtime whenever the domain moves.
try {
if (manifest && typeof manifest === 'object') {
manifest.baseUrl = origin + '/';
lastManifestBase = manifest.baseUrl;
}
} catch (error) {
// manifest may be read-only; liveOrigin still drives base().
}
}

// Resolve the content baseUrl automatically on first use: when
// manifest.baseUrl is the stable PRIMARY/landing domain (e.g.
// https://movielinkbd.info/), fetch its homepage once and let
// noteOrigin() pull the live content subdomain out of its links, so
// every subsequent request goes direct to the content host.
// Subdomain baseUrl values skip the bootstrap (the first real fetch
// re-anchors them). Re-runs after a runtime edit of manifest.baseUrl.
var bootstrapDone = false;
var bootstrappedFrom = '';

async function ensureBase() {
var configured = String((manifest && manifest.baseUrl) || '');

if (bootstrapDone && configured === bootstrappedFrom) {
return;
}

bootstrappedFrom = configured;
bootstrapDone = true;

var host =
((configured.match(/^https?:\/\/([^\/]+)/i) || [])[1] || '')
.toLowerCase()
.replace(/^www\./, '');

if (!/^movielinkbd\.[a-z.]+$/.test(host)) {
return; // already a content subdomain (or non-movielinkbd value)
}

try {
await get(configured.replace(/\/+$/, '') + '/');
} catch (error) {
// Primary unreachable: keep it as baseUrl; the per-fetch rescue
// paths recover as soon as any page becomes reachable.
}
}

function decode(value) {
return String(value || '')
.replace(/&#x([0-9a-f]+);/gi, function (_, number) {
return String.fromCharCode(parseInt(number, 16));
})
.replace(/&#(\d+);/g, function (_, number) {
return String.fromCharCode(parseInt(number, 10));
})
.replace(/&amp;/gi, '&')
.replace(/&quot;/gi, '"')
.replace(/&#39;|&apos;/gi, "'")
.replace(/&lt;/gi, '<')
.replace(/&gt;/gi, '>')
.replace(/ /gi, ' ');
}

function text(value) {
return decode(
String(value || '').replace(/<[^>]*>/g, ' ')
).replace(/\s+/g, ' ').trim();
}

function attr(tag, name) {
var pattern =
'(?:^|\\s)' +
name +
'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))';

var match = String(tag || '').match(
new RegExp(pattern, 'i')
);

return match
? decode(match[1] || match[2] || match[3] || '')
: '';
}

// Base64 decode that works even if the host JS engine has no atob().
function safeAtob(value) {
var input = String(value || '').replace(/\s/g, '');

if (typeof atob === 'function') {
return atob(input);
}

var chars =
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
var output = '';
var i = 0;

while (i < input.length) {
var a = chars.indexOf(input.charAt(i++));
var b = chars.indexOf(input.charAt(i++));
var c = chars.indexOf(input.charAt(i++));
var d = chars.indexOf(input.charAt(i++));

if (a < 0 || b < 0) break;

var n = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);

output += String.fromCharCode((n >> 16) & 255);
if (c !== 64 && c >= 0) output += String.fromCharCode((n >> 8) & 255);
if (d !== 64 && d >= 0) output += String.fromCharCode(n & 255);
}

return output;
}

// 32-bit integer multiply (Math.imul) with an ES5 fallback, used by
// the MovieLinkBD link decoder below.
function imul32(a, b) {
if (typeof Math.imul === 'function') return Math.imul(a, b);

var ah = (a >>> 16) & 0xffff;
var al = a & 0xffff;
var bh = (b >>> 16) & 0xffff;
var bl = b & 0xffff;

return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
}

// MovieLinkBD hides every real download target behind an XOR-encoded
// anchor: <a href="#" data-dl="<base64>" data-ds="<seed hex>"
// data-dr="<warmup rounds>">Download [720p • 260 MB]</a>. This is a
// faithful port of the site's own `dec()` from its inline script:
// seed an LCG with parseInt(data-ds, 16), warm it up data-dr times,
// then XOR each base64-decoded byte with (state >>> 16) & 0xff after
// one more LCG step per byte. Returns the decoded path/URL ('' on
// failure); callers run it through absolute().
function decodeDataDl(anchorTag) {
var payload = attr(anchorTag, 'data-dl');
if (!payload) return '';

var seed = parseInt(attr(anchorTag, 'data-ds') || '', 16) >>> 0;
var rounds = parseInt(attr(anchorTag, 'data-dr') || '0', 10) || 0;

try {
var x = seed;
var i;
for (i = 0; i < rounds; i++) {
x = (imul32(x, 1103515245) + 12345) >>> 0;
}

var raw = safeAtob(payload);
var out = '';
var j;

for (j = 0; j < raw.length; j++) {
x = (imul32(x, 1103515245) + 12345) >>> 0;
out += String.fromCharCode(raw.charCodeAt(j) ^ ((x >>> 16) & 255));
}

return out;
} catch (error) {
console.error('Could not decode data-dl link: ' + String(error));
return '';
}
}

// ── Single-source domain handling ──────────────────────────────
// Only ONE place controls the site origin: manifest.baseUrl in
// plugin.json, upgraded at runtime by noteOrigin() from each page's
// canonical/og:url when the generated subdomain rotates (cmzguz ->
// x7ykrg -> ywqpaz -> ...). isSiteUrl() recognises every known
// MovieLinkBD mirror via a host pattern (any *.movielinkbd.* host),
// and normalizeSiteUrl() rewrites any of them to base(). Old hosts
// 302 to the live one, so bookmarks from previous subdomains keep
// resolving even before plugin.json is updated.
function isSiteUrl(url) {
var host = (String(url || '').match(/^https?:\/\/([^\/:?#]+)/i) || [])[1] || '';
host = host.toLowerCase().replace(/^www\./i, '');
if (!host) return false;
if (/(^|\.)movielinkbd\.[a-z.]+$/i.test(host)) return true;
return false;
}

function normalizeSiteUrl(url) {
if (!isSiteUrl(url)) return String(url || '');
return String(url).replace(/^https?:\/\/[^\/]+/i, base());
}

function absolute(url) {
url = decode(url || '').trim();

if (/^https?:\/\//i.test(url)) {
return normalizeSiteUrl(url);
}

if (url.indexOf('//') === 0) {
return normalizeSiteUrl('https:' + url);
}

if (url.charAt(0) === '/') {
return base() + url;
}

return url ? base() + '/' + url : '';
}

function directImageUrl(url) {
url = absolute(url);

// Older posts used an image-proxy URL whose `u` parameter holds the
// original image URL encoded with Base64. The current site serves
// TMDB images directly, so this only runs for legacy proxy URLs.
if (/^https:\/\/img\.[a-z0-9.-]+\//i.test(url)) {
var match = url.match(/[?&]u=([^&]+)/i);

if (match) {
try {
var encoded = decodeURIComponent(match[1])
.replace(/-/g, '+')
.replace(/_/g, '/');
var original = safeAtob(encoded);

if (/^https:\/\/image\.tmdb\.org\/t\/p\/[a-z0-9]+\/[A-Za-z0-9]+\.(?:jpe?g|png|webp)$/i.test(original)) {
return original;
}
} catch (error) {
console.error('Could not decode poster URL: ' + String(error));
}
}
}

return url;
}

function tmdbSize(url, size) {
// Keep any cache-busting query (?v=...) that MovieLinkBD appends to
// TMDB URLs, so w500 / w1280 resizing still applies.
return String(url || '').replace(
/^(https:\/\/image\.tmdb\.org\/t\/p\/)[a-z0-9]+(\/[A-Za-z0-9]+\.(?:jpe?g|png|webp))(\?[^#]*)?$/i,
'$1' + size + '$2$3'
);
}

function isSourcePage(url) {
// Accept any known MovieLinkBD mirror, not just the current baseUrl,
// so that search results / bookmarks from any mirror still resolve
// after the subdomain moves.
if (!url) return false;
if (isSiteUrl(url)) return true;
return url.indexOf(base() + '/') === 0;
}

// Post pages live under the site's title roots (/movie/..., /series/...,
// /drama/..., /anime/..., /download18plus/...). Category, pagination and
// system paths are not playable posts.
function isPostPage(url) {
if (!isSourcePage(url)) return false;

// Normalise first so that any mirror URL is judged against
// the same path rules as the current site URL.
var normalized = normalizeSiteUrl(url);
var path = normalized.slice(base().length + 1);

return !/^(category|page|wp-|search|author|tag|date|feed|comments|privacy|terms|contact|about|dmca|how-to-download|collection|language|genre|type|live)(\/|$)/i.test(path);
}

// The site's download pipeline lives at /file/<token>: a server
// chooser page that leads to the next /file/ hop and eventually to a
// direct file URL. These pages are part of the playable chain.
function isFilePage(url) {
if (!isSourcePage(url)) return false;

var normalized = normalizeSiteUrl(url);
var path = normalized.slice(base().length + 1);

return /^file\//i.test(path);
}

function delay(ms) {
return new Promise(function (resolve) {
if (typeof setTimeout === 'function') {
setTimeout(resolve, ms);
} else {
resolve();
}
});
}

// Single in-flight request with one retry on server errors. Callers
// must never overlap http_get calls: parallel requests make the
// SkyStream HTTP layer answer 500 for all but the first one, and a
// transient 500 (rate limiting) is retried once after a short wait.
async function get(url) {
var lastError = null;

for (var attempt = 0; attempt < 3; attempt++) {
if (attempt > 0) {
await delay(attempt === 1 ? 1500 : 3000);
console.error(
'Retrying request (attempt ' + (attempt + 1) + '): ' + url
);
}

var response = null;

try {
response = await http_get(url, {
'User-Agent': 'Mozilla/5.0',
'Accept': 'text/html,application/xhtml+xml'
});
} catch (error) {
lastError = new Error('HTTP request failed: ' + String(error));
continue;
}

if (!response) {
lastError = new Error('HTTP request failed: null');
continue;
}

var status = Number(response.status) || 0;

// Status-less responses are treated as success (as before).
if (!(status && (status < 200 || status >= 400))) {
var body = String(response.body || '');

// Re-anchor the origin if the site moved (stale subdomain ->
// 302 -> live host, or the runtime's final URL).
noteOrigin(
(response && (response.url || response.finalUrl)) || '',
body
);

return body;
}

lastError = new Error('HTTP request failed: ' + response.status);

// 4xx (except 429) is permanent; 429 and 5xx are worth one retry.
if (status < 500 && status !== 429) {
throw lastError;
}
}

throw lastError;
}

function cleanTitle(value) {
return text(value)
.replace(/^download\s+/i, '')
.trim();
}

function kind(title, url) {
// Short carousel titles often contain only the name and year. The
// post URL still contains "season" or "series", so inspect both.
// MovieLinkBD titles also carry "S01 [Ep 01-11 ...]" markers on
// /drama/ and /anime/ posts, which have no "series" in the URL.
var value = String(title || '') + ' ' + String(url || '');

return /\b(series|seasons?|episodes?|s\d{1,2}e\d{1,3}|s\d{1,2}|ep(?:isode)?s?\s*\d{1,3}|tv[ -]?shows?|reality[ -]?shows?|game[ -]?shows?|talk[ -]?shows?|k[ -]?dramas?|c[ -]?dramas?)\b/i.test(value)
? 'series'
: 'movie';
}

function yearOf(title) {
var match = title.match(/\b(19\d{2}|20\d{2})\b/);
return match ? Number(match[1]) : undefined;
}

function fail(callback, error) {
callback({
success: false,
errorCode: 'UNKNOWN_ERROR',
message: String(
error && error.message ? error.message : error
)
});
}

// =====================================
// HOME LISTINGS
// =====================================

// MovieLinkBD renders listings as <div class="movie-card"> blocks
// inside <div class="movie-cards-container">. Slice that grid out so
// navigation, rails (Top 10, Collections ...), ads and "You May Also
// Like" sidebars are never picked up. On the homepage the container
// holds only the "Recently Updated" grid, and the rails start at
// mlbd-rails-wrap; category pages end at the mlbd-pagejump
// paginator. The legacy <article class="post"> markup and the
// #moviesGridMain grid are kept as fallbacks for older cached pages.
function listingScope(html) {
var container = /<div\b[^>]*class=["'][^"']*\bmovie-cards-container\b[^"']*["'][^>]*>/i.exec(html);

if (container) {
var start = container.index + container[0].length;
var remainder = html.slice(start);
var end = /mlbd-rails-wrap|mlbd-pagejump|<footer\b|class=["'][^"']*pagination/i.exec(remainder);

return remainder.slice(0, end ? end.index : remainder.length);
}

var articles =
html.match(/<article\b[^>]*class=["'][^"']*\bpost\b[^"']*["'][^>]*>[\s\S]*?<\/article\s*>/gi);

if (articles && articles.length) {
return articles.join('\n');
}

var gridPattern = /<div\b(?=[^>]*\bid=["']moviesGridMain["'])[^>]*>/i;
var grid = gridPattern.exec(html);

if (grid) {
var gridStart = grid.index + grid[0].length;
var afterGrid = html.slice(gridStart);
var gridEnd = /<\/section\s*>|<nav\b[^>]*class=["'][^"']*pagination/i.exec(afterGrid);

return afterGrid.slice(0, gridEnd ? gridEnd.index : afterGrid.length);
}

return '';
}

function listings(html) {
var items = [];
var seen = {};
var scope = listingScope(html);

if (!scope) {
throw new Error('Post list not found; the site layout may have changed');
}

var anchors =
scope.match(/<a(?=[\s>\/])[^>]*>[\s\S]*?<\/a\s*>/gi) || [];

anchors.forEach(function (anchor) {
var opening =
(anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';

var href = absolute(attr(opening, 'href'));

if (!isPostPage(href) || seen[href]) {
return;
}

var image =
(anchor.match(/<img\b[^>]*>/i) || [])[0] || '';

if (!image) return;

var title = cleanTitle(
attr(image, 'alt') || text(anchor)
);

var poster = absolute(
attr(image, 'data-src') ||
attr(image, 'data-lazy-src') ||
attr(image, 'src')
);

// Lazy-load placeholders are data: SVG stubs, not posters.
if (!title || !poster || /^data:/i.test(poster)) return;

seen[href] = true;

items.push(
new MultimediaItem({
title: title,
url: href,
posterUrl: poster,
type: kind(title, href),
year: yearOf(title)
})
);
});

return items;
}

function meta(html, key) {
var tags = html.match(/<meta\b[^>]*>/gi) || [];

for (var i = 0; i < tags.length; i++) {
var name =
attr(tags[i], 'property') ||
attr(tags[i], 'name');

if (name.toLowerCase() === key.toLowerCase()) {
return attr(tags[i], 'content');
}
}

return '';
}

// =====================================
// SEARCH HELPERS
// =====================================

async function searchItems(term, pageNumber) {
// MovieLinkBD search is a plain HTML page - the inherited
// /lookup.php endpoint returns 404 here. GET /search?q=...&page=N
// renders the same movie-card grid as the category pages (30 per
// page, "Found N Results" heading), so listings() parses it
// directly. The site links page 1 without a page parameter.
await ensureBase();

var queryPath =
'/search?q=' +
encodeURIComponent(term) +
(pageNumber > 1 ? '&page=' + pageNumber : '');

var fetchBase = base();
var html = await get(fetchBase + queryPath);

// Landing/primary baseUrl (e.g. movielinkbd.info): noteOrigin() may
// have just resolved the real content host from the fetched page, so
// re-run the search there instead of parsing the landing page.
if (base() !== fetchBase && !listingScope(html)) {
html = await get(base() + queryPath);
}

// "Found 0 Results" pages ship no results grid at all.
if (/Found\s+0\s+Results/i.test(html)) {
return [];
}

try {
return listings(html);
} catch (error) {
// No results grid means an empty result set (or a layout change);
// an empty list is a valid search outcome, not a hard error.
if (!listingScope(html)) return [];
throw error;
}
}

// =====================================
// HOME
// =====================================

async function getHome(callback) {
// Home screen arrangement: one row per section, in this order.
var sections = [
{ name: 'Latest Release', path: '/' },
{ name: 'BOLLYWOOD', path: '/bollywood' },
{ name: 'HINDI', path: '/language/hindi' },
{ name: 'HINDI DUB', path: '/language/hindi-dubbed' }
];

try {
// Resolve the primary/landing baseUrl -> content host first, so
// every section fetch already goes direct.
await ensureBase();

// Fetch sections strictly one at a time: parallel requests make
// the runtime's HTTP layer answer 500 for all but the first one.
var results = [];

for (var i = 0; i < sections.length; i++) {
var section = sections[i];

try {
var fetchBase = base();
var html = await get(fetchBase + section.path);
var items;

try {
items = listings(html);
} catch (parseError) {
// A primary/landing baseUrl serves the landing page for every
// path; noteOrigin() resolves the real content host from it, so
// re-fetch the section there once before giving up.
if (base() !== fetchBase) {
items = listings(await get(base() + section.path));
} else {
throw parseError;
}
}

results.push({ items: items, error: null });
} catch (error) {
console.error(
'Home section ' +
section.name +
': ' +
String(error)
);

results.push({ items: [], error: error });
}

// Pace same-host page loads so no section is rate-limited.
if (i < sections.length - 1) {
await delay(600);
}
}

var hasItems = results.some(function (result) {
return result.items.length > 0;
});

if (!hasItems) {
var firstError = results.find(function (result) {
return result.error;
});

throw firstError && firstError.error
? firstError.error
: new Error('No home items found');
}

var data = {};

sections.forEach(function (section, index) {
// Empty sections create blank rows in the app, so omit them.
if (results[index].items.length) {
data[section.name] = results[index].items;
}
});

callback({
success: true,
data: data
});
} catch (error) {
fail(callback, error);
}
}

// =====================================
// SEARCH
// =====================================

async function search(query, page, callback) {
if (typeof page === 'function') {
callback = page;
page = 1;
}

try {
var term = String(query || '').trim();

if (!term) {
return callback({
success: true,
data: []
});
}

var pageNumber = Math.max(
1,
parseInt(page, 10) || 1
);

callback({
success: true,
data: await searchItems(term, pageNumber)
});
} catch (error) {
fail(callback, error);
}
}

// =====================================
// SERIES EPISODES
// =====================================

// MovieLinkBD episode grids: one <div class="...ep-card" ...> per
// episode (combined ranges carry data-range-start/end), each holding
// encrypted data-dl download anchors labelled with their quality.
// ZIP packs live in separate mlbd-zip-card blocks, so they are never
// picked up here. Returns null when the page has no ep-cards, which
// routes the call to the legacy link-page parser below.
function mlbdEpisodeEntries(html) {
var cardRe = /<div\b[^>]*class=["'][^"']*\bep-card\b[^"']*["'][^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi;
var entries = {};
var found = false;
var m;

while ((m = cardRe.exec(html)) !== null) {
found = true;

var card = m[0];
var opening = (card.match(/^<div\b[^>]*>/i) || [])[0] || '';
var season = parseInt(attr(opening, 'data-season-number'), 10) || 1;
var first = parseInt(attr(opening, 'data-range-start'), 10) ||
parseInt(attr(opening, 'data-episode-number'), 10) ||
0;
var last = parseInt(attr(opening, 'data-range-end'), 10) || first;

if (!first) continue;

var links = [];
var anchorRe = /<a(?=[\s>\/])[^>]*data-dl=["'][^"']+["'][^>]*>[\s\S]*?<\/a\s*>/gi;
var am;

while ((am = anchorRe.exec(card)) !== null) {
var openA = (am[0].match(/^<a\b[^>]*>/i) || [])[0] || '';
var decoded = decodeDataDl(openA);
if (!decoded) continue;

var label = text(am[0]);
if (/zip/i.test(label)) continue;

var qm = label.match(/\b(2160p|1440p|1080p|720p|480p|4k|2k)\b/i);
links.push({
url: absolute(decoded),
quality: qm ? qm[1].toUpperCase() : 'Auto'
});
}

if (!links.length) continue;

var key = season + ':' + first + ':' + last + ':';
if (!entries[key]) {
entries[key] = { season: season, first: first, last: last, variant: '', links: [] };
}

links.forEach(function (entry) {
if (!entries[key].links.some(function (e) { return e.url === entry.url; })) {
entries[key].links.push(entry);
}
});
}

return found ? entries : null;
}

// Shared mapping: entries -> Episode objects. Episodes without a
// direct FastDL link use the encoded #skyepisode form, which
// loadStreams resolves through the /file/ chooser chain.
function episodesFromEntries(entries, seriesUrl) {
return Object.keys(entries).map(function (key) {
var ep = entries[key];
var name = ep.first === ep.last ? 'Episode ' + ep.first : 'Episodes ' + ep.first + '–' + ep.last + ' (combined file)';
if (ep.variant) name += ' - ' + ep.variant;
var fallbackUrl = seriesUrl.split('#')[0] + '#skyepisode=' + encodeURIComponent(JSON.stringify(ep.links));
var fastDirect = ep.links.find(function (entry) {
return entry && isFastDl(entry.url);
});

// Keep episode URLs short and directly resolvable. Use the encoded
// multi-host form only when an episode has no FastDL link.
return new Episode({
name: name,
url: fastDirect
? fastDirect.url + '&quality=' + encodeURIComponent(fastDirect.quality || 'Auto')
: fallbackUrl,
season: ep.season,
episode: ep.first
});
}).sort(function (a, b) { return a.season - b.season || a.episode - b.episode; });
}

// Headings on post pages and link-list pages, e.g.
// "Season 1 Single Episodes 720p [600MB/E]" or "-:Episodes: 3:-".
function headings(html) {
var list = [];
var re = /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi;
var m;

while ((m = re.exec(html)) !== null) {
list.push({
start: m.index,
end: re.lastIndex,
label: text(m[0])
});
}

return list;
}

function anchorsIn(html) {
return html.match(/<a(?=[\s>\/])[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
}

function anchorHref(anchor, page) {
var tag = (anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';
return pageUrl(attr(tag, 'href'), page);
}

async function seriesEpisodes(html, seriesUrl) {
// Current MovieLinkBD layout: encrypted episode cards on the post
// page itself. Only fall back to the legacy link-page chain when no
// ep-cards exist (older posts).
var mlbdEntries = mlbdEpisodeEntries(html);
if (mlbdEntries) {
return episodesFromEntries(mlbdEntries, seriesUrl);
}

var titleTag = (html.match(/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/i) || [])[0] || '';
var fallbackSeasonMatch = text(titleTag).match(/\bseason\s*(\d+)\b|\bs0*(\d+)/i);
var fallbackSeason = fallbackSeasonMatch ? Number(fallbackSeasonMatch[1] || fallbackSeasonMatch[2]) : 1;

// 1. Find the download groups on the post page: one m4ulinks.*
// link page per quality (legacy posts used nexdrive.beer).
var heads = headings(html);
var groups = [];

heads.forEach(function (h, i) {
var q = h.label.match(/\b(720p|1080p|1440p|2160p|2k|4k)\b/i);
if (!q) return;

var sm = h.label.match(/\bseason\s*(\d+)\b|\bs0*(\d+)/i);
var season = sm ? Number(sm[1] || sm[2]) : fallbackSeason;
var section = html.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : html.length);

anchorsIn(section).forEach(function (a) {
var link = anchorHref(a, seriesUrl);
var isNewHost = /^https:\/\/m4ulinks\.[a-z]+\/number\/\d+/i.test(link);
var isLegacyHost = /^https:\/\/(?:www\.)?nexdrive\.beer\//i.test(link);

if (!isNewHost && !isLegacyHost) return;
if (!groups.some(function (g) { return g.url === link; })) {
groups.push({
url: link,
season: season,
quality: q[1].toUpperCase(),
legacy: isLegacyHost
});
}
});
});

var entries = {};

// 2. Open each link page and collect the file-host links per
// episode. New pages list "-:Episodes: N:-" headings followed
// by HubCloud / GDFlix buttons. Pages are fetched one at a time:
// overlapping requests make the runtime's HTTP layer answer 500.
var pages = [];
var pageCount = Math.min(groups.length, 12);

for (var p = 0; p < pageCount; p++) {
try {
pages.push({ group: groups[p], html: await get(groups[p].url) });
} catch (e) {
console.error('Episode list request failed: ' + String(e));
pages.push(null);
}

if (p < pageCount - 1) {
await delay(300);
}
}

function add(group, first, last, links, variant) {
if (!first || !links.length) return;
last = last || first;
variant = variant || '';
var key = group.season + ':' + first + ':' + last + ':' + variant;
if (!entries[key]) entries[key] = { season: group.season, first: first, last: last, variant: variant, links: [] };
links.forEach(function (url) {
if (!entries[key].links.some(function (e) { return e.url === url; })) entries[key].links.push({ url: url, quality: group.quality });
});
}

pages.forEach(function (page) {
if (!page) return;

if (page.group.legacy) {
// Legacy NexDrive pages list individual episode headings with
// V-Cloud / FastDL / V-Drive links underneath.
var episodeHeads = [], er = /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi, match;
while ((match = er.exec(page.html)) !== null) {
var label = text(match[0]);
var ep = label.match(/\bepisodes?\s*[.:]?\s*(\d+)(?:\s*(?:[-–—+]|\bto\b)\s*(?:ep?\s*)?(\d+))?/i);
if (ep) episodeHeads.push({ start: match.index, end: er.lastIndex, first: Number(ep[1]), last: ep[2] ? Number(ep[2]) : Number(ep[1]) });
}
if (!episodeHeads.length) {
add(page.group, 1, 1, [page.group.url]);
return;
}
episodeHeads.forEach(function (ep, i) {
var end = i + 1 < episodeHeads.length ? episodeHeads[i + 1].start : page.html.length;
var links = extractLinks(page.html.slice(ep.end, end), page.group.url).filter(function (url) {
return /^https:\/\/(?:www\.)?vcloud\.beer\//i.test(url) || isFastDl(url) || isVDrive(url);
});
add(page.group, ep.first, ep.last, links);
});
return;
}

var pageHeads = headings(page.html);
var foundEpisode = false;

pageHeads.forEach(function (h, i) {
// Headings can cover a range of episodes in one combined file,
// e.g. "-:Episodes: 13-17:-". Capture both ends so episodes
// 14-17 are not lost and the file is labelled as combined.
var ep = h.label.match(/episodes?\s*[.:]?\s*(\d+)(?:\s*(?:[-–—+]|\bto\b)\s*(?:ep(?:isode)?s?\s*)?(\d+))?/i);
if (!ep) return;
foundEpisode = true;

var section = page.html.slice(h.end, i + 1 < pageHeads.length ? pageHeads[i + 1].start : page.html.length);
var links = anchorsIn(section)
.map(function (a) { return anchorHref(a, page.group.url); })
.filter(function (url) {
return /^https:\/\/(?:www\.)?hubcloud\.pw\/drive\//i.test(url) ||
/^https:\/\/(?:www\.)?gdflix\.(?:vip|io)\/file\//i.test(url);
});

// Preserve explicitly labelled versions as separate episode entries.
var suffix = h.label.slice(ep.index + ep[0].length);
var version = suffix.match(/^\s*[:\-–—]*\s*(YT|NF)\b/i);
add(page.group, Number(ep[1]), ep[2] ? Number(ep[2]) : Number(ep[1]), links, version ? version[1].toUpperCase() : '');
});

if (!foundEpisode) {
// A link page without episode headings holds a single file for
// the whole season; keep it as one item, not fake episodes.
var links = anchorsIn(page.html)
.map(function (a) { return anchorHref(a, page.group.url); })
.filter(function (url) {
return /^https:\/\/(?:www\.)?hubcloud\.pw\/drive\//i.test(url) ||
/^https:\/\/(?:www\.)?gdflix\.(?:vip|io)\/file\//i.test(url);
});
// Multi-file pages without recognizable episode headings must not be
// merged into Episode 1: they can contain unrelated bonus clips.
if (links.length <= 2) add(page.group, 1, 1, links);
}
});

return episodesFromEntries(entries, seriesUrl);
}

// =====================================
// MOVIE / SERIES DETAILS
// =====================================

async function load(url, callback) {
await ensureBase();
url = normalizeSiteUrl(url);

try {
if (!isSourcePage(url)) {
throw new Error('Not a page on the configured site');
}

var fetchBase = base();
var html = await get(url);

// The fetch may have re-anchored the origin (subdomain rotation or
// landing domain); rebuild the item URL so nothing stale is ever
// returned, and re-fetch the post page on the resolved content host
// if the fetch itself came from the old/landing origin.
url = normalizeSiteUrl(url);

if (base() !== fetchBase) {
html = await get(url);
}

var heading =
(html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i) || [])[0];

var title = cleanTitle(
heading || meta(html, 'og:title')
);

if (!title) {
throw new Error('Could not find title');
}

var imageTag =
(html.match(/<meta\b(?=[^>]*\bitemprop=["']image["'])[^>]*>/i) || [])[0];

var originalPoster = directImageUrl(
attr(imageTag, 'content') || meta(html, 'og:image')
);
var poster = tmdbSize(originalPoster, 'w500');
var banner = tmdbSize(originalPoster, 'w1280');

var itemType = kind(title, url);
var episodes = itemType === 'movie'
? [
new Episode({
name: 'Full Movie',
url: url,
season: 1,
episode: 1
})
]
: await seriesEpisodes(html, url);

var item = new MultimediaItem({
title: title,
url: url,
posterUrl: poster,
bannerUrl: banner,
type: itemType,
year: yearOf(title),
description:
meta(html, 'description') ||
meta(html, 'og:description'),
episodes: episodes
});

callback({
success: true,
data: item
});
} catch (error) {
fail(callback, error);
}
}

// =====================================
// STREAM HELPERS
// =====================================

function mediaUrl(url) {
if (/^https?:\/\/(?:www\.)?megaup\.net\//i.test(url)) {
return false;
}

return (
/^https?:\/\/[^\s]+\.(?:mp4|m3u8|mkv)(?:[?#].*)?$/i.test(url) ||
/^https:\/\/pub-[a-f0-9]{32}\.r2\.dev\//i.test(url) ||
/^https:\/\/[A-Za-z0-9-]+\.r2\.cloudflarestorage\.com\//i.test(url) ||
/^https:\/\/(?:[A-Za-z0-9-]+\.)+(?:googleusercontent|googlevideo)\.com\//i.test(url) ||
// MovieLinkBD's FSL mirror serves the file straight from a
// Cloudflare Worker (/d/<token>, video with Range support).
/^https:\/\/(?:[A-Za-z0-9.-]+\.workers\.dev|fsl\.[A-Za-z0-9.-]+)\/d\/[A-Za-z0-9._~%-]+\/?(?:[?#].*)?$/i.test(url)
);
}

function pageUrl(raw, page) {
raw = decode(raw || '').trim();

if (/^https?:\/\//i.test(raw)) {
return raw;
}

if (raw.indexOf('//') === 0) {
return 'https:' + raw;
}

var origin =
(page.match(/^https?:\/\/[^/]+/i) || [])[0] || base();

if (raw.charAt(0) === '/') {
return origin + raw;
}

return '';
}

function extractLinks(html, page) {
var tags =
html.match(/<(?:a|source|video)\b[^>]*>/gi) || [];

return tags
.map(function (tag) {
return pageUrl(
attr(tag, 'href') || attr(tag, 'src'),
page
);
})
.filter(Boolean);
}

// Anchors paired with the quality of the nearest preceding heading,
// so "480p" buttons on a link page are labelled 480p, etc.
function linksWithQuality(html, page, fallbackQuality) {
var events = [];
var m;

var hre = /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi;
while ((m = hre.exec(html)) !== null) {
var q = text(m[0]).match(/\b(2160p|1080p|1440p|720p|480p|4k|2k)\b/i);
if (q) events.push({ index: m.index, quality: q[1].toUpperCase() });
}

var are = /<a(?=[\s>\/])[^>]*>[\s\S]*?<\/a\s*>/gi;
while ((m = are.exec(html)) !== null) {
var link = anchorHref(m[0], page);
if (link) events.push({ index: m.index, url: link });
}

events.sort(function (a, b) { return a.index - b.index; });

var current = fallbackQuality || 'Auto';
var out = [];

events.forEach(function (e) {
if (e.quality) {
current = e.quality;
} else if (e.url) {
out.push({ url: e.url, quality: current });
}
});

return out;
}

function isFastDl(url) {
return /^https:\/\/(?:www\.)?fastdl\.beer\/(?:embed\?download=[A-Za-z0-9_-]+|dl\.php\?link=https(?:%3A|:))/i.test(url || '');
}

function fastDlRedirect(html) {
var match = String(html || '').match(
/\bvar\s+reurl\s*=\s*["'](https:\/\/fastdl\.beer\/dl\.php\?link=[^"']+)["']/i
);

return match ? decode(match[1]).trim() : '';
}

function nextHost(url) {
if (/^https:\/\/(?:www\.)?vcloud\.beer\//i.test(url)) return true;
if (isFastDl(url)) return true;
if (/^https:\/\/m4ulinks\.[a-z]+\/number\/\d+/i.test(url)) return true;
if (/^https:\/\/m4uplay\.quest\/file\//i.test(url)) return true;
if (/^https:\/\/(?:www\.)?hubcloud\.pw\/drive\//i.test(url)) return true;
if (/^https:\/\/(?:www\.)?gdflix\.(?:vip|io)\/file\//i.test(url)) return true;
if (/^https:\/\/pixeldrain\.dev\/u\/[A-Za-z0-9]+\/?(?:\?.*)?$/i.test(url)) return true;
// Ignore NexDrive navigation/category pages, which contain unrelated files.
return /^https:\/\/(?:www\.)?nexdrive\.beer\/genxfm\d+\/?(?:[?#].*)?$/i.test(url);
}

function qualityFrom(html, fallback) {
var titleTag =
(html.match(/<title\b[^>]*>[\s\S]*?<\/title>/i) || [])[0] || '';

var match = text(titleTag).match(
/\b(2160p|1080p|1440p|720p|480p|4k|2k)\b/i
);

return match
? match[1].toUpperCase()
: (fallback || 'Auto');
}

// File size declared by the host page, shown in stream labels next
// to the quality ("720P · 260 MB"). Matches the FSL "File Size"
// meta row and MovieLinkBD's fa-database meta ("260.04 MB"); pages
// that declare no size simply omit it from the label.
function pageFileSize(html) {
var content = String(html || '');
var match =
content.match(/File\s*Size\s*(?:<[^>]+>\s*)*([\d.,]+\s*(?:TB|GB|MB|KB|B))\b/i) ||
content.match(/fa-database[^>]*><\/i>\s*([\d.,]+\s*(?:TB|GB|MB|KB|B))/i);

return match ? match[1].replace(/\s+/g, ' ').toUpperCase() : '';
}

// Stream priority requested for this plugin:
//   1) FSL Server
//   2) V-Cloud / Direct (incl. G-Direct and plain Direct)
// Remaining hosts keep their previous relative order after these.
function sourcePriority(stream) {
var label = String(stream.source || '');

if (/^FSL Server\b/i.test(label)) return 0;
if (/^V-Cloud \/ Direct\b/i.test(label) || /^G-Direct\b/i.test(label) || /^Direct\b/i.test(label)) return 1;
if (/Pixel\s*Server/i.test(label)) return 3;
if (/^V-Drive\b/i.test(label)) return 4;

return 2;
}

function tokenPage(html, page) {
var match = html.match(
/atob\s*\(\s*atob\s*\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)\s*\)/i
);

if (!match) return '';

try {
var decodedUrl = safeAtob(safeAtob(match[1]));

var cleanPage = page
.split('?')[0]
.split('#')[0];

return decodedUrl.indexOf(cleanPage + '?token=') === 0
? decodedUrl
: '';
} catch (error) {
return '';
}
}

function qualityRank(stream) {
var label = String(stream.source || '').toUpperCase();

if (label.indexOf('2160P') >= 0 || label.indexOf('4K') >= 0) return 2160;
if (label.indexOf('1440P') >= 0 || label.indexOf('2K') >= 0) return 1440;
if (label.indexOf('1080P') >= 0) return 1080;
if (label.indexOf('720P') >= 0) return 720;
if (label.indexOf('480P') >= 0) return 480;

return 0;
}

// Vega Drive share pages require a session and prepare a short-lived URL.
function isVDrive(url) {
return /^https:\/\/one\.vegadrive\.(?:me|app)\/s\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i.test(url || '');
}

async function resolveVDrive(shareUrl) {
var match = String(shareUrl).match(/^https:\/\/one\.vegadrive\.(?:me|app)\/s\/([A-Za-z0-9_-]+)\/?(?:\?.*)?$/i);
if (!match) throw new Error('Unsupported V-Drive share URL');
var id = match[1];
var root = 'https://one.vegadrive.me';
var jar = {};

async function request(url, referer, accept) {
var headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': accept || 'text/html,application/xhtml+xml' };
if (referer) headers.Referer = referer;
var cookies = Object.keys(jar).map(function (key) { return key + '=' + jar[key]; }).join('; ');
if (cookies) headers.Cookie = cookies;
var response = await http_get(url, headers);
if (!response || (response.status && (response.status < 200 || response.status >= 400))) {
throw new Error('V-Drive HTTP ' + (response && response.status));
}
var all = response.headers || {};
var cookieValue = all['set-cookie'] || all['Set-Cookie'] || all['set-Cookie'];
if (cookieValue) {
var list = Array.isArray(cookieValue) ? cookieValue : String(cookieValue).split(/,(?=\s*[^;,\s=]+\s*=)/);
list.forEach(function (c) {
var first = String(c).split(';')[0];
var equal = first.indexOf('=');
if (equal > 0) jar[first.slice(0, equal).trim()] = first.slice(equal + 1).trim();
});
}
return String(response.body || '');
}

var share = root + '/s/' + id;
var intermediate = root + '/d/' + id + '/skydrop';
await request(share);
await request(intermediate, share);
var prepare = root + '/__vega_bridge/prepare/' + id + '?provider=skydrop';
var fetchLink = root + '/download-link/' + id + '/skydrop';
var data;
for (var attempt = 0; attempt < 3; attempt++) {
data = JSON.parse(await request(prepare, intermediate, 'application/json'));
if (data.ready === true) {
if (typeof data.download_url !== 'string') {
data = JSON.parse(await request(fetchLink, intermediate, 'application/json'));
}
if (data.ready === true && typeof data.download_url === 'string') {
// Only accept Google-hosted HTTPS URLs, as Vega Drive's page does.
if (!/^https:\/\/(?:[A-Za-z0-9-]+\.)+(?:googleusercontent|googlevideo)\.com(?::443)?\//i.test(data.download_url)) {
throw new Error('Unexpected V-Drive download host');
}
return data.download_url;
}
}
if (attempt < 2) await new Promise(function (resolve) { setTimeout(resolve, 2000); });
}
throw new Error('V-Drive link not ready');
}

// HubCloud share pages hide the real file behind a "generate link"
// endpoint (gamerxyt.com). That page lists presigned R2 download
// URLs for the file, which the player can stream directly.
function isHubCloud(url) {
return /^https:\/\/(?:www\.)?hubcloud\.pw\/drive\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i.test(url || '');
}

// Combined episode packs (e.g. "Episodes: 13-17") are uploaded as
// ZIP archives. No video player can stream a ZIP, so detect them
// from the original filename shown in the page <title> and report
// them clearly instead of returning unplayable streams.
function isArchiveFile(html) {
var titleTag =
(html.match(/<title\b[^>]*>[\s\S]*?<\/title>/i) || [])[0] || '';

return /\.(zip|rar|7z)$/i.test(text(titleTag));
}

// PixelDrain (PixelServer) file pages. HubCloud mirrors some files
// there; validate each mirror via the metadata API before offering
// it as a stream. Priority: HubCloud first, PixelServer second.
function isPixelDrain(url) {
return /^https:\/\/pixeldrain\.dev\/u\/[A-Za-z0-9]+\/?(?:\?.*)?$/i.test(url || '');
}

async function resolvePixelDrain(shareUrl, metadata) {
var match = String(shareUrl).match(/^https:\/\/pixeldrain\.dev\/u\/([A-Za-z0-9]+)/i);
if (!match) throw new Error('Unsupported PixelDrain URL');
var id = match[1];

var response = await http_get(
'https://pixeldrain.dev/api/file/' + id + '/info',
{ 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
);

if (!response || response.status < 200 || response.status >= 300) {
throw new Error('PixelDrain metadata HTTP ' + (response && response.status));
}

var info = JSON.parse(String(response.body || ''));
var mime = String((info && info.mime_type) || '');

if (/zip|rar|7z/i.test(mime)) {
throw new Error('Archive pack (ZIP) cannot be streamed');
}

if (!info || info.success !== true || info.can_download === false || !/^video\//i.test(mime)) {
throw new Error('PixelDrain file is not a playable video');
}

if (metadata && Number(info.size) > 0) metadata.size = formatFileSize(Number(info.size));
return 'https://pixeldrain.dev/api/file/' + id;
}

function formatFileSize(bytes) {
if (!(bytes > 0)) return '';
var units = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
return (i ? bytes.toFixed(2).replace(/\.00$/, '') : String(bytes)) + ' ' + units[i];
}

async function resolveHubCloud(shareUrl) {
var html = await get(shareUrl);

if (isArchiveFile(html)) {
throw new Error('Archive pack (ZIP) cannot be streamed');
}

var urls = [];
var pixelIds = [];
var serverNames = {};
// The share page describes the file represented by its server mirrors.
var sizeMatch = html.match(/File\s*Size\s*(?:<[^>]+>\s*)*([\d.,]+\s*(?:TB|GB|MB|KB|B))\b/i);
var fileSize = sizeMatch ? sizeMatch[1].replace(/\s+/g, ' ').toUpperCase() : '';

function collect(source) {
anchorsIn(source).forEach(function (anchor) {
var href = anchorHref(anchor, shareUrl);
var label = text(anchor);
if (/FSL\s*(?:SERVER\s*)?V\s*2|FSLV2/i.test(label)) serverNames[href] = 'FSL Server V2';
else if (/FSL\s*SERVER/i.test(label)) serverNames[href] = 'FSL Server';
});
var re = /https:\/\/[A-Za-z0-9-]+\.r2\.cloudflarestorage\.com\/[^\s"'<>]+/gi;
var m;
while ((m = re.exec(source)) !== null) {
var u = decode(m[0]);
if (urls.indexOf(u) < 0) urls.push(u);
}
var pixelRe = /https:\/\/pixeldrain\.dev\/u\/([A-Za-z0-9]+)/gi;
while ((m = pixelRe.exec(source)) !== null) {
if (pixelIds.indexOf(m[1]) < 0) pixelIds.push(m[1]);
}
}

collect(html);

var match = html.match(/https:\/\/gamerxyt\.com\/hubcloud\.php\?[^\s"'<>]+/i);
if (match) {
collect(await get(decode(match[0])));
}

if (!urls.length) {
// Last resort: the hbplay player link carries the direct URL
// Base64-encoded in its `u` parameter.
var hb = html.match(/hbplay\.pages\.dev\/\?u=([A-Za-z0-9+/=_-]+)/i);
if (hb) {
try {
var decoded = safeAtob(hb[1].replace(/-/g, '+').replace(/_/g, '/'));
if (/^https:\/\//i.test(decoded)) urls.push(decoded);
} catch (error) {
console.error('Could not decode HubCloud player URL: ' + String(error));
}
}
}

// PixelDrain mirrors are second priority: validate each one via
// the metadata API and append its direct URL after HubCloud's.
for (var i = 0; i < pixelIds.length; i++) {
try {
urls.push(await resolvePixelDrain('https://pixeldrain.dev/u/' + pixelIds[i]));
} catch (error) {
console.error('PixelDrain mirror skipped: ' + String(error));
}
}

if (!urls.length) {
throw new Error('HubCloud direct link not found');
}

return urls.map(function (u) {
return { url: u, source: /^https:\/\/pixeldrain\.dev\/api\/file\//i.test(u) ? 'Pixel Server' : (serverNames[u] || 'HubCloud'), size: fileSize };
});
}

// GDFlix pages do not expose a clean direct URL (their buttons lead
// to ad redirects), so only accept links that already look like
// direct media files.
function isGdflix(url) {
return /^https:\/\/(?:www\.)?gdflix\.(?:vip|io)\/file\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i.test(url || '');
}

async function resolveGdflix(shareUrl) {
var html = await get(shareUrl);

if (isArchiveFile(html)) {
throw new Error('Archive pack (ZIP) cannot be streamed');
}

var urls = [];
var re = /https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mkv)(?:\?[^\s"'<>]*)?/gi;
var m;

while ((m = re.exec(html)) !== null) {
var u = decode(m[0]);
if (mediaUrl(u) && urls.indexOf(u) < 0) urls.push(u);
}

if (!urls.length) {
throw new Error('GDFlix direct link not found');
}

return urls;
}

// =====================================
// LOAD STREAMS
// =====================================

async function loadStreams(url, callback) {
await ensureBase();
url = normalizeSiteUrl(url);

try {
var marker = '#skyepisode=';
var markerIndex = url.indexOf(marker);
var episodeLinks = null;

if (markerIndex >= 0) {
episodeLinks = JSON.parse(
decodeURIComponent(url.slice(markerIndex + marker.length))
);

url = url.slice(0, markerIndex);

if (!isSourcePage(url) || !Array.isArray(episodeLinks)) {
throw new Error('Invalid episode data');
}
}

if (!episodeLinks && mediaUrl(url)) {
return callback({
success: true,
data: [
new StreamResult({
url: url,
source: 'Direct',
quality: 'Auto'
})
]
});
}

if (!isSourcePage(url) && !nextHost(url) && !isVDrive(url)) {
throw new Error('Unsupported page URL');
}

var seenPages = {};
var seenStreams = {};
var found = [];
var failures = 0;
var archiveOnly = false;
var vdriveCandidates = [];
var gdflixCandidates = [];

function addStream(streamUrl, source, quality, headers) {
if (!streamUrl || seenStreams[streamUrl]) return;
seenStreams[streamUrl] = true;
found.push(new StreamResult({
url: streamUrl,
source: source,
quality: quality,
headers: headers
}));
}

async function scan(page, depth, quality) {
if (seenPages[page] || depth > 3) {
return;
}

seenPages[page] = true;

var html;

try {
html = await get(page);
} catch (error) {
failures++;

var host =
(page.match(/^https?:\/\/([^/]+)/i) || [])[1];

console.error(
'Host request failed: ' +
(host || 'unknown host') +
', step=' + depth +
', error=' + String(error)
);

return;
}

quality = qualityFrom(html, quality);

// HubCloud / GDFlix share pages are resolved to direct file URLs
// instead of being scanned for more links.
if (isHubCloud(page)) {
try {
var hubUrls = await resolveHubCloud(page);
hubUrls.forEach(function (entry) {
var label = entry.source + ' (' + quality + (entry.size ? ' · ' + entry.size : '') + ')';
addStream(entry.url, label, quality);
});
} catch (error) {
if (/Archive pack/i.test(String(error))) {
archiveOnly = true;
} else {
failures++;
console.error('HubCloud resolve failed: ' + String(error));
}
}
return;
}

if (isPixelDrain(page)) {
try {
var pixelMetadata = {};
var pixelUrl = await resolvePixelDrain(page, pixelMetadata);
addStream(pixelUrl, 'Pixel Server (' + quality + (pixelMetadata.size ? ' · ' + pixelMetadata.size : '') + ')', quality);
} catch (error) {
if (/Archive pack/i.test(String(error))) {
archiveOnly = true;
} else {
console.error('PixelDrain resolve skipped: ' + String(error));
}
}
return;
}

if (isGdflix(page)) {
try {
var gdUrls = await resolveGdflix(page);
gdUrls.forEach(function (u) {
addStream(u, 'GDFlix (' + quality + ')', quality);
});
} catch (error) {
if (/Archive pack/i.test(String(error))) {
archiveOnly = true;
} else {
// GDFlix usually needs a browser; HubCloud is the primary host.
console.error('GDFlix resolve skipped: ' + String(error));
}
}
return;
}

var links = linksWithQuality(html, page, quality);

// MovieLinkBD keeps real targets in encrypted data-dl anchors
// (href="#"); decode them so the /file/ chain can be followed.
var dlAnchors =
html.match(/<a(?=[\s>\/])[^>]*data-dl=["'][^"']+["'][^>]*>[\s\S]*?<\/a\s*>/gi) || [];

dlAnchors.forEach(function (anchor) {
var openA = (anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';
var decoded = decodeDataDl(openA);
if (!decoded) return;

var label = text(anchor);
if (/zip/i.test(label)) return;

var qm = label.match(/\b(2160p|1440p|1080p|720p|480p|4k|2k)\b/i);
links.push({
url: absolute(decoded),
quality: qm ? qm[1].toUpperCase() : quality
});
});

var next = [];
var pixelCandidates = [];
// Only explicit V-Drive download buttons, not arbitrary navigation links.
var vdriveButtons = (html.match(/<a(?=[\s>\/])[^>]*>[\s\S]*?<\/a\s*>/gi) || []).filter(function (anchor) {
return /v\s*-?\s*drive/i.test(text(anchor));
}).map(function (anchor) {
return anchorHref(anchor, page);
});

if (/^https:\/\/(?:www\.)?vcloud\.beer\//i.test(page)) {
var tokenUrl = tokenPage(html, page);

if (tokenUrl) {
links.push({ url: tokenUrl, quality: quality });
}

// Some V-Cloud pages replace a placeholder PixelServer href using
// `var pxl = "..."; document.getElementById("pxl-1").href = pxl;`.
// Read only this constrained pattern; never execute remote scripts.
if (/document\.getElementById\s*\(\s*["']pxl-1["']\s*\)\s*\.href\s*=\s*pxl\s*;/i.test(html)) {
var pixelAssignment = html.match(/\b(?:var|let|const)\s+pxl\s*=\s*["'](https:\/\/pixeldrain\.dev\/u\/[A-Za-z0-9]+\/?)["']/i);
if (pixelAssignment) links.push({ url: pixelAssignment[1], quality: quality });
}
}

// FastDL embeds use a JavaScript redirect rather than an anchor.
// Read the constrained reurl assignment; never execute page scripts.
if (isFastDl(page)) {
var fastDlPage = fastDlRedirect(html);
if (fastDlPage) links.push({ url: fastDlPage, quality: quality });
}

links.forEach(function (entry) {
var link = entry.url;
var linkQuality = entry.quality || quality;

if (mediaUrl(link)) {
var mediaSource = 'V-Cloud / Direct';

if (isFastDl(page)) {
mediaSource = 'G-Direct';
} else if (/^https?:\/\/(?:[A-Za-z0-9.-]+\.workers\.dev\/d\/|fsl\.[A-Za-z0-9.-]+\/d\/)/i.test(link)) {
mediaSource = 'FSL Server';
}

// Show quality + file size together when the page declares one.
var streamSize = pageFileSize(html);

addStream(
link,
mediaSource + ' (' + linkQuality + (streamSize ? ' · ' + streamSize : '') + ')',
linkQuality,
{ Referer: page }
);
} else if (/^https:\/\/(?:www\.)?vcloud\.beer\//i.test(page) &&
/^https:\/\/pixeldrain\.dev\/u\/[A-Za-z0-9]+\/?(?:[?#].*)?$/i.test(link)) {
var pixelId = link.match(/^https:\/\/pixeldrain\.dev\/u\/([A-Za-z0-9]+)/i)[1];
if (pixelCandidates.indexOf(pixelId) < 0) pixelCandidates.push(pixelId);
} else if (isVDrive(link) && vdriveButtons.indexOf(link) >= 0) {
if (!vdriveCandidates.some(function (candidate) { return candidate.url === link; })) {
vdriveCandidates.push({ url: link, quality: linkQuality });
}
} else if (isGdflix(link)) {
// GDFlix is only a backup: HubCloud on the same page is preferred.
if (!gdflixCandidates.some(function (candidate) { return candidate.url === link; })) {
gdflixCandidates.push({ url: link, quality: linkQuality });
}
} else if (
depth < 3 &&
(nextHost(link) || isFilePage(link)) &&
!seenPages[link] &&
next.indexOf(link) < 0
) {
next.push(link);
}
});

// V-Cloud pages can contain unrelated or dead PixelServer links.
// Validate each file using its small metadata response, never the
// video body - sequentially, so requests never overlap.
for (var pc = 0; pc < Math.min(pixelCandidates.length, 8); pc++) {
try {
var infoUrl = 'https://pixeldrain.dev/api/file/' + pixelCandidates[pc] + '/info';
var response = await http_get(infoUrl, { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' });
if (!response || response.status < 200 || response.status >= 300) continue;
var info = JSON.parse(String(response.body || ''));
if (!info || info.success !== true || info.can_download === false ||
!/^video\//i.test(String(info.mime_type || ''))) continue;
var pixelVideo = 'https://pixeldrain.dev/api/file/' + pixelCandidates[pc];
var pixelSize = formatFileSize(Number(info.size));
addStream(pixelVideo, 'V-Cloud / Pixel Server (' + quality + (pixelSize ? ' · ' + pixelSize : '') + ')', quality);
} catch (error) {
console.error('PixelServer metadata check failed: ' + String(error));
}
}

var limited = next.slice(0, 8);

// Sequential crawl of the next hop: parallel scans trip the
// runtime's HTTP layer (500 for every request but the first).
for (var i = 0; i < limited.length; i++) {
await scan(limited[i], depth + 1, quality);
}
}

var initialQualityMatch = url.match(/[?&]quality=([^&]+)/i);
var initialQuality = initialQualityMatch
? decodeURIComponent(initialQualityMatch[1])
: 'Auto';

if (episodeLinks) {
var validLinks = episodeLinks.filter(function (entry) {
return entry && (nextHost(entry.url) || isVDrive(entry.url) || isFilePage(entry.url));
});

// Remove secondary mirrors before limiting, so they do not crowd out
// different qualities. Reserve one slot per quality before filling the rest.
if (validLinks.some(function (entry) { return isHubCloud(entry.url); })) {
validLinks = validLinks.filter(function (entry) { return !isGdflix(entry.url); });
}
var qualityFirst = [], remaining = [], seenQuality = {};
validLinks.forEach(function (entry) {
var key = String(entry.quality || 'Auto').toUpperCase();
if (!seenQuality[key]) {
seenQuality[key] = true;
qualityFirst.push(entry);
} else {
remaining.push(entry);
}
});
validLinks = qualityFirst.concat(remaining).slice(0, 8);

validLinks.forEach(function (entry) {
if (isVDrive(entry.url)) vdriveCandidates.push(entry);
});

var scanLinks = validLinks.filter(function (entry) {
return !isVDrive(entry.url);
});

for (var sl = 0; sl < scanLinks.length; sl++) {
await scan(
scanLinks[sl].url,
0,
String(scanLinks[sl].quality || 'Auto')
);
}
} else if (isVDrive(url)) {
vdriveCandidates.push({ url: url, quality: 'Auto' });
} else {
await scan(url, 0, initialQuality);
}

// GDFlix is tried only when HubCloud produced nothing.
if (!found.length && gdflixCandidates.length) {
var gdFallback = gdflixCandidates.slice(0, 4);
for (var g = 0; g < gdFallback.length; g++) {
try {
var gdUrls = await resolveGdflix(gdFallback[g].url);
gdUrls.forEach(function (u) {
var label = String(gdFallback[g].quality || 'Auto');
addStream(u, 'GDFlix (' + label + ')', label);
});
} catch (error) {
if (/Archive pack/i.test(String(error))) {
archiveOnly = true;
} else {
console.error('GDFlix fallback failed: ' + String(error));
}
}
}
}

// Offer V-Drive after V-Cloud as a playback backup. Playback failures occur
// in the player after this function returns and cannot be detected here.
if (vdriveCandidates.length) {
var fallback = vdriveCandidates.slice(0, 8);
for (var j = 0; j < fallback.length; j++) {
try {
var video = await resolveVDrive(fallback[j].url);
var label = String(fallback[j].quality || 'Auto');
addStream(video, 'V-Drive (' + label + ')', label);
} catch (error) {
failures++;
console.error('V-Drive fallback failed: ' + String(error));
}
}
}

if (!found.length && archiveOnly) {
return callback({
success: false,
errorCode: 'UNKNOWN_ERROR',
message:
'These episodes are uploaded as a ZIP pack (multiple ' +
'episodes in one archive file), which cannot be streamed ' +
'in the app. Please download the ZIP from the website ' +
'to watch these episodes.'
});
}

if (!found.length && failures) {
return callback({
success: false,
errorCode: 'UNKNOWN_ERROR',
message:
'No direct stream found; a host page could not ' +
'be loaded. Browser verification or an unsupported ' +
'host may be required.'
});
}

var sortedStreams = found
.filter(function (stream) {
return qualityRank(stream) !== 480;
})
.sort(function (a, b) {
// Priority first (FSL -> V-Cloud/Direct -> the rest), quality
// ordering inside each priority tier.
var priorityA = sourcePriority(a);
var priorityB = sourcePriority(b);

if (priorityA !== priorityB) return priorityA - priorityB;

var rankA = qualityRank(a);
var rankB = qualityRank(b);

if (rankA === 0) {
return rankB === 0 ? 0 : 1;
}

if (rankB === 0) {
return -1;
}

return rankA - rankB;
});

callback({
success: true,
data: sortedStreams
});
} catch (error) {
fail(callback, error);
}
}

// =====================================
// SKYSTREAM EXPORTS
// =====================================

globalThis.getHome = getHome;
globalThis.search = search;
globalThis.load = load;
globalThis.loadStreams = loadStreams;
})();
