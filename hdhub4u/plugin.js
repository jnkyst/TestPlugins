/*
* SkyStream HDHub4u provider
* Use only media you are authorized to access.
*
* ── ONE SETTING: manifest.baseUrl ──────────────────────────────
* plugin.json keeps baseUrl = https://hdhub4u.kz/
* That domain is HDHub4u's entry point. When it serves the real
* site the plugin uses it directly; when it only serves the
* promo/landing page (as it does today) the plugin asks HDHub4u's
* own mirror service which mirror is live and uses that origin for
* every request. Nothing else has to be edited when the mirror
* moves again – see resolveOrigin().
*
* ── HOME SCREEN LAYOUT ────────────────────────────────────────
*   Latest Release            ->  /
*   TV Shows · Netflix        ->  /category/netflix/
*   TV Shows · Amazon Prime   ->  /category/amazon-prime-video/
*   TV Shows · JioHotstar     ->  /category/jiohotstar/
*   TV Shows · SonyLiv        ->  /category/sonyliv/
* All of it lives in HOME_LAYOUT below.
*
* ── STREAM LIST ───────────────────────────────────────────────
* A movie / pack page is expanded into one stream per server and the
* app shows quality + server + file size, e.g.
*   [2160p] FSLv2 Server · 22.88 GB
*   [1080p] HubCloud Server · 3.13 GB
*   [1080p] Pixel Server · 8.96 GB
* Servers come from HDHub4u's generated page (HubCloud / FSL /
* FSLv2 / Pixel); a server that is dead or missing is skipped.
* Rows are ordered 720P, then 1080P, then 2160P, and inside a
* resolution FSL -> FSLv2 -> Pixel -> HubCloud.
*
* STREAM_SOURCE picks the family that is listed: the PlayDrive player
* by default, the HubDrive file servers, or both.
*
* A player stream is listed as one "Auto" row pointing at the HLS
* master: SkyStream then offers the resolutions itself (Quality tab)
* and keeps every audio track, and the subtitle playlists found in
* the master are attached to the stream. Splitting the master into
* per-resolution rows loses both (set SPLIT_QUALITIES = true to try).
*
* HubDrive packs count too: a pack page (hubdrive /packs/<id>) lists
* one file per episode, so every episode is matched to its own file
* and offers those servers next to its player stream.
* Episodes that only offer a player page keep their HLS stream.
*
* ── PLAYBACK CHAINS (HDHub4u's own hosts) ─────────────────────
* Movies / packs:
*   post page -> hubdrive.* /file/<id>
*             -> hubcloud.* /drive/<id>
*             -> gamerxyt.com/hubcloud.php?...  (Generate link)
*             -> Cloudflare R2 presigned URL (direct mp4/mkv)
*             + optional pixeldrain mirror
*
* Series episodes:
*   post page -> playdrive.* /e/<id>/s-XX/ep-YY  (watch button)
*             -> play4u.org /series/<slug>/s-XX/ep-YY
*             -> window.__PA_PLAY__ / __PA_SERIES__
*             -> m3u8_url sealed as "pa!~<base64url>"
*             -> XOR with window.__PA_SEAL_KEY__ -> HLS master
*   The HLS URL only answers when the Referer is play4u.org, so the
*   stream is returned with that header attached.
*
* Download-only hosts (greenmotors.* token redirect, hdstream4u.*,
* hubstream.*) are ad-gated / packed scripts. They are recognised
* so the app can explain the situation instead of failing silently.
*/

(function () {
'use strict';

try {
  console.log('[Hdhub4u] plugin.js loaded');
} catch (error) {
  // host without console: continue silently
}

// =====================================
// HOME SCREEN LAYOUT  <-- edit me
// =====================================

var SHORT_TITLES = false; // false = keep the full scene-style titles

// Which sources the stream list shows:
//   'hubdrive'  = HubDrive file servers only (default)
//                 720P / 1080P / 2160P rows with their file size
//   'playdrive' = the PlayDrive player only
//   'all'       = both
var STREAM_SOURCE = 'hubdrive';

// false = one "Auto" row per stream: SkyStream then reads the HLS
//         master itself, so the player gets a Quality tab (Auto /
//         1080P / 720P) and keeps every audio track and subtitle.
// true  = one row per resolution. Those rows are plain video
//         playlists, so the separate audio tracks and subtitles of
//         the master are not available on them.
var SPLIT_QUALITIES = false;

var HOME_LAYOUT = {
  latest: {
    title: 'Latest Release',
    path: '/',
    limit: 40
  },
  tvShows: {
    title: 'TV Shows',
    limit: 20,
    // true  -> "TV Shows · Netflix"
    // false -> "Netflix"
    grouped: true,
    // true  -> keep only series in these rows
    seriesOnly: false,
    channels: [
      { title: 'Netflix', path: '/category/netflix/' },
      { title: 'Amazon Prime', path: '/category/amazon-prime-video/' },
      { title: 'JioHotstar', path: '/category/jiohotstar/' },
      { title: 'SonyLiv', path: '/category/sonyliv/' }
    ]
  }
};

// How long a resolved mirror is trusted before asking again.
var ORIGIN_TTL_MS = 10 * 60 * 1000;

// HDHub4u's mirror service. The site's own landing page asks these
// endpoints and gets { h: <host>, c: <full site url> } back, both
// base64 encoded. Order matters: first working answer wins.
var MIRROR_ENDPOINTS = [
  'https://h4.suncdn.org/host/',
  'https://points.topapii.com/host/',
  'https://ml.theapii.org/host/',
  'https://dns.pingora.fyi/v2/host'
];

// No request may run forever: one dead mirror host used to stall
// getHome() and the plugin test printed "No Output".
var TIMEOUT = {
  page: 12000,    // listing / post pages
  mirror: 6000,   // mirror lookup endpoints
  host: 12000,    // file / player hosts
  watchdog: 60000 // absolute cap for getHome()
};

function log(message) {
  try {
    console.log('[Hdhub4u] ' + message);
  } catch (error) {
    // logging must never break a request
  }
}

// Same as log(), for messages that used to go to console.error().
// Routed through a function so a host without a console can never
// turn a catch block into a second, uncaught throw.
function reportError(message) {
  log('error: ' + message);
}

// Wrap a promise in a deadline. Uses setTimeout when the host has it.
function withTimeout(promise, ms, label) {
  if (typeof setTimeout !== 'function' || !ms) return promise;

  return new Promise(function (resolve, reject) {
    var settled = false;

    var timer = setTimeout(function () {
      if (settled) return;

      settled = true;
      reject(new Error('Timed out after ' + Math.round(ms / 1000) + 's' +
        (label ? ' (' + label + ')' : '')));
    }, ms);

    promise.then(function (value) {
      if (settled) return;

      settled = true;
      if (typeof clearTimeout === 'function') clearTimeout(timer);
      resolve(value);
    }, function (error) {
      if (settled) return;

      settled = true;
      if (typeof clearTimeout === 'function') clearTimeout(timer);
      reject(error);
    });
  });
}

// =====================================
// SMALL HELPERS
// =====================================

function base() {
return String(manifest.baseUrl || '').replace(/\/+$/, '');
}

function originHost(url) {
return String(url || '')
.replace(/^https?:\/\//i, '')
.split('/')[0]
.toLowerCase();
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
.replace(/&nbsp;/gi, ' ');
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

var match = String(tag || '').match(new RegExp(pattern, 'i'));

return match
? decode(match[1] || match[2] || match[3] || '')
: '';
}

// Base64 decode that also works when the host engine has no atob().
var B64_CHARS =
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

function safeAtob(value) {
var input = String(value || '')
.replace(/-/g, '+')
.replace(/_/g, '/')
.replace(/\s/g, '');

var pad = input.length % 4;
while (pad > 0 && pad < 4) {
input += '=';
pad++;
}

if (typeof atob === 'function') {
try {
return atob(input);
} catch (error) {
// fall through to the manual decoder
}
}

var output = '';
var i = 0;

while (i < input.length) {
var a = B64_CHARS.indexOf(input.charAt(i++));
var b = B64_CHARS.indexOf(input.charAt(i++));
var c = B64_CHARS.indexOf(input.charAt(i++));
var d = B64_CHARS.indexOf(input.charAt(i++));

if (a < 0 || b < 0) break;

var n = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);

output += String.fromCharCode((n >> 16) & 255);
if (c !== 64 && c >= 0) output += String.fromCharCode((n >> 8) & 255);
if (d !== 64 && d >= 0) output += String.fromCharCode(n & 255);
}

return output;
}

// play4u seals stream URLs as "pa!~" + base64url(XOR(payload, key)).
function unseal(value, key) {
var seal = String(value || '').trim();

if (seal.indexOf('pa!~') !== 0) return seal;

var raw = safeAtob(seal.slice(4));
var pass = String(key || 'pa4u-stream-seal-v1');
var out = '';

for (var i = 0; i < raw.length; i++) {
out += String.fromCharCode(
raw.charCodeAt(i) ^ pass.charCodeAt(i % pass.length)
);
}

return out;
}

function fail(callback, error) {
callback({
success: false,
errorCode: 'UNKNOWN_ERROR',
message: String(error && error.message ? error.message : error)
});
}

// =====================================
// SITE ORIGIN (baseUrl -> live mirror)
// =====================================

// episode URL (without the "#h=" marker) -> the episode's own HubDrive
// file. Filled by load(), read by loadStreams(), so an episode still
// finds its file even when the caller drops the marker.
var EPISODE_FILES = {};

var siteOrigin = '';   // resolved site origin, e.g. https://new16.hdhub4u.cl
var originAt = 0;      // when it was resolved
var originPending = null;

function origin() {
return siteOrigin || base();
}

// Any HDHub4u mirror, including the baseUrl host itself.
// The HDHub4u brand, and whatever host the manifest (baseUrl) or the
// mirror service points at right now: the site moves without warning,
// so no single domain may be baked in.
function isSiteUrl(url) {
var host = originHost(url);

if (!host) return false;

return /(^|\.)hdhub4u\.[a-z.]+$/i.test(host) || sameSite(host, knownHosts());
}

function knownHosts() {
return [originHost(base()), siteOrigin ? originHost(siteOrigin) : ''];
}

function sameSite(host, hosts) {
for (var i = 0; i < hosts.length; i++) {
var known = hosts[i];

if (!known) continue;
if (host === known) return true;
if (host.slice(-known.length - 1) === '.' + known) return true;
if (known.slice(-host.length - 1) === '.' + host) return true;
}

return false;
}

function sitePath(url) {
var value = String(url || '').trim();

if (!value) return '';
if (isSiteUrl(value)) {
return value
.replace(/^https?:\/\/[^\/]+/i, '')
|| '/';
}

if (value.charAt(0) === '/') return value;
return '/' + value;
}

function absolute(url) {
url = decode(url || '').trim();

if (!url) return '';

if (isSiteUrl(url)) {
return origin() + sitePath(url);
}

if (/^https?:\/\//i.test(url)) return url;
if (url.indexOf('//') === 0) return 'https:' + url;
if (url.charAt(0) === '/') return origin() + url;

return '';
}

function isPostPage(url) {
if (!isSiteUrl(url)) return false;

var path = sitePath(url).replace(/^\/+/, '');

return !/^(category|page|wp-|search|author|tag|date|feed|comments|privacy|terms|contact|about|dmca|how-to-download|genre|star|director)(\/|\.|$)/i.test(path);
}

var responseCache = {};

async function fetchUrl(url, headers, timeoutMs) {
var response = await withTimeout(
http_get(url, headers || {
'User-Agent': 'Mozilla/5.0',
'Accept': 'text/html,application/xhtml+xml'
}),
Number(timeoutMs) || TIMEOUT.page,
url
);

if (
!response ||
(
response.status &&
(response.status < 200 || response.status >= 400)
)
) {
throw new Error('HTTP ' + (response && response.status) + ' – ' + url);
}

return String(response.body || '');
}

// Tiny short-lived cache: home validation and section rows often ask
// for the same page within one session.
async function get(url, headers) {
var key = String(url);
var hit = responseCache[key];

if (hit && Date.now() - hit.at < 60000) {
return hit.body;
}

var body;

try {
body = await fetchUrl(url, headers, TIMEOUT.page);
} catch (error) {
// The site can move in the middle of a session: resolve the origin
// again and retry once on the live host. A 4xx is a real answer, so
// only dead hosts and timeouts are retried.
var message = String((error && error.message) || error);

if (!isSiteUrl(url) || /HTTP 4\d\d/.test(message)) throw error;

await ensureOrigin(true);

var moved = origin() + sitePath(url);

body = await fetchUrl(moved, headers, TIMEOUT.page);
key = moved;
}

responseCache[key] = { body: body, at: Date.now() };

var keys = Object.keys(responseCache);
if (keys.length > 24) delete responseCache[keys[0]];

return body;
}

function looksLikeListing(html) {
return /class=["'][^"']*\brecent-movies\b/i.test(String(html || '')) ||
/class=["'][^"']*\bthumb\b/i.test(String(html || ''));
}

// Ask HDHub4u's mirror service which host is live right now. All
// endpoints are asked at once and the first usable answer wins, so a
// slow one neither delays the screen nor holds the call open.
async function askMirror(endpoint, stamp) {
var body;

try {
body = await fetchUrl(
endpoint + '?v=' + stamp,
{ 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
TIMEOUT.mirror
);
} catch (error) {
log('mirror endpoint failed: ' + endpoint + ' – ' + String(error.message || error));

return '';
}

var data = {};

try {
data = JSON.parse(body) || {};
} catch (error) {
return '';
}

// `c` is the full site URL, `h` only the host.
var candidates = [data.c, data.h];

for (var i = 0; i < candidates.length; i++) {
if (!candidates[i]) continue;

var decoded = safeAtob(String(candidates[i])).trim();
if (!decoded) continue;

var url = /^https?:\/\//i.test(decoded) ? decoded : 'https://' + decoded;
var host = originHost(url);

if (!host) continue;
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) continue;
if (isSiteUrl('https://' + host + '/')) return 'https://' + host;

// A brand new domain: trust it only if it really serves HDHub4u.
try {
var home = await fetchUrl('https://' + host + '/', null, TIMEOUT.mirror);

if (looksLikeListing(home)) return 'https://' + host;
} catch (error) {
// not this one
}
}

return '';
}

function resolveFromMirrorService() {
var stamp = String(Math.floor(Date.now() / 3600000));

return new Promise(function (resolve) {
var settled = false;
var pending = MIRROR_ENDPOINTS.length;

MIRROR_ENDPOINTS.forEach(function (endpoint) {
askMirror(endpoint, stamp).then(function (answer) {
pending--;

if (settled) return;

if (answer) {
settled = true;
log('mirror service says ' + originHost(answer));
resolve(answer);
return;
}

if (pending === 0) {
settled = true;
resolve('');
}
});
});
});
}

async function ensureOrigin(force) {
if (!force && siteOrigin && Date.now() - originAt < ORIGIN_TTL_MS) {
return siteOrigin;
}

if (originPending) return originPending;

originPending = (async function () {
// 1. HDHub4u's mirror service answers in a few hundred
//    milliseconds, so it is asked first. Testing baseUrl first used
//    to leave a doomed request to the landing page open – on some
//    networks that request never finishes and the whole plugin call
//    appears to hang after the result is printed.
var resolved = '';

try {
resolved = await resolveFromMirrorService();
} catch (error) {
log('mirror lookup failed: ' + String(error.message || error));
}

if (resolved) {
siteOrigin = resolved;
originAt = Date.now();
log('origin = ' + siteOrigin);
return siteOrigin;
}

// 2. Mirror service unavailable: does baseUrl itself serve the site?
try {
var home = await fetchUrl(base() + '/', null, TIMEOUT.mirror);

if (looksLikeListing(home)) {
siteOrigin = base();
originAt = Date.now();
log('using baseUrl: ' + siteOrigin);
return siteOrigin;
}

log('baseUrl ' + originHost(base()) + ' is a landing page');
} catch (error) {
log('baseUrl check failed: ' + String(error.message || error));
}

// 3. Give up gracefully and keep using baseUrl.
siteOrigin = base();
originAt = Date.now();
log('no live mirror found, falling back to ' + siteOrigin);
return siteOrigin;
})();

try {
return await originPending;
} finally {
originPending = null;
}
}

// =====================================
// TITLES
// =====================================

function cleanTitle(value) {
return text(value)
// <i class="material-icons">&#xE02C;</i> glyphs and bidi marks sit
// inside the <h1>, so drop those ranges.
.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
.replace(/[\ue000-\uf8ff]/g, '')
.replace(/^download\s+/i, '')
.trim();
}

// "The Great Indian Kapil Show (Season 5) WEB-DL [Hindi DD5.1] 4K
//  1080p 720p & 480p [x264/HEVC] HD | [NF Series] [EP-09 Added]"
// -> "The Great Indian Kapil Show (Season 5)"
var TITLE_CUT = new RegExp(
'\\b(?:4K|2160p|1440p|1080p|720p|540p|480p|WEB[ -]?DL|WEB[ -]?Rip|' +
'BluRay|Blu[ -]?ray|BRRip|HDRip|HDTS|DVDRip|DVDScr|PRE[ -]?DVD|' +
'HDR|HQ|CAM|HDCAM|HDTC|HEVC|x264|x265|10Bit|AAC|DD5\\.1|DS4K|UHD|' +
'UNCUT|UNRATED|iMAX|PRE[ -]?Release|Dual[ -]?Audio|ESubs|MSubs|' +
'Multi[ -]?Audio|' +
'Hindi[ -]?Dubbed|NF[ -]?Series|Full[ -]?Movie|Full[ -]?Series|' +
'Complete[ -]?Series)\\b',
'i'
);

function shortTitle(value) {
var title = cleanTitle(value);

if (!SHORT_TITLES) return title;

var match = title.match(TITLE_CUT);

if (match && match.index >= 3) {
title = title.slice(0, match.index);
}

var previous;
do {
previous = title;
title = title
.replace(/[\s\-–—|:,&+/*\[\(\{]+$/, '')
.replace(/\s+V\d+$/i, '')
.replace(/\s+(?:Hindi|English|Tamil|Telugu|Malayalam|Kannada|Punjabi|Dual|Dubbed|HD|HQ)$/i, '')
.trim();
} while (title !== previous);

return title.length >= 2 ? title : cleanTitle(value);
}

function kind(title, url) {
var value = String(title || '') + ' ' + String(url || '');

if (/\b(?:season\s*\d{1,2}|s\d{1,2}\s*[._-]?\s*e\d{1,3}|episodes?)\b/i.test(value)) {
return 'series';
}

if (/\bfull[ -]?movies?\b/i.test(value)) {
return 'movie';
}

return /\b(series|tv[ -]?shows?|web[ -]?series|reality[ -]?shows?|game[ -]?shows?|talk[ -]?shows?|k[ -]?dramas?|c[ -]?dramas?)\b/i.test(value)
? 'series'
: 'movie';
}

function yearOf(title) {
var value = String(title || '');
var bracketed = value.match(/\((19\d{2}|20\d{2})\)/);

if (bracketed) return Number(bracketed[1]);

var all = value.match(/\b(?:19\d{2}|20\d{2})\b/g);

return all && all.length ? Number(all[all.length - 1]) : undefined;
}

function tmdbSize(url, size) {
return String(url || '').replace(
/^(https:\/\/image\.tmdb\.org\/t\/p\/)[a-z0-9]+(\/[A-Za-z0-9]+\.(?:jpe?g|png|webp))$/i,
'$1' + size + '$2'
);
}

function qualityOf(label) {
var match = String(label || '').match(/\b(2160p|1440p|1080p|720p|480p|4k|2k)\b/i);

if (!match) return '';

var value = match[1].toLowerCase();

return value === '4k' ? '2160p' : value === '2k' ? '1440p' : value;
}

// Shown to the user: 720P / 1080P / 2160P.
function displayQuality(label) {
var value = String(label || '').trim();

if (!value) return 'Auto';
if (/^auto$/i.test(value)) return 'Auto';

return value.toUpperCase();
}

function qualityRank(label) {
var value = String(label || '').toUpperCase();

if (value.indexOf('2160') >= 0 || value.indexOf('4K') >= 0) return 2160;
if (value.indexOf('1440') >= 0 || value.indexOf('2K') >= 0) return 1440;
if (value.indexOf('1080') >= 0) return 1080;
if (value.indexOf('720') >= 0) return 720;
if (value.indexOf('480') >= 0) return 480;

return 0;
}

// Order the user asked for: 720P first, then 1080P, then 2160P.
function qualityPriority(label) {
var rank = qualityRank(label);

if (rank === 720) return 0;
if (rank === 1080) return 1;
if (rank === 2160) return 2;
if (!rank) return 9;   // Auto / unknown
return 3;              // 480P, 1440P, anything else
}

function formatSize(bytes) {
if (!(bytes > 0)) return '';
var units = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
return (i ? bytes.toFixed(2).replace(/\.00$/, '') : String(bytes)) + ' ' + units[i];
}

// =====================================
// LISTINGS
// =====================================

// Every HDHub4u result page renders post cards as
//   <ul class="recent-movies">
//     <li class="thumb"><figure><a href="/slug/">
//       <img class="nx-poster" src="…" alt="TITLE"></a></figure>
//     <figcaption>…</figcaption></li>
//   </ul>
// Reading inside that list keeps menus, ads and sidebars out.
function listingScope(html) {
var chunks = [];
var listRe = /<ul\b[^>]*class=["'][^"']*\brecent-movies\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi;
var m;

while ((m = listRe.exec(html)) !== null) {
chunks.push(m[1]);
}

if (chunks.length) return chunks.join('\n');

// Fallback: collect the cards themselves.
var cards = html.match(/<li\b[^>]*class=["'][^"']*\bthumb\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi);

return cards && cards.length ? cards.join('\n') : '';
}

function listings(html) {
var items = [];
var seen = {};
var scope = listingScope(html);

if (!scope) {
throw new Error('Post list not found; the site layout may have changed');
}

var anchors = scope.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];

anchors.forEach(function (anchor) {
var opening = (anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';
var href = absolute(attr(opening, 'href'));

if (!href || !isPostPage(href) || seen[href]) return;

// Only the poster anchor carries the image; the figcaption anchor
// repeats the same link and is skipped here.
var image = (anchor.match(/<img\b[^>]*>/i) || [])[0] || '';
if (!image) return;

var rawTitle = cleanTitle(
attr(image, 'alt') ||
attr(image, 'title') ||
attr(opening, 'aria-label') ||
text(anchor)
);

var poster = absolute(
attr(image, 'data-src') ||
attr(image, 'data-lazy-src') ||
attr(image, 'src')
);

if (!rawTitle || !poster) return;

seen[href] = true;

items.push(new MultimediaItem({
title: shortTitle(rawTitle),
url: href,
posterUrl: tmdbSize(poster, 'w500'),
type: kind(rawTitle, href),
year: yearOf(rawTitle)
}));
});

return items;
}

function meta(html, key) {
var tags = html.match(/<meta\b[^>]*>/gi) || [];

for (var i = 0; i < tags.length; i++) {
var name = attr(tags[i], 'property') || attr(tags[i], 'name');

if (name && name.toLowerCase() === key.toLowerCase()) {
return attr(tags[i], 'content');
}
}

return '';
}

// =====================================
// HOME
// =====================================

function homeSections() {
var rows = [];
var latest = HOME_LAYOUT.latest;
var tv = HOME_LAYOUT.tvShows;

if (latest && latest.path) {
rows.push({
name: latest.title,
path: latest.path,
limit: Number(latest.limit) || 0,
seriesOnly: false
});
}

if (tv && Array.isArray(tv.channels)) {
tv.channels.forEach(function (channel) {
if (!channel || !channel.path) return;

rows.push({
name: tv.grouped
? tv.title + ' \u00b7 ' + channel.title
: channel.title,
path: channel.path,
limit: Number(channel.limit || tv.limit) || 0,
seriesOnly: channel.seriesOnly !== undefined
? !!channel.seriesOnly
: !!tv.seriesOnly
});
});
}

return rows;
}

async function loadHomeRows(rows) {
return Promise.all(rows.map(async function (row) {
try {
var items = listings(await get(origin() + row.path));

if (row.seriesOnly) {
items = items.filter(function (item) {
return item.type === 'series';
});
}

return {
name: row.name,
items: row.limit > 0 ? items.slice(0, row.limit) : items,
error: null
};
} catch (error) {
reportError('Home row "' + row.name + '": ' + String(error));
return { name: row.name, items: [], error: error };
}
}));
}

async function getHome(callback) {
var rows = homeSections();
var done = false;
var watchdog = null;

// The callback is answered exactly once – including when a host
// stops responding, which is what makes a plugin test print
// "No Output" instead of an error.
function finish(result) {
if (done) return;

done = true;

if (watchdog && typeof clearTimeout === 'function') {
clearTimeout(watchdog);
}

callback(result);
}

if (typeof setTimeout === 'function') {
watchdog = setTimeout(function () {
log('home: watchdog fired');
finish({
success: false,
errorCode: 'UNKNOWN_ERROR',
message: 'Timed out while loading the home screen. ' +
'Check the connection and try again.'
});
}, TIMEOUT.watchdog);
}

try {
log('home: resolving site origin');
await ensureOrigin(false);
log('home: origin = ' + origin());

var results = await loadHomeRows(rows);
var total = results.reduce(function (sum, result) {
return sum + result.items.length;
}, 0);

// A stale mirror answers 200 with an empty page, so retry once on a
// freshly resolved origin before reporting a failure. No point
// retrying when no mirror was ever found.
if (!total && origin() !== base()) {
log('home: no items, re-resolving the mirror and retrying');
await ensureOrigin(true);
log('home: retry origin = ' + origin());

results = await loadHomeRows(rows);
}

var data = {};

results.forEach(function (result) {
log('home: "' + result.name + '" -> ' + result.items.length + ' items' +
(result.error ? ' (error: ' + String(result.error.message || result.error) + ')' : ''));

if (result.items.length) data[result.name] = result.items;
});

if (!Object.keys(data).length) {
// baseUrl never resolved to a working mirror: say so instead of
// blaming the page layout.
if (origin() === base()) {
throw new Error('No live HDHub4u mirror found. ' + originHost(base()) +
' is a landing page and the mirror service did not answer – ' +
'check the connection and try again.');
}

var firstError = results.find(function (result) {
return result.error;
});

throw firstError && firstError.error
? firstError.error
: new Error('No home items found');
}

finish({ success: true, data: data });
} catch (error) {
log('home: failed – ' + String(error && error.message ? error.message : error));

finish({
success: false,
errorCode: 'UNKNOWN_ERROR',
message: String(error && error.message ? error.message : error)
});
}
}

// =====================================
// SEARCH
// =====================================

// The site's search box ( /search.html ) queries a Typesense proxy.
var SEARCH_ENDPOINT =
'https://search.pingora.fyi/collections/post/documents/search';

function searchItem(document) {
if (!document) return null;

var href = absolute(document.permalink || '');

if (!href || !isPostPage(href)) return null;

var rawTitle = cleanTitle(document.post_title || '');
if (!rawTitle) return null;

return new MultimediaItem({
title: shortTitle(rawTitle),
url: href,
posterUrl: absolute(document.post_thumbnail || ''),
type: kind(rawTitle, href),
year: yearOf(rawTitle)
});
}

async function search(query, page, callback) {
if (typeof page === 'function') {
callback = page;
page = 1;
}

try {
var term = String(query || '').trim();

if (!term) {
return callback({ success: true, data: [] });
}

var pageNumber = Math.max(1, parseInt(page, 10) || 1);

await ensureOrigin(false);

var body = await fetchUrl(
SEARCH_ENDPOINT +
'?q=' + encodeURIComponent(term) +
'&query_by=' + encodeURIComponent('post_title,category,stars,director,imdb_id') +
'&query_by_weights=4,2,2,2,4' +
'&sort_by=' + encodeURIComponent('sort_by_date:desc') +
'&limit=30' +
'&page=' + pageNumber +
'&highlight_fields=none' +
'&use_cache=true',
{
'User-Agent': 'Mozilla/5.0',
'Accept': 'application/json',
'Referer': origin() + '/',
'Origin': origin()
}
);

var response = JSON.parse(body);
var hits = (response && response.hits) || [];
var seen = {};

var results = hits
.map(function (hit) {
var item = searchItem(hit && hit.document ? hit.document : hit);

if (!item || seen[item.url]) return null;

seen[item.url] = true;
return item;
})
.filter(function (item) {
return item !== null;
});

callback({ success: true, data: results });
} catch (error) {
fail(callback, error);
}
}

// =====================================
// POST PAGE BUTTONS
// =====================================

var PLAY_HOST = /^https?:\/\/(?:www\.)?(?:playdrive|play4u)\.[a-z]+\//i;
var STREAM_HOST = /^https?:\/\/(?:www\.)?hdstream4u\.[a-z]+\/file\//i;
var DOWNLOAD_ONLY = /^https?:\/\/(?:www\.)?greenmotors\.[a-z]+\/\?id=/i;
var FILE_HOST = /^https?:\/\/(?:www\.)?hubdrive\.[a-z]+\/(?:file|packs)\//i;
var PACK_HOST = /^https?:\/\/(?:www\.)?hubdrive\.[a-z]+\/packs\//i;
var DRIVE_HOST = /^https?:\/\/(?:www\.)?hubcloud\.[a-z]+\/drive\//i;
var GENERATE_HOST = /^https?:\/\/gamerxyt\.com\/hubcloud\.php\?/i;

// Download-only hosts this version recognises but cannot resolve.
var BLOCKED_HOST =
/^https?:\/\/(?:www\.)?(?:greenmotors\.[a-z]+|hubstream\.[a-z]+|hdstream4u\.[a-z]+|vidaraa\.[a-z]+)\//i;

function pageUrl(raw, page) {
raw = decode(raw || '').trim();

if (!raw) return '';
if (/^https?:\/\//i.test(raw)) return raw;
if (raw.indexOf('//') === 0) return 'https:' + raw;

var originMatch = String(page || '').match(/^https?:\/\/[^/]+/i);

if (raw.charAt(0) === '/') {
return (originMatch ? originMatch[0] : origin()) + raw;
}

return '';
}

// Every anchor on a post page, with the quality of the heading it
// sits under" – so "1080p WEB-DL [6.3GB]" buttons are labelled 1080p.
function pageButtons(html, page) {
var events = [];
var m;

var headingRe = /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi;

while ((m = headingRe.exec(html)) !== null) {
var quality = qualityOf(text(m[0]));
if (quality) events.push({ index: m.index, quality: quality });
}

var anchorRe = /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi;

while ((m = anchorRe.exec(html)) !== null) {
var href = pageUrl(attr((m[0].match(/^<a\b[^>]*>/i) || [])[0], 'href'), page);

if (href && !isSiteUrl(href)) {
events.push({
index: m.index,
url: href,
label: text(m[0]),
quality: qualityOf(text(m[0]))
});
}
}

events.sort(function (a, b) { return a.index - b.index; });

var current = '';
var out = [];

events.forEach(function (event) {
if (event.quality && !event.url) {
current = event.quality;
return;
}

if (!event.url) return;

out.push({
url: event.url,
label: event.label || '',
quality: event.quality || current || ''
});
});

return out;
}

// A season archive is offered as "… PACK [33.7GB]" — far too big to be
// one episode.
// "FSL Server · 1080P · 932.36 MB · S01E01" -> { season: 1, episode: 1 }
function streamEpisodeTag(stream) {
var label = String((stream && stream.source) || '').match(
/S(\d{1,2})\s*[-.]?\s*E(\d{1,3})/i
);

if (!label) return null;

return { season: Number(label[1]), episode: Number(label[2]) };
}

function isSeasonArchive(label) {
var value = String(label || '');

return /\bpack\b/i.test(value) &&
/\[\s*\d+(?:\.\d+)?\s*(?:GB|TB)\s*\]/i.test(value);
}

function uniqueBy(items, key) {
var seen = {};

return items.filter(function (item) {
var value = key(item);

if (!value || seen[value]) return false;

seen[value] = true;
return true;
});
}

// =====================================
// SERIES EPISODES
// =====================================

// Read a JSON object that follows a marker such as
// window.__PA_SERIES__ = {...};  Brace matching (string aware) is
// used instead of a lazy regex, so titles containing "};" cannot
// truncate the data.
function jsonObjectAfter(html, marker) {
var source = String(html || '');
var at = source.indexOf(marker);

if (at < 0) return null;

var start = source.indexOf('{', at);

if (start < 0) return null;

var depth = 0;
var inString = false;
var escaped = false;

for (var i = start; i < source.length; i++) {
var ch = source.charAt(i);

if (inString) {
if (escaped) escaped = false;
else if (ch === '\\') escaped = true;
else if (ch === '"') inString = false;
} else if (ch === '"') {
inString = true;
} else if (ch === '{') {
depth++;
} else if (ch === '}') {
depth--;

if (depth === 0) {
try {
return JSON.parse(source.slice(start, i + 1));
} catch (error) {
reportError('JSON after ' + marker + ' could not be parsed: ' + String(error));
return null;
}
}
}
}

return null;
}

// Rewrite the season/episode numbers inside a known-good player URL,
// whether it uses /s-05/ep-01 or ?s=5&ep=1.
function withEpisodeNumbers(url, season, episode) {
function pad(value) {
return String(value).length < 2 ? '0' + value : String(value);
}

var value = String(url || '');
var replaced = value.replace(
/\/s-\d{1,2}\/ep-\d{1,3}/i,
'/s-' + pad(season) + '/ep-' + pad(episode)
);

if (replaced !== value) return replaced;

if (/[?&]ep=\d+/i.test(value)) {
return value
.replace(/([?&]s=)\d+/i, '$1' + season)
.replace(/([?&]ep=)\d+/i, '$1' + episode);
}

return value;
}

function seasonOf(title, html) {
var source = String(title || '') + ' ' + String(html || '');
var match =
source.match(/\bseason\s*(\d{1,2})\b/i) ||
source.match(/\bs(\d{1,2})\s*[._-]?\s*e\d{1,3}\b/i) ||
source.match(/\/s-(\d{1,2})\//i);

return match ? Number(match[1]) : 1;
}

function episodeFromUrl(url) {
var match = String(url || '').match(/\/s-(\d{1,2})\/ep-(\d{1,3})/i);

if (!match) return null;

return { season: Number(match[1]), episode: Number(match[2]) };
}

// Many posts list one line per episode – "EPiSODE 1 | WATCH" – where
// the watch button sits next to the download button. Grouping the
// links per marker gives each episode its own playable source, even
// when the player does not carry the show at all.
function episodeBlocks(html, page) {
var re = /(?:EPiSODE|Episode)\s*[:\-]?\s*(\d{1,3})\b/gi;
var marks = [];
var match;

while ((match = re.exec(html)) !== null) {
marks.push({ index: match.index, number: Number(match[1]) });
}

var blocks = [];

marks.forEach(function (mark, i) {
var end = i + 1 < marks.length ? marks[i + 1].index : html.length;
var slice = html.slice(mark.index, end);

var links = (slice.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [])
.map(function (anchor) {
return pageUrl(attr((anchor.match(/^<a\b[^>]*>/i) || [])[0], 'href'), page);
})
.filter(function (href) {
return href && !isSiteUrl(href) &&
(PLAY_HOST.test(href) || STREAM_HOST.test(href) ||
FILE_HOST.test(href) || DOWNLOAD_ONLY.test(href));
});

if (links.length) {
blocks.push({ number: mark.number, links: links });
}
});

return blocks;
}

function byEpisodeKey(a, b) {
var an = String(a).split(':').map(Number);
var bn = String(b).split(':').map(Number);

return an[0] - bn[0] || an[1] - bn[1];
}

// Resolve the files of one episode. A season-pack entry lists several
// episodes, so only rows that name the wanted one are kept.
async function resolveFirstEpisode(index, keys, tag, html) {
if (!keys || !keys.length) {
log(tag + ': series post -> no episode file');

return [];
}

var files = index[keys[0]].slice(0, 4);
var wanted = keys[0].split(':').map(Number);

log(tag + ': series post -> episode ' + wanted[1] +
' with ' + files.length + ' file(s)');

var streams = (
await Promise.all(
files.map(function (file) {
return resolveStreams(file, qualityOf(html), 0).then(null, function (error) {
reportError('episode file failed: ' + String(error.message || error));

return [];
});
})
)
).reduce(function (all, list) { return all.concat(list); }, []);

return streams.filter(function (stream) {
var label = String((stream && stream.source) || '').match(/S(\d{1,2})E(\d{1,3})/i);

if (!label) return true;

return Number(label[1]) === wanted[0] && Number(label[2]) === wanted[1];
});
}

// The HubDrive files each "EPiSODE n" block links (one Drive link per
// quality), keyed "season:episode". A season pack is not one of them.
function episodeFileIndex(html, page, season) {
var index = {};

episodeBlocks(html, page).forEach(function (block) {
var files = block.links.filter(function (link) {
return FILE_HOST.test(link) && !PACK_HOST.test(link) && !BLOCKED_HOST.test(link);
});

if (!files.length) return;
if (!index[season + ':' + block.number]) index[season + ':' + block.number] = files;
});

return index;
}

// A .zip / .rar / .7z is a whole season, never a playable stream.
function isArchiveStream(stream) {
var url = String((stream && stream.url) || '');
var decoded = '';

try {
decoded = decodeURIComponent(url);
} catch (error) {
decoded = url;
}

if (/(?:filename=["']?|\/)[^"'&?]*\.(?:zip|rar|7z)(?:["'?&#]|$)/i.test(decoded)) {
return true;
}

return /\.(?:zip|rar|7z)(?:[?#&]|$)/i.test(decoded) ||
isArchive(String((stream && stream.source) || ''));
}

// Best available source for one episode: player first, then the
// watch host, then downloads.
function pickBlockLink(links) {
var groups = [PLAY_HOST, STREAM_HOST, FILE_HOST, DOWNLOAD_ONLY];

for (var g = 0; g < groups.length; g++) {
for (var i = 0; i < links.length; i++) {
if (groups[g].test(links[i])) return links[i];
}
}

return '';
}

// play4u keeps the complete episode list for a show, while the post
// page only links the episodes that have a watch mirror. Reading that
// complete list is what stops episodes from going missing.
async function play4uEpisodesFromPage(pageUrl, season, allowMismatch) {
var html = await get(pageUrl, {
'User-Agent': 'Mozilla/5.0',
'Referer': 'https://play4u.org/'
});

var map = jsonObjectAfter(html, '__PA_SERIES__');

if (!map || !map.seasons) {
log('play4u: no series map on ' + pageUrl);
return [];
}

var seasons = map.seasons;
var key = String(season);

if (!seasons[key]) {
var keys = Object.keys(seasons);

// Only fall back to another season when the post does not name one
// itself – otherwise the wrong episodes would be shown.
if (!allowMismatch || keys.length !== 1) {
log('play4u: season ' + season + ' not in map (' + keys.join(',') + ')');
return [];
}

key = keys[0];
}

var episodes = (seasons[key] && seasons[key].episodes) || {};
var numbers = Object.keys(episodes)
.map(function (value) { return Number(value); })
.filter(function (value) { return value > 0; })
.sort(function (a, b) { return a - b; });

var list = numbers.map(function (number) {
var entry = episodes[String(number)] || {};
var title = cleanTitle(entry.title || '');

// Keep the readable title, capped so long descriptions do not
// swamp the episode list.
if (title.length > 60) title = title.slice(0, 57).trim() + '\u2026';

return new Episode({
name: 'Episode ' + number + (title ? ' \u00b7 ' + title : ''),
url: withEpisodeNumbers(pageUrl, key, number),
season: Number(key),
episode: number
});
});

log('play4u: season ' + key + ' has ' + list.length + ' episode(s)');

return list;
}

// Slow path: go through the playdrive watch page to find the play4u
// page for this show.
async function play4uEpisodes(playUrl, season, allowMismatch) {
var playHtml = await get(playUrl, {
'User-Agent': 'Mozilla/5.0',
'Referer': origin() + '/'
});

var episodeUrl = play4uEpisodeFrom(playHtml, playUrl);

if (!episodeUrl) {
log('play4u: no episode page found for ' + playUrl);
return [];
}

return play4uEpisodesFromPage(episodeUrl, season, allowMismatch);
}

// Fast path: the post page already links the show's IMDb id, and
// play4u addresses shows by it – one request instead of two.
async function play4uEpisodesByImdb(html, season, allowMismatch) {
var match = String(html || '').match(/imdb\.com\/title\/(tt\d{5,10})/i);

if (!match) return [];

function pad(value) {
return String(value).length < 2 ? '0' + value : String(value);
}

var pageUrl = 'https://play4u.org/series/' + match[1] +
'/s-' + pad(season) + '/ep-01';

try {
return await play4uEpisodesFromPage(pageUrl, season, allowMismatch);
} catch (error) {
log('play4u: imdb route failed for ' + match[1] + ' – ' +
String(error.message || error));
return [];
}
}

async function seriesEpisodes(html, postUrl, title) {
var buttons = pageButtons(html, postUrl);
var fallbackSeason = seasonOf(title, html);
var watch = [];
var loose = [];
var packs = [];

buttons.forEach(function (button) {
if (PLAY_HOST.test(button.url)) {
var numbers = episodeFromUrl(button.url);

if (numbers) {
watch.push({
url: button.url,
season: numbers.season,
episode: numbers.episode
});
} else {
loose.push(button);
}
} else if (FILE_HOST.test(button.url)) {
packs.push(button);
}
});

var list = [];
var seen = {};

// 1. Complete episode list from the player (covers episodes the
//    post only offers as a download link).
var complete = [];

// Does the post itself say which season it covers?
var seasonNamed = new RegExp(
'\\bseason\\s*\\d{1,2}\\b|s\\d{1,2}\\s*[._-]?\\s*e\\d{1,3}|/s-\\d{1,2}/',
'i'
).test(String(title || '') + ' ' + String(postUrl || ''));

try {
complete = await play4uEpisodesByImdb(html, fallbackSeason, !seasonNamed);
} catch (error) {
reportError('play4u imdb lookup failed: ' + String(error.message || error));
}

if (!complete.length && watch.length) {
try {
complete = await play4uEpisodes(watch[0].url, watch[0].season, !seasonNamed);
} catch (error) {
reportError('play4u episode map failed: ' + String(error.message || error));
}
}

complete.forEach(function (episode) {
var key = episode.season + ':' + episode.episode;

if (seen[key]) return;
seen[key] = true;
list.push(episode);
});

// 2. Anything the player did not list, taken from the post itself.
watch
.sort(function (a, b) {
return a.season - b.season || a.episode - b.episode;
})
.forEach(function (entry) {
var key = entry.season + ':' + entry.episode;

if (seen[key]) return;
seen[key] = true;

list.push(new Episode({
name: 'Episode ' + entry.episode,
url: entry.url,
season: entry.season,
episode: entry.episode
}));
});

// 3. Episodes listed one by one on the post itself.
episodeBlocks(html, postUrl).forEach(function (block) {
var key = fallbackSeason + ':' + block.number;

if (seen[key]) return;

var link = pickBlockLink(block.links);

if (!link) return;

seen[key] = true;

list.push(new Episode({
name: 'Episode ' + block.number,
url: link,
season: fallbackSeason,
episode: block.number
}));
});

// The Drive links next to each episode on the post: the most precise
// source, and the reason a pack page often does not need reading.
var blockIndex = episodeFileIndex(html, postUrl, fallbackSeason);
var blockCount = Object.keys(blockIndex).length;

// Every pack that is on the post is read once: the pages list one
// file per episode, so each episode gets its own file link.
var packIndex = {};

var packsNeeded =
packs.length &&
(STREAM_SOURCE !== 'playdrive' || !list.length) &&
(!blockCount || blockCount < list.length);

if (packsNeeded) {
var packPages = uniqueBy(packs, function (pack) { return pack.url; });

for (var pi = 0; pi < packPages.length; pi++) {
var packHtml;

try {
packHtml = await get(packPages[pi].url, {
'User-Agent': 'Mozilla/5.0',
'Referer': origin() + '/'
});
} catch (error) {
reportError('pack page failed: ' + String(error.message || error));
continue;
}

packFiles(packHtml, packPages[pi].url).forEach(function (file) {
var tag = episodeTag(file.name);

if (!tag) return;

var key = tag.season + ':' + tag.episode;

// Every pack is read (480p, 720p, 1080p …), so one episode ends
// with all of its qualities, not just the first pack's copy.
if (!packIndex[key]) packIndex[key] = [];
if (packIndex[key].indexOf(file.url) < 0) packIndex[key].push(file.url);
});
}
}

// No pack on the post: HUBLinks mirrors the show's episodes with their
// HubDrive files (480P / 720P / 1080P), which is how shows that only
// publish ad-gated links still get file streams.
var hubIndex = {};

if (STREAM_SOURCE !== 'playdrive' && !packs.length) {
try {
hubIndex = await hubEpisodeFiles(title, fallbackSeason, list.length || 100);
} catch (error) {
reportError('hblinks lookup failed: ' + String(error.message || error));
}
}

var fileIndex = {};

// Most precise first: the Drive links next to each episode on the
// post, then the pack page files, then HUBLinks.
[blockIndex, packIndex, hubIndex].forEach(function (index) {
Object.keys(index).forEach(function (key) {
if (!fileIndex[key]) fileIndex[key] = index[key];
});
}
);

// Episodes found from the player get their files attached, so the
// stream list shows the HubDrive servers for each of them.
// Best quality first, so an episode opens on its highest copy.
function bestFirst(files) {
return files.slice().sort(function (a, b) {
return qualityRank(qualityFromName(b)) - qualityRank(qualityFromName(a));
});
}

function qualityFromName(url) {
var name = '';

try {
name = decodeURIComponent(String(url || ''));
} catch (error) {
name = String(url || '');
}

var match = name.match(/\b(2160p|1440p|1080p|720p|540p|480p|4k)\b/i);

return match ? match[1] : qualityOf(name);
}

if (list.length) {
list.forEach(function (episode) {
var files = bestFirst(fileIndex[episode.season + ':' + episode.episode] || []);
var link = String(episode.url || '').split('#')[0];

if (!files.length) return;

// An ad-gated watch link (greenmotors / hubstream / hdstream4u) is
// never a stream here: the episode opens on its HubDrive file.
if (BLOCKED_HOST.test(link)) {
episode.url = files[0];
EPISODE_FILES[files[0]] = files;
return;
}

EPISODE_FILES[link] = files;

if (String(episode.url).indexOf('#h=') < 0) {
episode.url =
episode.url +
'#h=' +
files
.map(function (file) { return encodeURIComponent(file); })
.join('|');
}
});
}

// Episodes that only exist as HubDrive files: the older episodes of a
// post that links them through ad-gated hosts, or a show the player
// does not list at all. They are added to the list, not swapped in.
Object.keys(fileIndex).forEach(function (key) {
var numbers = key.split(':');

if (seen[key]) return;

seen[key] = true;

var files = bestFirst(fileIndex[key]);

// The best file is the episode URL; the rest come from the cache.
EPISODE_FILES[files[0]] = files;

list.push(new Episode({
name: 'Episode ' + numbers[1],
url: files[0],
season: Number(numbers[0]),
episode: Number(numbers[1])
}));
});

// Packs with no per-episode files: one row per pack.
if (!list.length) {
uniqueBy(packs, function (pack) { return pack.url; })
.forEach(function (pack, index) {
var quality = pack.quality || qualityOf(pack.label) || '';

list.push(new Episode({
name: 'Full Season' + (quality ? ' \u00b7 ' + quality : ''),
url: pack.url,
season: fallbackSeason,
episode: index + 1
}));
});
}

// Season-level watch link with no episode numbers (an "open the
// player" button).
if (!list.length && loose.length) {
list.push(new Episode({
name: 'Watch Online',
url: loose[0].url,
season: fallbackSeason,
episode: 1
}));
}

return list.sort(function (a, b) {
return a.season - b.season || a.episode - b.episode;
});
}

// =====================================
// HDSTREAM PLAYER (hds*  /file/<id>)
// =====================================

// The watch pages hide their player config inside a Dean Edwards
// "p,a,c,k,e,d" packed script. Unpacking it is pure string work, so
// it runs safely in the plugin sandbox – no remote script is ever
// executed.
function unpackJs(html) {
var match = String(html || '').match(
/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/
);

if (!match) return '';

var payload = match[1].replace(/\\'/g, "'");
var radix = Number(match[2]);
var count = Number(match[3]);
var words = match[4].split('|');
var digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function toRadix(value) {
if (value === 0) return '0';

var out = '';

while (value > 0) {
out = digits.charAt(value % radix) + out;
value = Math.floor(value / radix);
}

return out;
}

for (var i = count - 1; i >= 0; i--) {
if (!words[i]) continue;

payload = payload.replace(
new RegExp('\\b' + toRadix(i) + '\\b', 'g'),
(function (word) {
return function () { return word; };
})(words[i])
);
}

return payload;
}

// Player source list from an unpacked watch page: hls4 -> hls3 -> hls2,
// in the same priority the page itself uses.
function hdStreamSources(html) {
var links = jsonObjectAfter(unpackJs(html), 'var links');

if (!links) return [];

return [links.hls4, links.hls3, links.hls2, links.hls1]
.filter(function (value) { return value && typeof value === 'string'; });
}

// Best resolution advertised by an HLS master playlist.
function playlistQuality(playlist) {
var best = 0;
var re = /RESOLUTION=(\d+)x(\d+)/gi;
var match;

while ((match = re.exec(String(playlist || ''))) !== null) {
var height = Number(match[2]);

if (height > best) best = height;
}

if (best >= 2000) return '2160p';
if (best >= 1400) return '1440p';
if (best >= 1000) return '1080p';
if (best >= 700) return '720p';
if (best >= 400) return '480p';

return '';
}

async function resolveHdStream(pageUrl) {
var html = await get(pageUrl, {
'User-Agent': 'Mozilla/5.0',
'Referer': origin() + '/'
});

var sources = hdStreamSources(html);
var pageOrigin = (String(pageUrl).match(/^https?:\/\/[^/]+/i) || [])[0] || '';

if (!sources.length) {
throw new Error('Watch page has no player source');
}

var target = '';

for (var i = 0; i < sources.length; i++) {
var value = String(sources[i]);

if (value.charAt(0) === '/') value = pageOrigin + value;
if (!/^https?:\/\//i.test(value)) continue;

target = value;
break;
}

if (!target) {
throw new Error('Watch page source is not a URL');
}

var quality = '';

try {
quality = playlistQuality(await get(target, {
'User-Agent': 'Mozilla/5.0',
'Referer': pageOrigin + '/'
}));
} catch (error) {
reportError('HDStream playlist check failed: ' + String(error.message || error));
}

return [{
url: target,
quality: quality || 'Auto',
source: 'HDStream \u00b7 HLS' + (quality ? '' : ' (auto)'),
headers: { Referer: pageOrigin + '/' }
}];
}

// =====================================
// STREAM RESOLVERS
// =====================================

function extractR2(html) {
var urls = [];
var re = /https:\/\/[A-Za-z0-9-]+\.r2\.cloudflarestorage\.com\/[^\s"'<>\\]+/gi;
var m;

while ((m = re.exec(String(html || ''))) !== null) {
var url = decode(m[0]).replace(/&amp;/g, '&');

if (urls.indexOf(url) < 0) urls.push(url);
}

return urls;
}

function extractPixelDrain(html) {
var ids = [];
var re = /https:\/\/pixeldrain\.dev\/u\/([A-Za-z0-9]+)/gi;
var m;

while ((m = re.exec(String(html || ''))) !== null) {
if (ids.indexOf(m[1]) < 0) ids.push(m[1]);
}

return ids;
}

async function resolvePixelDrain(id) {
var response = await http_get(
'https://pixeldrain.dev/api/file/' + id + '/info',
{ 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
);

if (!response || response.status < 200 || response.status >= 300) {
throw new Error('PixelDrain metadata HTTP ' + (response && response.status));
}

var info = JSON.parse(String(response.body || ''));
var mime = String((info && info.mime_type) || '');

if (!info || info.success !== true || info.can_download === false || !/^video\//i.test(mime)) {
throw new Error('PixelDrain file is not a playable video');
}

return {
url: 'https://pixeldrain.dev/api/file/' + id,
size: formatSize(Number(info.size))
};
}

// HUBLinks (hblinks.lol) mirrors every post as one archive entry that
// carries the HubDrive file(s) for it. Its WordPress REST API is used to
// find the entry for a title whose own post only links player/ad pages.
var HUBLINKS_API =
'https://hblinks.lol/wp-json/wp/v2/posts?per_page=100&search=';

function searchName(title) {
return String(title || '')
.replace(/\((19|20)\d{2}\)/g, ' $1 ')
.replace(/\[[^\]]*\]/g, ' ')
.replace(/\bseason\s*\d{1,2}\b/gi, ' ')
.replace(
/\b(?:all\s+episodes|full\s+series|complete|hindi|english|tamil|telugu|malayalam|kannada|punjabi|dubbed|webrip|web-dl|webdl|hdrip|bluray|ds4k|dual\s+audio|dual|multi|audio|audios|added|add|eps?|packs?|zipped?)\b/gi,
' '
)
// OTT tags tacked onto post titles ("… | PrimeVideo Series [EP – 1 Added]").
.replace(
/\b(?:prime\s*video|primevideo|amazon|netflix|jiostar|jio\s*hotstar|hotstar|sonyliv|sony\s*liv|zee\s*5|mx\s*player|altbalaji|appletv|apple\s*tv|disney\s*\+?|series|movies?|episodes?|show)\b/gi,
' '
)
.replace(/\b\d{3,4}p\b/gi, ' ')
.replace(
/\b(?:4k|2k|uhd|hd|hevc|x264|x265|10bit|aac|ddp?|dd|dts|ac3|eac3|atmos|esubs?|nf|all|original|\d+\.\d+)\b/gi,
' '
)
.replace(/[^A-Za-z0-9 ]+/g, ' ')
.replace(/\s+/g, ' ')
.trim();
}

function hubQueries(title, season) {
var name = searchName(title);
var words = name.split(' ').filter(Boolean);
var list = [];

if (season) {
// HUBLinks writes "S01E01", not "S1E1": the padded form is searched
// first, on the short show name and then on the full one, because a
// long title ("… WEB-DL Hindi Dual Audio PrimeVideo") never matches.
var short3 = words.slice(0, 3).join(' ');
var short2 = words.slice(0, 2).join(' ');
var short1 = words.slice(0, 1).join(' ');
var pad = season < 10 ? '0' + season : String(season);

// One word is often all a search needs ("Dhindora S02"), and it is
// the only form that still matches when the title is full of tags.
// The full cleaned name is the most precise query, so it goes first;
// the shorter forms follow for posters who abbreviate.
[name + ' S' + pad, short3 + ' S' + pad, short2 + ' S' + pad,
short1 + ' S' + pad, name + ' S' + season, short3 + ' S' + season,
name, short1].forEach(function (query) { list.push(query); });
} else {
list.push(name);
list.push(words.slice(0, 3).join(' '));
}

return list.filter(function (query, index) {
return query && list.indexOf(query) === index;
});
}

function hubFilesFromPost(post) {
var html = String((post && post.content && post.content.rendered) || '');
var files = [];
var re = /https:\/\/hubdrive\.[a-z]+\/file\/[A-Za-z0-9]+/gi;
var match;

while ((match = re.exec(html)) !== null) {
if (files.indexOf(match[0]) < 0) files.push(match[0]);
}

return {
title: text((post && post.title && post.title.rendered) || ''),
files: files
};
}

// A request per query, merged, until `enough` entries are known.
async function hubSearch(title, season, accept, enough) {
var queries = hubQueries(title, season);
var seen = {};
var found = [];

for (var i = 0; i < queries.length; i++) {
var posts;

try {
var body = await fetchUrl(
HUBLINKS_API + encodeURIComponent(queries[i]),
{ 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
TIMEOUT.page
);

posts = JSON.parse(body);
} catch (error) {
log('hblinks: ' + queries[i] + ' failed – ' + String(error.message || error));
continue;
}

if (!Array.isArray(posts)) continue;

var wanted = [];

posts.forEach(function (post) {
var entry = hubFilesFromPost(post);

if (!entry.files.length) return;
if (!accept(entry.title, entry.files)) return;
if (seen[entry.files[0]]) return;

seen[entry.files[0]] = true;
wanted.push(entry);
});

if (wanted.length) {
found = found.concat(wanted);
log('hblinks: "' + queries[i] + '" -> ' + found.length + ' entr(ies)');
} else if (found.length) {
// This query only repeated what is already known: nothing left to add.
break;
} else if (posts.some(function (post) {
// The show is on HUBLinks but only as season packs: no episode
// posts exist, so no further query can find one.
var name = hubFilesFromPost(post).title;

return !!name && hubMatchesShow(name, title) && !episodeTag(name);
})) {
log('hblinks: "' + queries[i] + '" -> season packs only');
break;
}

if (enough && found.length >= Math.max(1, enough - 2)) break;
}

return found;
}

// "Show S05E02" -> { season: 5, episode: 2 } (also S05-E02, S5 Ep 2)
// Every meaningful word of the show has to appear in the HUBLinks post
// title: "The Good Doctor" must not accept "The Good Place".
function hubMatchesShow(title, showName) {
var words = searchName(showName)
.toLowerCase()
.split(' ')
.filter(function (word) {
return word.length > 2 && !/^(?:the|and|of|for|with|from)$/.test(word);
});

if (!words.length) return true;

var value = ' ' +
String(title || '')
.toLowerCase()
.replace(/[^a-z0-9]+/g, ' ')
.replace(/\s+/g, ' ') +
' ';

return words.every(function (word) { return value.indexOf(' ' + word) >= 0; });
}

// Episodes of one season -> their HubDrive files.
async function hubEpisodeFiles(title, season, expected) {
var entries = await hubSearch(title, season, function (postTitle) {
var tag = episodeTag(postTitle);

return !!tag && tag.season === season && hubMatchesShow(postTitle, title);
}, expected);

var index = {};

entries.forEach(function (entry) {
var tag = episodeTag(entry.title);

if (!tag) return;

var key = tag.season + ':' + tag.episode;

if (!index[key]) index[key] = entry.files;
});

return index;
}

// One movie -> every HubDrive file HUBLinks lists for it.
async function hubMovieFiles(title) {
var entries = await hubSearch(title, 0, function (postTitle) {
return hubMatchesShow(postTitle, title);
});

var files = [];

entries.forEach(function (entry) {
entry.files.forEach(function (file) {
if (files.indexOf(file) < 0) files.push(file);
});
});

return files.slice(0, 4);
}

// A pack page lists one file per episode (plus often a whole-season
// archive), each with its own /file/<id> and size.
function packFiles(html, page) {
var source = String(html || '');
var rows = source.match(
/<div\b[^>]*class=["'][^"']*pack-clean-file[^"']*["'][\s\S]*?(?=<div\b[^>]*class=["'][^"']*pack-clean-file|<\/body)/gi
) || [];
var files = [];
var seen = {};

function push(name, size, href) {
var url = pageUrl(href, page);

if (!url || seen[url]) return;

seen[url] = true;
files.push({ name: text(name), size: text(size), url: url });
}

for (var i = 0; i < rows.length; i++) {
push(
(rows[i].match(/pack-clean-title[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '',
(rows[i].match(/pack-clean-size[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '',
(rows[i].match(/href=["']([^"']*\/file\/[^"']*)["']/i) || [])[1] || ''
);
}

// Older layout: plain links, no rows.
if (!files.length) {
var anchors = source.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];

for (var j = 0; j < anchors.length; j++) {
var href = attr((anchors[j].match(/^<a\b[^>]*>/i) || [])[0], 'href');

if (href && /\/file\/[A-Za-z0-9]+/i.test(href)) {
push(text(anchors[j]), '', href);
}
}
}

return files;
}

// "Show.S03E05.Name.1080p.mkv" -> { season: 3, episode: 5 }
function episodeTag(name) {
var value = String(name || '');

var match =
value.match(/\bS(\d{1,2})\s*[.\-_ ]?\s*E(\d{1,3})\b/i) ||
value.match(/\bSeason\s*(\d{1,2})\s*[.\-_ ]?\s*Episode\s*(\d{1,3})\b/i) ||
value.match(/\bS(\d{1,2})\b[^]*?\bE(\d{1,3})\b/i);

if (!match) return null;

return { season: Number(match[1]), episode: Number(match[2]) };
}

function packFileFor(files, season, episode) {
for (var i = 0; i < files.length; i++) {
var tag = episodeTag(files[i].name);

if (tag && tag.season === season && tag.episode === episode) {
return files[i];
}
}

return null;
}

function isArchive(name) {
return /\.(?:zip|rar|7z|tar|gz)$/i.test(String(name || ''));
}

// hubdrive.* /file/<id>  ->  the hubcloud drive page for that file.
async function nextFromHubDrive(url) {
var html = await get(url);
var buttons = pageButtons(html, url);

for (var i = 0; i < buttons.length; i++) {
if (DRIVE_HOST.test(buttons[i].url) || GENERATE_HOST.test(buttons[i].url)) {
return buttons[i].url;
}
}

var r2 = extractR2(html);
if (r2.length) return '';

throw new Error('HubDrive file page has no download server');
}

// hubcloud.* /drive/<id>  ->  the "Generate Direct Download Link" URL.
function generateLink(html) {
var anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];

for (var i = 0; i < anchors.length; i++) {
var href = attr((anchors[i].match(/^<a\b[^>]*>/i) || [])[0], 'href');

if (href && GENERATE_HOST.test(href)) return href;
}

var match = String(html).match(/https:\/\/gamerxyt\.com\/hubcloud\.php\?[^\s"'<>\\]+/i);

return match ? decode(match[0]) : '';
}

// The generated page lists one button per server for the same file,
// so every server can be offered as its own stream with the file size.
var SERVER_ORDER = ['FSL Server', 'FSLv2 Server', 'Pixel Server', 'HubCloud Server'];

function serverNameFromLabel(label) {
var value = String(label || '');
if (/10gbps/i.test(value)) return '';
if (/fslv2|fsl\s*v2/i.test(value)) return 'FSLv2 Server';
if (/\bfsl\b/i.test(value)) return 'FSL Server';
if (/pixel/i.test(value)) return 'Pixel Server';
if (/\bt3\b|hubcloud/i.test(value)) return 'HubCloud Server';
return '';
}

function isHubDriveSource(source) {
var value = String(source || '');

for (var i = 0; i < SERVER_ORDER.length; i++) {
if (value.indexOf(SERVER_ORDER[i]) === 0) return true;
}

return false;
}

function serverRank(source) {
var value = String(source || '');
for (var i = 0; i < SERVER_ORDER.length; i++) {
if (value.indexOf(SERVER_ORDER[i]) === 0) return i;
}
return SERVER_ORDER.length;
}

// File name, quality and size of one generated page.
function fileMeta(html, fallbackQuality) {
var source = String(html || '');
var sizeMatch = source.match(/File Size\s*<i[^>]*>([^<]*)<\/i>/i);
var size = sizeMatch ? text(sizeMatch[1]) : '';
var header =
(source.match(/class=["'][^"']*card-header[^"']*["'][^>]*>([\s\S]{0,400}?)<\/div>/i) || [])[1] ||
(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ||
'';
var fileName = text(header);

return {
size: size,
quality: qualityOf(fileName) || String(fallbackQuality || ''),
fileName: fileName
};
}

function labelWithSize(server, size, quality) {
var parts = [server];
var resolution = displayQuality(quality);

if (resolution && resolution !== 'AUTO') parts.push(resolution);
if (size) parts.push(size);

return parts.join(' · ');
}

// Parse every "Download [.. Server]" button of a generated page.
async function serversFromGenerated(html, fallback, quality) {
var base = fileMeta(html, (fallback && fallback.quality) || quality);
var size = base.size || (fallback && fallback.size) || '';
var label = base.quality || (fallback && fallback.quality) || quality || 'Auto';
var anchors = String(html || '').match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
var picked = [];
var seen = {};

// Pixel links are handed out in two steps: the button carries a shared
// placeholder and a script right after it swaps in the real file (the
// per-file one only ever appears inside that script), so the whole page
// is scanned and every id is verified later.
var pixels = [];
var pixelRe = /pixeldrain\.(?:dev|com)\/u\/([A-Za-z0-9]+)/gi;
var pixelMatch;

while ((pixelMatch = pixelRe.exec(String(html || ''))) !== null) {
if (pixels.indexOf(pixelMatch[1]) < 0 && pixels.length < 3) {
pixels.push(pixelMatch[1]);
}
}

for (var i = 0; i < anchors.length; i++) {
var opening = (anchors[i].match(/^<a\b[^>]*>/i) || [])[0] || '';
var href = decode(attr(opening, 'href'));
var buttonText = text(anchors[i]);

if (!href || !/download/i.test(buttonText)) continue;

var server = serverNameFromLabel(buttonText);
if (!server || seen[server]) continue;

if (server === 'Pixel Server') continue;

// T3 redirects straight to the file; the other servers hand out a
// presigned Cloudflare R2 link on the button itself.
if (/r2\.cloudflarestorage\.com/i.test(href) || /\/t3dl\.php/i.test(href)) {
seen[server] = true;
picked.push({ url: href, server: server });
}
}

var streams = picked.map(function (entry) {
return {
url: entry.url,
quality: label,
source: labelWithSize(entry.server, size, label)
};
});

for (var j = 0; j < pixels.length; j++) {
try {
var pixel = await resolvePixelDrain(pixels[j]);
streams.push({
url: pixel.url,
quality: label,
source: labelWithSize('Pixel Server', size || pixel.size, label)
});
} catch (error) {
// A dead or non-video pixel mirror is simply left out.
reportError('Pixel mirror skipped: ' + String(error));
}
}

streams.sort(function (a, b) {
return serverRank(a.source) - serverRank(b.source);
});

return streams;
}

async function resolveHubCloud(url, quality) {
var html = await get(url);

// Already on the generated page: just read its server buttons.
if (GENERATE_HOST.test(url)) {
var direct = await serversFromGenerated(html, null, quality);

if (!direct.length) {
throw new Error('No download server on the generated page');
}

return direct;
}

var base = fileMeta(html, quality);
var streams = [];
var link = generateLink(html);

if (link) {
try {
var generated = await get(link, {
'User-Agent': 'Mozilla/5.0',
'Referer': url
});

streams = await serversFromGenerated(generated, base, quality);
} catch (error) {
reportError('Generated page failed: ' + String(error));
}
}

// Fall back to whatever the drive page itself links to.
if (!streams.length) {
extractR2(html)
.slice(0, 2)
.forEach(function (value) {
streams.push({
url: value,
quality: base.quality || quality || 'Auto',
source: labelWithSize('HubCloud Server', base.size, base.quality || quality)
});
});
}

if (!streams.length) {
throw new Error('HubCloud direct link not found');
}

return streams;
}

// playdrive.* /e/<id>/s-05/ep-01  ->  the matching play4u episode page.
function play4uEpisodeFrom(html, playdriveUrl) {
var seriesUrl = '';
var anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];

for (var i = 0; i < anchors.length; i++) {
var href = attr((anchors[i].match(/^<a\b[^>]*>/i) || [])[0], 'href');

if (/^https?:\/\/(?:www\.)?play4u\.[a-z]+\//i.test(href)) {
seriesUrl = href;
break;
}
}

if (!seriesUrl) {
var inline = String(html).match(/https?:\/\/(?:www\.)?play4u\.[a-z]+\/series\/[^\s"'<>\\]+/i);
if (inline) seriesUrl = inline[0];
}

if (!seriesUrl) return '';

var baseUrl = seriesUrl.split('#')[0].replace(/\/+$/, '');
var episodePath = String(playdriveUrl).match(/\/s-(\d{1,2})\/ep-(\d{1,3})/i);

if (!episodePath) return baseUrl;

function pad(value) {
return String(value).length < 2 ? '0' + value : String(value);
}

return baseUrl + '/s-' + pad(episodePath[1]) + '/ep-' + pad(episodePath[2]);
}

// Resolve a relative playlist URI against the master playlist.
function joinUrl(baseUrl, reference) {
var ref = String(reference || '').trim();

if (!ref) return '';
if (/^https?:\/\//i.test(ref)) return ref;

var origin = (String(baseUrl).match(/^https?:\/\/[^/]+/i) || [''])[0];

if (ref.charAt(0) === '/') return origin + ref;

var dir = String(baseUrl).replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');

return dir + ref;
}

// One HLS master playlist -> the resolutions it offers.
//   #EXT-X-STREAM-INF:...RESOLUTION=1920x1080
//   /range/<token>
// A resolution can be cropped (1920x800 is a 1080p film), so the
// width decides when the height is not one of the usual numbers.
function resolutionQuality(width, height) {
var direct = qualityOf(height + 'p');

if (direct) return direct;

var w = Number(width) || 0;

if (!w) return '';
if (w >= 3400) return '2160p';
if (w >= 2400) return '1440p';
if (w >= 1800) return '1080p';
if (w >= 1200) return '720p';
if (w >= 800) return '480p';

return '';
}

function hlsVariants(body, masterUrl) {
var lines = String(body || '').split(/\r?\n/);
var variants = [];
var seen = {};

for (var i = 0; i < lines.length; i++) {
if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;

var size = lines[i].match(/RESOLUTION=(\d+)x(\d+)/i) || [];
var width = Number(size[1] || 0);
var height = Number(size[2] || 0);
var uri = '';

for (var j = i + 1; j < lines.length; j++) {
var line = String(lines[j] || '').trim();

if (!line) continue;
if (line.charAt(0) === '#') break;

uri = line;
break;
}

if (!uri) continue;

var url = joinUrl(masterUrl, uri);
var quality = resolutionQuality(width, height);

if (!url || seen[url]) continue;

seen[url] = true;
variants.push({ url: url, quality: quality, width: width, height: height });
}

return variants;
}

// #EXT-X-MEDIA lines: the audio tracks and subtitle playlists of a
// master. They live only here, so a variant URL alone never has them.
function hlsMedia(body, masterUrl) {
var lines = String(body || '').split(/\r?\n/);
var audio = [];
var subtitles = [];
var seenSub = {};

for (var i = 0; i < lines.length; i++) {
var line = lines[i];

if (!/^#EXT-X-MEDIA:/i.test(line)) continue;

var type = ((line.match(/TYPE=([A-Za-z_]+)/) || [])[1] || '').toUpperCase();
var name = (line.match(/NAME="([^"]*)"/) || [])[1] || '';
var lang = (line.match(/LANGUAGE="([^"]*)"/) || [])[1] || '';
var uri = (line.match(/URI="([^"]*)"/) || [])[1] || '';

if (type === 'AUDIO') {
audio.push({ name: name, lang: lang });
continue;
}

if (type !== 'SUBTITLES' || !uri) continue;

var url = joinUrl(masterUrl, uri);

if (!url || seenSub[url]) continue;

seenSub[url] = true;
subtitles.push({ url: url, label: name || lang || 'Subtitles', lang: lang });
}

return { audio: audio, subtitles: subtitles };
}

async function play4uPlaylist(masterUrl, headers) {
try {
var body = await fetchUrl(masterUrl, headers, TIMEOUT.page);

return {
variants: hlsVariants(body, masterUrl),
media: hlsMedia(body, masterUrl)
};
} catch (error) {
log('play4u: playlist read failed – ' + String(error.message || error));

return { variants: [], media: { audio: [], subtitles: [] } };
}
}

async function resolvePlay4u(url) {
var html = await get(url, {
'User-Agent': 'Mozilla/5.0',
'Referer': 'https://play4u.org/'
});

var keyMatch = html.match(/__PA_SEAL_KEY__\s*=\s*"([^"]+)"/);
var key = keyMatch ? keyMatch[1] : 'pa4u-stream-seal-v1';

var playMatch = html.match(/__PA_PLAY__\s*=\s*(\{[\s\S]*?\})\s*;\s*\n/);

if (!playMatch) {
throw new Error('Player data not found on the play4u page');
}

var data;

try {
data = JSON.parse(playMatch[1]);
} catch (error) {
throw new Error('Player data could not be read');
}

var streams = (data && data.streams) || [];
var item = (data && (data.item || data.movie || data.series)) || {};
var qualities = (item.qualities || [])
.map(function (quality) { return quality && quality.label; })
.filter(Boolean);

if (!streams.length) {
throw new Error('No stream listed for this episode');
}

var out = [];

// The HLS host answers only with this Referer.
var streamHeaders = { Referer: 'https://play4u.org/' };
var masters = [];

streams.forEach(function (stream) {
var sealed = stream.m3u8_url || stream.video_url || '';
var master = unseal(sealed, key);

if (!/^https?:\/\//i.test(master)) return;

if (masters.indexOf(master) < 0) masters.push(master);
});

// Every master playlist is read once: it names the resolutions, the
// audio tracks and the subtitle playlists.
var offers = await Promise.all(
masters.map(function (master) { return play4uPlaylist(master, streamHeaders); })
);

masters.forEach(function (master, index) {
var offer = offers[index] || { variants: [], media: { audio: [], subtitles: [] } };
var variants = offer.variants || [];
var media = offer.media || { audio: [], subtitles: [] };
var known = variants
.map(function (variant) { return variant.quality; })
.filter(Boolean);

// The master is what makes the player show its Quality tab with the
// audio tracks and subtitles intact, so it is the row that is listed.
out.push({
url: master,
quality: 'Auto',
source:
'Play4u · HLS' +
(media.audio.length ? ' \u00b7 ' + media.audio.length + ' audio' : '') +
(media.subtitles.length ? ' \u00b7 ' + media.subtitles.length + ' sub' : ''),
headers: streamHeaders,
subtitles: media.subtitles
});

// Optional: one row per resolution instead. Those are plain video
// playlists, so audio tracks and subtitles do not come with them.
if (SPLIT_QUALITIES) {
variants.forEach(function (variant) {
if (!variant.quality) return;

out.push({
url: variant.url,
quality: variant.quality,
source: 'Play4u · HLS' + (known.length ? ' (' + known.join('/').toUpperCase() + ')' : ''),
headers: streamHeaders
});
});
}

// Could not read the playlist: keep the qualities the page claims.
if (!variants.length && !out.length && qualities.length) {
qualities.forEach(function (quality) {
out.push({
url: master,
quality: quality,
source: 'Play4u · HLS',
headers: streamHeaders
});
});
}
});

if (!out.length) {
throw new Error('Stream link could not be unsealed');
}

return out;
}

async function resolvePlayDrive(url, quality) {
var html = await get(url, {
'User-Agent': 'Mozilla/5.0',
'Referer': origin() + '/'
});

// Movies (and some episodes) ship the whole player on the page itself:
// the same sealed __PA_PLAY__ data the player site uses.
var streams =
String(html).indexOf('__PA_PLAY__') >= 0
? await resolvePlay4u(url)
: await resolvePlay4u(
play4uEpisodeFrom(html, url) || (function () {
throw new Error('play4u episode page not found');
})()
);

// Every row already knows its resolution (720P / 1080P / AUTO), so the
// quality printed on the post heading is not stamped over them.

if (quality) {
streams.forEach(function (stream) {
if (!stream.quality) stream.quality = quality;
});
}

// The app opens playdrive.vip links, so that is the name it shows.
streams.forEach(function (stream) {
stream.source = String(stream.source || '').replace(/^Play4u/, 'PlayDrive');
});

return streams;
}

// A pack page holds many files. With an episode hint only that
// episode's file is opened; otherwise every playable file is used.
async function resolvePack(url, quality, depth, season, episode) {
var html = await get(url, {
'User-Agent': 'Mozilla/5.0',
'Referer': origin() + '/'
});

var files = packFiles(html, url);

if (!files.length) {
throw new Error('HubDrive pack page lists no files');
}

var chosen = [];
var hinted = season && episode ? packFileFor(files, season, episode) : null;

if (hinted) {
chosen = [hinted];
} else {
var playable = files.filter(function (file) { return !isArchive(file.name); });

if (files.length === 1) {
chosen = files;
} else if (playable.length) {
chosen = playable.slice(0, 3);
} else {
chosen = files.slice(0, 1);
}
}

var streams = [];

for (var i = 0; i < chosen.length; i++) {
try {
var rows = await resolveStreams(
chosen[i].url,
qualityOf(chosen[i].name) || quality,
depth + 1
);

// Several files at once need to say which one they are.
if (chosen.length > 1) {
var tag = episodeTag(chosen[i].name);
var suffix = tag
? ' \u00b7 S' + (tag.season < 10 ? '0' : '') + tag.season +
'E' + (tag.episode < 10 ? '0' : '') + tag.episode
: '';

rows.forEach(function (row) {
if (suffix) row.source = row.source + suffix;
});
}

streams = streams.concat(rows);
} catch (error) {
reportError('pack file failed: ' + String(error.message || error));
}
}

if (!streams.length) {
throw new Error('HubDrive pack has no playable file');
}

return streams;
}

// Resolve any URL this plugin understands into playable streams.
async function resolveStreams(url, quality, depth) {
if (depth > 4) return [];

if (STREAM_HOST.test(url)) {
return resolveHdStream(url);
}

if (PACK_HOST.test(url)) {
return resolvePack(url, quality, depth, null, null);
}

if (FILE_HOST.test(url)) {
var next = await nextFromHubDrive(url);

if (next) return resolveStreams(next, quality, depth + 1);

return resolveHubCloud(url, quality);
}

if (DRIVE_HOST.test(url)) {
return resolveHubCloud(url, quality);
}

if (GENERATE_HOST.test(url)) {
return resolveHubCloud(url, quality);
}

if (/^https?:\/\/(?:www\.)?play4u\.[a-z]+\//i.test(url)) {
return resolvePlay4u(url);
}

if (PLAY_HOST.test(url)) {
return resolvePlayDrive(url, quality);
}

return [];
}

// =====================================
// DETAIL
// =====================================

async function load(url, callback) {
try {
await ensureOrigin(false);

if (!isSiteUrl(url)) {
throw new Error('Not a page on HDHub4u');
}

var page = origin() + sitePath(url);
var html = await get(page);

var rawTitle = cleanTitle(
(html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i) || [])[0] ||
meta(html, 'og:title')
);

if (!rawTitle) {
throw new Error('Could not find title');
}

var imageTag =
(html.match(/<meta\b(?=[^>]*\bitemprop=["']image["'])[^>]*>/i) || [])[0];

var posterUrl = attr(imageTag, 'content') || meta(html, 'og:image');
var itemType = kind(rawTitle, page);

var episodes = itemType === 'movie'
? [
new Episode({
name: 'Full Movie',
url: page,
season: 1,
episode: 1
})
]
: await seriesEpisodes(html, page, rawTitle);

log('load: ' + itemType + ' with ' + episodes.length + ' episode(s)');

callback({
success: true,
data: new MultimediaItem({
title: shortTitle(rawTitle),
url: page,
posterUrl: tmdbSize(absolute(posterUrl), 'w500'),
bannerUrl: tmdbSize(absolute(posterUrl), 'w1280'),
type: itemType,
year: yearOf(rawTitle),
description: meta(html, 'description') || meta(html, 'og:description'),
episodes: episodes
})
});
} catch (error) {
fail(callback, error);
}
}

// =====================================
// STREAMS
// =====================================

async function loadStreams(url, callback) {
try {
await ensureOrigin(false);

url = String(url || '').trim();

// An episode link may carry the episode's own HubDrive file after a
// "#h=" marker (added by seriesEpisodes): the player stream and the
// file servers are then both offered.
var extraUrls = [];
var hashAt = url.indexOf('#h=');

if (hashAt >= 0) {
try {
extraUrls = decodeURIComponent(url.slice(hashAt + 3))
.split('|')
.filter(Boolean);
} catch (error) {
extraUrls = [];
}

url = url.slice(0, hashAt);
}

// Already a playable file.
if (/^https?:\/\/[^\s]+\.(?:mp4|m3u8|mkv)(?:[?#].*)?$/i.test(url) ||
/^https:\/\/[A-Za-z0-9-]+\.r2\.cloudflarestorage\.com\//i.test(url) ||
/^https:\/\/[A-Za-z0-9-]+\.r2\.dev\//i.test(url)) {
return callback({
success: true,
data: [new StreamResult({ url: url, source: 'Direct', quality: 'Auto' })]
});
}

var collected = [];
var seriesFirst = [];
var blocked = 0;
var failures = 0;
var quality = '';

// The marker may be gone but load() already matched this episode to a
// file. Its chain runs at the same time as the player link, so the two
// never wait for one another.
if (STREAM_SOURCE === 'playdrive') {
extraUrls = [];
} else if (!extraUrls.length && EPISODE_FILES[url]) {
// The episode's own file and its sibling qualities: every one of
// them is resolved, so the copy the episode points at is never lost.
extraUrls = [url].concat(EPISODE_FILES[url]);
}

var seenExtra = {};

extraUrls = extraUrls.filter(function (extra) {
if (!extra || BLOCKED_HOST.test(extra)) return false;
if (seenExtra[extra]) return false;

seenExtra[extra] = true;
return true;
});

var extraPending = extraUrls.length
? Promise.all(
extraUrls.map(function (extra) {
return resolveStreams(extra, '', 0).then(null, function (error) {
reportError('episode file failed: ' + String(error.message || error));

return [];
});
})
).then(function (lists) {
return lists.reduce(function (all, list) { return all.concat(list); }, []);
})
: null;

// A direct host page (episode link, file page, player page).
if (!isSiteUrl(url)) {
if (BLOCKED_HOST.test(url)) {
return callback({
success: false,
errorCode: 'UNKNOWN_ERROR',
message:
'This link points to an ad-gated download host that the ' +
'plugin cannot open directly. Use the play button on the ' +
'post page instead.'
});
}

// The episode carries its own HubDrive file: that is the source.
if (!(STREAM_SOURCE === 'hubdrive' && extraPending)) {
try {
collected = await resolveStreams(url, '', 0);
} catch (error) {
failures++;
reportError('Resolve failed: ' + String(error));
}
}
} else {
// A post page: gather every button that leads to a known host.
var page = origin() + sitePath(url);
var html = await get(page);
var buttons = uniqueBy(
pageButtons(html, page).filter(function (button) {
return PLAY_HOST.test(button.url) ||
STREAM_HOST.test(button.url) ||
FILE_HOST.test(button.url) ||
DRIVE_HOST.test(button.url) ||
GENERATE_HOST.test(button.url);
}),
function (button) { return button.url; }
);

if (STREAM_SOURCE === 'hubdrive') {
// Ad-gated hosts are never opened, so they are not even resolved.
buttons = buttons.filter(function (button) {
return !BLOCKED_HOST.test(button.url);
});

// File links beat watch links: with them the list is HubDrive only.
var fileButtons = buttons.filter(function (button) {
return FILE_HOST.test(button.url);
});

if (fileButtons.length) buttons = fileButtons;
} else if (STREAM_SOURCE === 'playdrive') {
// PlayDrive links first; other players only when there is no
// PlayDrive one, and a HubDrive file is never opened.
var playDriveButtons = buttons.filter(function (button) {
return PLAY_HOST.test(button.url);
});

var playerButtons = buttons.filter(function (button) {
return PLAY_HOST.test(button.url) || STREAM_HOST.test(button.url);
});

buttons = playDriveButtons.length
? playDriveButtons
: playerButtons.length
? playerButtons
: buttons.filter(function (button) { return !FILE_HOST.test(button.url); });
}

if (buttons.length) {
quality = buttons[0].quality || qualityOf(html);
}

// Watch links resolve to HLS, file links to full-quality files;
// best quality first.
var ordered = buttons.slice().sort(function (a, b) {
return qualityRank(b.quality) - qualityRank(a.quality);
});

// A series post lists one button per episode. Each episode is a
// separate playable, so resolve only the first one instead of
// returning nine different episodes as if they were qualities.
var pageTitle = cleanTitle(
(html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i) || [])[0] ||
meta(html, 'og:title')
);

if (kind(pageTitle, page) === 'series') {
var watchButtons = ordered.filter(function (button) {
return PLAY_HOST.test(button.url);
});

if (watchButtons.length) {
ordered = watchButtons.slice(0, 1);
} else {
// "1080p WEB-DL PACK [33.7GB]" is a whole season, not one
// playable: per-episode links win when the post has both.
var perEpisode = ordered.filter(function (button) {
return !isSeasonArchive(button.label);
});

// One "EP – PACK" per quality: all of them are read so the episode
// comes back with every quality it has.
ordered = (perEpisode.length ? perEpisode : ordered).slice(0, 3);
}
}

// A movie post with no HubDrive link: HUBLinks lists its files.
if (STREAM_SOURCE === 'hubdrive' && !buttons.length && kind(pageTitle, page) === 'movie') {
try {
var movieFiles = await hubMovieFiles(pageTitle);

for (var mf = 0; mf < movieFiles.length; mf++) {
collected = collected.concat(
await resolveStreams(movieFiles[mf], qualityOf(html), 0)
);
}
} catch (error) {
reportError('hblinks movie lookup failed: ' + String(error.message || error));
}
}

// A series post is an episode list, not one playable: whatever its
// buttons hold (a whole-season pack, an episode pack, ad-gated watch
// links), it opens on its first episode — the Drive links next to
// that episode on the post, or HUBLinks when the post lists none.
seriesFirst = [];

if (STREAM_SOURCE === 'hubdrive' && kind(pageTitle, page) === 'series') {
try {
var seriesSeason = seasonOf(pageTitle, html);
var postBlocks = episodeFileIndex(html, page, seriesSeason);
var postKeys = Object.keys(postBlocks).sort(byEpisodeKey);

seriesFirst = await resolveFirstEpisode(
postBlocks,
postKeys,
'post',
html
);

// 2. HUBLinks: one post per episode, each with that episode's
//    HubDrive files.
if (!seriesFirst.length) {
var hubFirst = await hubEpisodeFiles(pageTitle, seriesSeason, 1);
var hubKeys = Object.keys(hubFirst).sort(byEpisodeKey);

seriesFirst = await resolveFirstEpisode(
hubFirst,
hubKeys,
'hblinks',
html
);
}

// 3. Last resort: the post's own pack pages (one per quality), whose
//    rows name the episode they belong to.
if (!seriesFirst.length) {
// HubDrive file / pack buttons only — never a player — and the rows
// they give must name an episode: a whole-season file is not one.
var packButtons = uniqueBy(
ordered.filter(function (button) {
return (
PACK_HOST.test(button.url) ||
(FILE_HOST.test(button.url) && !isSeasonArchive(button.label))
);
}),
function (button) { return button.url; }
).slice(0, 3);

if (packButtons.length) {
var packLists = await Promise.all(
packButtons.map(function (button) {
return resolveStreams(
button.url,
button.quality || qualityOf(html),
0
).then(null, function (error) {
reportError('pack page failed: ' + String(error.message || error));

return [];
});
})
);

var packStreams = packLists.reduce(function (all, list) {
return all.concat(list);
}, []);

var tagged = packStreams.filter(function (stream) {
return !!streamEpisodeTag(stream);
});

if (tagged.length) {
seriesFirst = tagged;

log('post: pack pages -> ' + packButtons.length + ' page(s), ' +
tagged.length + ' episode row(s)');
}
}
}

} catch (error) {
reportError('series first-episode lookup failed: ' + String(error.message || error));
}
}

var limited = seriesFirst.length ? [] : ordered.slice(0, 6);

// Every button is resolved at once: each quality file needs its own
// hubdrive -> hubcloud -> generated page chain.
var resolvedButtons = await Promise.all(
limited.map(function (button) {
return resolveStreams(button.url, button.quality || quality, 0).then(
function (streams) {
return (streams || []).map(function (stream) {
// Only a row with no resolution of its own takes the button's
// quality; an "Auto" row stays Auto on purpose.
if (!stream.quality) {
stream.quality = button.quality || quality || 'Auto';
}

return stream;
});
},
function (error) {
failures++;
reportError('Button resolve failed: ' + String(error));

return [];
}
);
})
);

resolvedButtons.forEach(function (streams) {
collected = collected.concat(streams);
});

if (!buttons.length) {
// No HDHub4u host buttons at all: is it a download-only post?
if (/greenmotors\.[a-z]+\/\?id=|hdstream4u\.[a-z]+\/file\/|hubstream\.[a-z]+\/#/i.test(html)) {
blocked++;
}
}
}

if (extraPending) {
collected = collected.concat(await extraPending);
}

// The first episode's files are the whole answer for a series post.
if (seriesFirst.length) collected = collected.concat(seriesFirst);

// A pack page resolved through a button can still hand back several
// episodes: only the earliest one belongs to this answer.
if (STREAM_SOURCE === 'hubdrive' && kind(pageTitle, page) === 'series') {
var earliestTag = null;

collected.forEach(function (stream) {
var tag = streamEpisodeTag(stream);

if (!tag) return;
if (
!earliestTag ||
tag.season < earliestTag.season ||
(tag.season === earliestTag.season && tag.episode < earliestTag.episode)
) {
earliestTag = tag;
}
});

if (earliestTag) {
collected = collected.filter(function (stream) {
var tag = streamEpisodeTag(stream);

return !tag ||
(tag.season === earliestTag.season && tag.episode === earliestTag.episode);
});
}
}

var seen = {};

var selected = collected
.filter(function (stream) {
if (!stream || !stream.url) return false;

// A season archive cannot be played, so it is not a stream row.
if (isArchiveStream(stream)) return false;

// Ignore the query string when de-duplicating: the same file can be
// handed out with two different presigned signatures.
var key = stream.url.split('?')[0];

if (seen[key]) return false;

seen[key] = true;
return true;
})
.sort(function (a, b) {
return (
qualityPriority(a.quality) - qualityPriority(b.quality) ||
qualityRank(b.quality) - qualityRank(a.quality) ||
serverRank(a.source) - serverRank(b.source)
);
});

if (STREAM_SOURCE === 'hubdrive') {
// Player links are never listed: only the HubDrive file servers are.
selected = selected.filter(function (stream) {
return isHubDriveSource(stream.source);
});

// 480P is only kept when it is the single copy of the episode.
if (selected.some(function (stream) { return qualityRank(stream.quality) > 480; })) {
selected = selected.filter(function (stream) { return qualityRank(stream.quality) !== 480; });
}
} else if (STREAM_SOURCE === 'playdrive') {
// HubDrive rows are removed, whatever produced them, and a PlayDrive
// row wins over any other player on the same post.
selected = selected.filter(function (stream) {
return !isHubDriveSource(stream.source);
});

var playDriveStreams = selected.filter(function (stream) {
return /^PlayDrive/i.test(String(stream.source || ''));
});

if (playDriveStreams.length) selected = playDriveStreams;

selected = selected.map(function (stream) {
// Every player row is the PlayDrive source, whichever host the
// episode link itself pointed at.
stream.source = String(stream.source || '').replace(/^Play4u/, 'PlayDrive');

return stream;
});
}

var streams = selected.map(function (stream) {
return new StreamResult({
url: stream.url,
source: stream.source,
quality: displayQuality(stream.quality),
headers: stream.headers,
subtitles: stream.subtitles
});
});

if (!streams.length) {
return callback({
success: false,
errorCode: 'UNKNOWN_ERROR',
message: STREAM_SOURCE === 'hubdrive'
? 'This post has no HubDrive file link (only player links, which ' +
  'are turned off). Open the post on the website instead.'
: blocked
? 'This post only offers download links on ad-gated hosts ' +
  '(greenmotors / hdstream4u / hubstream), which cannot be ' +
  'opened in the app. Open the post on the website instead.'
: failures
? 'No direct stream found; a host page could not be loaded. ' +
  'Try another quality or open the post on the website.'
: 'No playable stream found for this title.'
});
}

callback({ success: true, data: streams });
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

log('exports registered: getHome, search, load, loadStreams');
})();
