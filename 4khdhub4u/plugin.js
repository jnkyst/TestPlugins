/* 4KHDHub SkyStream provider: home, search and basic details.
 * Use only content you are authorized to access.
 * Playback and series-episode extraction are not implemented.
 */
(function () {
  'use strict';

  function base() {
    return String(manifest.baseUrl || '').replace(/\/+$/, '');
  }

  function decode(value) {
    return String(value || '')
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) {
        try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; }
      })
      .replace(/&#(\d+);/g, function (_, n) {
        try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return ''; }
      })
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');
  }

  function text(value) {
    return decode(String(value || '').replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ').trim();
  }

  function attr(tag, name) {
    var pattern = '(?:^|\\s)' + name +
      '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))';
    var match = String(tag || '').match(new RegExp(pattern, 'i'));
    return match ? decode(match[1] || match[2] || match[3] || '') : '';
  }

  function absolute(url) {
    url = decode(url || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    if (url.indexOf('//') === 0) return 'https:' + url;
    if (url.charAt(0) === '/') return base() + url;
    return url ? base() + '/' + url : '';
  }

  function isPostPage(url) {
    return url.indexOf(base() + '/') === 0 &&
      /-(?:movie|series)-\d+\/?(?:[?#].*)?$/i.test(url);
  }

  function kind(title, url) {
    return /-series-\d+/i.test(url) || /\b(?:series|season|episodes?)\b/i.test(title)
      ? 'series' : 'movie';
  }

  function yearOf(value) {
    var match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
    return match ? Number(match[1]) : undefined;
  }

  function fail(callback, error) {
    callback({ success: false, errorCode: 'UNKNOWN_ERROR',
      message: String(error && error.message ? error.message : error) });
  }

  async function get(url) {
    var response = await http_get(url, {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/html,application/xhtml+xml'
    });
    if (!response || (response.status && (response.status < 200 || response.status >= 400))) {
      throw new Error('HTTP request failed: ' + (response && response.status));
    }
    return String(response.body || '');
  }

  function listings(html) {
    var items = [], seen = {};
    var cards = html.match(/<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bmovie-card\b[^"']*["'])[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
    cards.forEach(function (card) {
      var opening = (card.match(/^<a\b[^>]*>/i) || [])[0] || '';
      var href = absolute(attr(opening, 'href'));
      if (!isPostPage(href) || seen[href]) return;
      var image = (card.match(/<img\b[^>]*>/i) || [])[0] || '';
      var heading = (card.match(/<h3\b[^>]*class=["'][^"']*\bmovie-card-title\b[^"']*["'][^>]*>[\s\S]*?<\/h3\s*>/i) || [])[0] || '';
      var meta = (card.match(/<p\b[^>]*class=["'][^"']*\bmovie-card-meta\b[^"']*["'][^>]*>[\s\S]*?<\/p\s*>/i) || [])[0] || '';
      var title = text(heading) || attr(image, 'alt');
      var poster = absolute(attr(image, 'data-src') || attr(image, 'data-lazy-src') || attr(image, 'src'));
      if (!title || !poster) return;
      seen[href] = true;
      items.push(new MultimediaItem({ title: title, url: href, posterUrl: poster,
        type: kind(title, href), year: yearOf(text(meta) || title) }));
    });
    return items;
  }

  function meta(html, key) {
    var tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (var i = 0; i < tags.length; i++) {
      var name = attr(tags[i], 'property') || attr(tags[i], 'name');
      if (name.toLowerCase() === key.toLowerCase()) return attr(tags[i], 'content');
    }
    return '';
  }

  async function getHome(callback) {
    var sections = [
      { name: 'Latest Release', path: '/' },
      { name: 'Netflix', path: '/category/netflix/' },
      { name: 'Amazon Prime', path: '/category/amazon_prime_video/' }
    ];
    try {
      var results = await Promise.all(sections.map(async function (section) {
        try { return { items: listings(await get(base() + section.path)) }; }
        catch (error) {
          console.error('Home section ' + section.name + ': ' + String(error));
          return { items: [], error: error };
        }
      }));
      var data = {}, found = false;
      sections.forEach(function (section, i) {
        if (results[i].items.length) { data[section.name] = results[i].items; found = true; }
      });
      if (!found) {
        var failure = results.find(function (r) { return r.error; });
        throw failure ? failure.error : new Error('No home items found');
      }
      callback({ success: true, data: data });
    } catch (error) { fail(callback, error); }
  }

  async function search(query, page, callback) {
    if (typeof page === 'function') { callback = page; page = 1; }
    try {
      var term = String(query || '').trim();
      if (!term) return callback({ success: true, data: [] });
      var n = Math.max(1, parseInt(page, 10) || 1);
      var path = n === 1 ? '/' : '/page/' + n + '/';
      var html = await get(base() + path + '?s=' + encodeURIComponent(term));
      callback({ success: true, data: listings(html) });
    } catch (error) { fail(callback, error); }
  }

  async function load(url, callback) {
    try {
      if (!isPostPage(url)) throw new Error('Not a supported 4KHDHub post URL');
      var html = await get(url);
      var heading = (html.match(/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/i) || [])[0] || '';
      var title = text(heading) || meta(html, 'og:title').replace(/\s*-\s*4K-HDHub\s*$/i, '');
      if (!title) throw new Error('Could not find title');
      var poster = absolute(meta(html, 'og:image'));
      var type = kind(title, url);
      var episodes = type === 'movie'
        ? [new Episode({ name: 'Full Movie', url: url, season: 1, episode: 1 })]
        : [];
      callback({ success: true, data: new MultimediaItem({
        title: title, url: url, posterUrl: poster, bannerUrl: poster,
        type: type, year: yearOf(title),
        description: meta(html, 'description') || meta(html, 'og:description'),
        episodes: episodes
      }) });
    } catch (error) { fail(callback, error); }
  }

  async function loadStreams(url, callback) {
    // The current site links through an intermediate host that this
    // implementation does not resolve. Do not return it as a video URL.
    fail(callback, new Error('Playback is not implemented for this site.'));
  }

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();
