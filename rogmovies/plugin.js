/* SkyStream RogMovies provider — browsing and direct-media links.
 * Set baseUrl in plugin.json. This does not resolve third-party download
 * pages or protected embeds; use only media you are authorized to access.
 */
(function () {
  'use strict';

  function base() {
    return String(manifest.baseUrl || 'https://rogmovies.im').replace(/\/+$/, '');
  }
  function decode(s) {
    return String(s || '').replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');
  }
  function text(s) { return decode(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
  function attr(tag, name) {
    var m = String(tag || '').match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
    return m ? decode(m[1] || m[2] || m[3] || '') : '';
  }
  function absolute(url) {
    url = decode(url || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (url.indexOf('//') === 0) return 'https:' + url;
    if (url.charAt(0) === '/') return base() + url;
    return url ? base() + '/' + url : '';
  }
  function isSourcePage(url) {
    return url.indexOf(base() + '/') === 0;
  }
  async function get(url) {
    var res = await http_get(url, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml' });
    if (!res || (res.status && (res.status < 200 || res.status >= 400))) throw new Error('HTTP request failed: ' + (res && res.status));
    return String(res.body || '');
  }
  function cleanTitle(s) { return text(s).replace(/^download\s+/i, '').trim(); }
  function kind(title) { return /\b(series|season|episodes?|s\d{1,2}e\d{1,3}|tv[ -]?show)\b/i.test(title) ? 'series' : 'movie'; }
  function yearOf(title) { var m = title.match(/\b(19\d{2}|20\d{2})\b/); return m ? Number(m[1]) : undefined; }
  function listings(html) {
    var items = [], seen = {}, matches = html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
    matches.forEach(function (a) {
      var opening = (a.match(/^<a\b[^>]*>/i) || [])[0] || '';
      var href = absolute(attr(opening, 'href'));
      if (!isSourcePage(href) || !/\/download-/i.test(href) || seen[href]) return;
      var image = (a.match(/<img\b[^>]*>/i) || [])[0] || '';
      if (!image) return;
      var title = cleanTitle(attr(image, 'alt') || text(a));
      var poster = absolute(attr(image, 'data-src') || attr(image, 'src'));
      if (!title || !poster) return;
      seen[href] = true;
      items.push(new MultimediaItem({ title: title, url: href, posterUrl: poster, type: kind(title), year: yearOf(title) }));
    });
    return items;
  }
  function meta(html, key) {
    var tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (var i = 0; i < tags.length; i++) {
      if ((attr(tags[i], 'property') || attr(tags[i], 'name')).toLowerCase() === key.toLowerCase()) return attr(tags[i], 'content');
    }
    return '';
  }
  function fail(cb, e) { cb({ success: false, errorCode: 'UNKNOWN_ERROR', message: String(e && e.message || e) }); }

  async function getHome(cb) {
    var sections = [
      { name: 'Latest Release', path: '/' },
      { name: 'TV Shows', path: '/tv-shows/' },
      { name: 'Netflix', path: '/web-series/netflix/' },
      { name: 'Amazon Prime', path: '/web-series/amazon-prime-video/' },
      { name: 'Jio Hotstar', path: '/web-series/jiohotstar/' },
      { name: 'SonyLiv', path: '/web-series/sonyliv/' }
    ];
    try {
      var results = await Promise.all(sections.map(async function (section) {
        try {
          return { items: listings(await get(base() + section.path)), error: null };
        } catch (e) {
          console.error('Home section ' + section.name + ': ' + String(e));
          return { items: [], error: e };
        }
      }));
      if (results.every(function (result) { return result.error; })) {
        throw new Error('Unable to load any home section');
      }
      var data = {};
      sections.forEach(function (section, index) { data[section.name] = results[index].items; });
      cb({ success: true, data: data });
    } catch (e) { fail(cb, e); }
  }
  async function search(query, page, cb) {
    if (typeof page === 'function') { cb = page; page = 1; }
    try {
      var p = Math.max(1, parseInt(page, 10) || 1);
      var url = base() + (p > 1 ? '/page/' + p + '/' : '/') + '?s=' + encodeURIComponent(query || '');
      cb({ success: true, data: listings(await get(url)) });
    } catch (e) { fail(cb, e); }
  }
  async function load(url, cb) {
    try {
      if (!isSourcePage(url)) throw new Error('Not a page on the configured site');
      var html = await get(url);
      var h1 = (html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i) || [])[0];
      var title = cleanTitle(h1 || meta(html, 'og:title'));
      if (!title) throw new Error('Could not find title');
      var imageTag = (html.match(/<meta\b(?=[^>]*\bitemprop=["']image["'])[^>]*>/i) || [])[0];
      var poster = absolute(attr(imageTag, 'content') || meta(html, 'og:image'));
      var item = new MultimediaItem({ title: title, url: url, posterUrl: poster, type: kind(title), year: yearOf(title), description: meta(html, 'description') || meta(html, 'og:description') });
      cb({ success: true, data: item });
    } catch (e) { fail(cb, e); }
  }
  async function loadStreams(url, cb) {
    try {
      if (!isSourcePage(url)) throw new Error('Not a page on the configured site');
      var html = await get(url), tags = html.match(/<(?:a|source|video)\b[^>]*>/gi) || [];
      var found = [], seen = {};
      tags.forEach(function (tag) {
        var u = absolute(attr(tag, 'href') || attr(tag, 'src'));
        if (!/^https?:\/\//i.test(u) || !/\.(?:mp4|m3u8|mkv)(?:\?|#|$)/i.test(u) || seen[u]) return;
        seen[u] = true;
        var quality = (u.match(/\b(2160|1080|720|480|360)p?\b/i) || [])[1] || 'Auto';
        found.push(new StreamResult({ url: u, source: 'Direct', quality: quality, headers: { Referer: url } }));
      });
      cb({ success: true, data: found });
    } catch (e) { fail(cb, e); }
  }
  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();
