/*
* SkyStream Movies4u provider (fixed)
* Use only media you are authorized to access.
*
* Fixes vs. the previous version:
*  - Home listings no longer depend on the removed #moviesGridMain element.
*    The site now renders posts as <article class="post"> cards, so the
*    parser reads those (with the old grid kept as a fallback).
*  - Home sections are now: Latest Release, TV Shows, Web Series and
*    Hollywood Movies, using the site's real /category/... URLs. The old
*    /web-series/netflix/ etc. paths redirect to random posts or 404.
*  - Search uses the new /lookup.php endpoint (the old /ts-search.php
*    returns 404) and its flat hits[] shape.
*  - Series episodes and streams follow the site's current chain:
*    post page -> m4ulinks.sbs -> hubcloud.pw / gdflix.vip -> direct
*    R2 links. The legacy nexdrive/vcloud/fastdl/vegadrive handling is
*    kept for older posts.
*/

(function () {
'use strict';

function base() {
return String(
manifest.baseUrl || 'https://new6.movies4u.garden/'
).replace(/\/+$/, '');
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

function normalizeVegaUrl(url) {
return String(url || '')
.replace(
/^https?:\/\/(?:www\.)?(?:vegamovies\.lease|movies4u\.foo)(?=\/|$)/i,
base()
);
}

function absolute(url) {
url = decode(url || '').trim();

if (/^https?:\/\//i.test(url)) {
return normalizeVegaUrl(url);
}

if (url.indexOf('//') === 0) {
return normalizeVegaUrl('https:' + url);
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
return String(url || '').replace(
/^(https:\/\/image\.tmdb\.org\/t\/p\/)[a-z0-9]+(\/[A-Za-z0-9]+\.(?:jpe?g|png|webp))$/i,
'$1' + size + '$2'
);
}

function isSourcePage(url) {
return url.indexOf(base() + '/') === 0;
}

// Post pages live at the site root (/some-movie-slug/). Category,
// pagination and WordPress system paths are not playable posts.
function isPostPage(url) {
if (!isSourcePage(url)) return false;

var path = url.slice(base().length + 1);

return !/^(category|page|wp-|search|author|tag|date|feed|comments|privacy|terms|contact|about|dmca|how-to-download)(\/|$)/i.test(path);
}

async function get(url) {
var response = await http_get(url, {
'User-Agent': 'Mozilla/5.0',
'Accept': 'text/html,application/xhtml+xml'
});

if (
!response ||
(
response.status &&
(response.status < 200 || response.status >= 400)
)
) {
throw new Error(
'HTTP request failed: ' +
(response && response.status)
);
}

return String(response.body || '');
}

function cleanTitle(value) {
return text(value)
.replace(/^download\s+/i, '')
.trim();
}

function kind(title, url) {
// Short carousel titles often contain only the name and year. The
// post URL still contains "season" or "series", so inspect both.
var value = String(title || '') + ' ' + String(url || '');

return /\b(series|season|episodes?|s\d{1,2}e\d{1,3}|tv[ -]?shows?|reality[ -]?shows?|game[ -]?shows?|talk[ -]?shows?|k[ -]?dramas?|c[ -]?dramas?)\b/i.test(value)
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

// The redesigned site renders every post as an <article class="post">
// card. Parse those blocks so navigation, ads and "You May Also Like"
// sidebars are never picked up. The legacy #moviesGridMain grid is
// kept as a fallback for older cached pages.
function listingScope(html) {
var articles =
html.match(/<article\b[^>]*class=["'][^"']*\bpost\b[^"']*["'][^>]*>[\s\S]*?<\/article\s*>/gi);

if (articles && articles.length) {
return articles.join('\n');
}

var gridPattern = /<div\b(?=[^>]*\bid=["']moviesGridMain["'])[^>]*>/i;
var grid = gridPattern.exec(html);

if (grid) {
var start = grid.index + grid[0].length;
var remainder = html.slice(start);
var end = /<\/section\s*>|<nav\b[^>]*class=["'][^"']*pagination/i.exec(remainder);

return remainder.slice(0, end ? end.index : remainder.length);
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
scope.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];

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

if (!title || !poster) return;

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
// The site moved its search API from /ts-search.php (now 404) to
// /lookup.php, and hits are flat objects instead of hits[].document.
var url =
base() +
'/lookup.php?q=' +
encodeURIComponent(term) +
'&page=' +
pageNumber +
'&per_page=30';

var response = JSON.parse(await get(url));

if (!response || !Array.isArray(response.hits)) {
throw new Error('Unexpected search response');
}

var seen = {};

return response.hits
.map(function (hit) {
// Support both the new flat shape and the legacy document shape.
var document =
hit && hit.document
? hit.document
: (hit || {});

var href = absolute(document.permalink || '');
var title = cleanTitle(document.post_title || '');

var poster = absolute(
document.post_thumbnail ||
'/wp-content/uploads/2022/10/not-available.jpg'
);

if (!isPostPage(href) || !title || seen[href]) {
return null;
}

seen[href] = true;

return new MultimediaItem({
title: title,
url: href,
posterUrl: poster,
type: kind(title, href),
year: yearOf(title)
});
})
.filter(function (item) {
return item !== null;
});
}

// =====================================
// HOME
// =====================================

async function getHome(callback) {
var sections = [
{ name: 'Latest Release', path: '/' },
{ name: 'TV Shows', path: '/category/tv-shows/' },
{ name: 'Web Series', path: '/category/web-series/' },
{
name: 'Hollywood Movies',
path: '/category/hollywood-movies/'
}
];

try {
var results = await Promise.all(
sections.map(async function (section) {
try {
var items = listings(
await get(base() + section.path)
);

return { items: items, error: null };
} catch (error) {
console.error(
'Home section ' +
section.name +
': ' +
String(error)
);

return { items: [], error: error };
}
})
);

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
return html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
}

function anchorHref(anchor, page) {
var tag = (anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';
return pageUrl(attr(tag, 'href'), page);
}

async function seriesEpisodes(html, seriesUrl) {
var titleTag = (html.match(/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/i) || [])[0] || '';
var fallbackSeasonMatch = text(titleTag).match(/\bseason\s*(\d+)\b|\bs0*(\d+)/i);
var fallbackSeason = fallbackSeasonMatch ? Number(fallbackSeasonMatch[1] || fallbackSeasonMatch[2]) : 1;

// 1. Find the download groups on the post page: one m4ulinks.sbs
//    link page per quality (legacy posts used nexdrive.beer).
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
var isNewHost = /^https:\/\/m4ulinks\.sbs\/number\/\d+/i.test(link);
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
//    episode. New pages list "-:Episodes: N:-" headings followed
//    by HubCloud / GDFlix buttons.
var pages = [];
for (var start = 0; start < Math.min(groups.length, 12); start += 3) {
var batch = await Promise.all(groups.slice(start, start + 3).map(async function (group) {
try { return { group: group, html: await get(group.url) }; }
catch (e) { console.error('Episode list request failed: ' + String(e)); return null; }
}));
pages = pages.concat(batch);
}

function add(group, first, last, links) {
if (!first || !links.length) return;
last = last || first;
var key = group.season + ':' + first + ':' + last;
if (!entries[key]) entries[key] = { season: group.season, first: first, last: last, links: [] };
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

add(page.group, Number(ep[1]), ep[2] ? Number(ep[2]) : Number(ep[1]), links);
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
add(page.group, 1, 1, links);
}
});

return Object.keys(entries).map(function (key) {
var ep = entries[key];
var name = ep.first === ep.last ? 'Episode ' + ep.first : 'Episodes ' + ep.first + '–' + ep.last + ' (combined file)';
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

// =====================================
// MOVIE / SERIES DETAILS
// =====================================

async function load(url, callback) {
url = normalizeVegaUrl(url);

try {
if (!isSourcePage(url)) {
throw new Error('Not a page on the configured site');
}

var html = await get(url);

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
/^https:\/\/(?:[A-Za-z0-9-]+\.)+(?:googleusercontent|googlevideo)\.com\//i.test(url)
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

var are = /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi;
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
if (/^https:\/\/m4ulinks\.sbs\/number\/\d+/i.test(url)) return true;
if (/^https:\/\/m4uplay\.quest\/file\//i.test(url)) return true;
if (/^https:\/\/(?:www\.)?hubcloud\.pw\/drive\//i.test(url)) return true;
if (/^https:\/\/(?:www\.)?gdflix\.(?:vip|io)\/file\//i.test(url)) return true;
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

async function resolveHubCloud(shareUrl) {
var html = await get(shareUrl);

if (isArchiveFile(html)) {
throw new Error('Archive pack (ZIP) cannot be streamed');
}

var urls = [];

function collect(source) {
var re = /https:\/\/[A-Za-z0-9-]+\.r2\.cloudflarestorage\.com\/[^\s"'<>]+/gi;
var m;
while ((m = re.exec(source)) !== null) {
var u = decode(m[0]);
if (urls.indexOf(u) < 0) urls.push(u);
}
}

collect(html);

if (!urls.length) {
var match = html.match(/https:\/\/gamerxyt\.com\/hubcloud\.php\?[^\s"'<>]+/i);
if (match) {
collect(await get(decode(match[0])));
}
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

if (!urls.length) {
throw new Error('HubCloud direct link not found');
}

return urls;
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
url = normalizeVegaUrl(url);

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
hubUrls.forEach(function (u) {
addStream(u, 'HubCloud (' + quality + ')', quality);
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
var next = [];
var pixelCandidates = [];
// Only explicit V-Drive download buttons, not arbitrary navigation links.
var vdriveButtons = (html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || []).filter(function (anchor) {
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
addStream(
link,
(isFastDl(page) ? 'G-Direct' : 'V-Cloud / Direct') + ' (' + linkQuality + ')',
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
nextHost(link) &&
!seenPages[link] &&
next.indexOf(link) < 0
) {
next.push(link);
}
});

// V-Cloud pages can contain unrelated or dead PixelServer links.
// Validate each file using its small metadata response, never the video body.
await Promise.all(pixelCandidates.slice(0, 8).map(async function (id) {
try {
var infoUrl = 'https://pixeldrain.dev/api/file/' + id + '/info';
var response = await http_get(infoUrl, { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' });
if (!response || response.status < 200 || response.status >= 300) return;
var info = JSON.parse(String(response.body || ''));
if (!info || info.success !== true || info.can_download === false ||
!/^video\//i.test(String(info.mime_type || ''))) return;
var pixelVideo = 'https://pixeldrain.dev/api/file/' + id;
addStream(pixelVideo, 'V-Cloud / PixelServer (' + quality + ')', quality);
} catch (error) {
console.error('PixelServer metadata check failed: ' + String(error));
}
}));

var limited = next.slice(0, 8);

for (var i = 0; i < limited.length; i += 2) {
await Promise.all(
limited.slice(i, i + 2).map(function (link) {
return scan(link, depth + 1, quality);
})
);
}
}

var initialQualityMatch = url.match(/[?&]quality=([^&]+)/i);
var initialQuality = initialQualityMatch
? decodeURIComponent(initialQualityMatch[1])
: 'Auto';

if (episodeLinks) {
var validLinks = episodeLinks
.filter(function (entry) {
return entry && (nextHost(entry.url) || isVDrive(entry.url));
})
.slice(0, 8);

// GDFlix rejects non-browser requests (403), so only use it when
// the episode has no HubCloud link.
if (validLinks.some(function (entry) { return isHubCloud(entry.url); })) {
validLinks = validLinks.filter(function (entry) { return !isGdflix(entry.url); });
}

validLinks.forEach(function (entry) {
if (isVDrive(entry.url)) vdriveCandidates.push(entry);
});
await Promise.all(
validLinks.filter(function (entry) { return !isVDrive(entry.url); }).map(function (entry) {
return scan(entry.url, 0, String(entry.quality || 'Auto'));
})
);
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
var rankA = qualityRank(a);
var rankB = qualityRank(b);

if (rankA === 0) {
return rankB === 0 ? 0 : 1;
}

if (rankB === 0) {
return -1;
}

if (rankA !== rankB) return rankA - rankB;
function sourceRank(stream) {
var label = String(stream.source || '');
return /^V-Drive\b/i.test(label) ? 2 : /PixelServer/i.test(label) ? 1 : 0;
}
return sourceRank(a) - sourceRank(b);
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
