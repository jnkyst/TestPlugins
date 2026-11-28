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

  // Read individual episode filenames without inventing episodes from packs.
  function episodeEntries(html) {
    var entries = {}, re = /<div\b[^>]*class=["'][^"']*\bepisode-file-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/gi, m;
    while ((m = re.exec(html))) {
      var filename = text(m[1]);
      var number = filename.match(/(?:^|[^a-z0-9])s(\d{1,2})e(\d{1,3})(?!\d)/i);
      if (!number) continue;
      var season = Number(number[1]), episode = Number(number[2]);
      var key = season + ':' + episode;
      if (!entries[key]) entries[key] = { season: season, episode: episode };
    }
    return Object.keys(entries).map(function (key) { return entries[key]; })
      .sort(function (a, b) { return a.season - b.season || a.episode - b.episode; });
  }

  function individualLinks(html, season, episode) {
    var re = /<div\b[^>]*class=["'][^"']*\bepisode-download-item\b[^"']*["'][^>]*>/gi;
    var starts = [], m, out = [];
    while ((m = re.exec(html))) starts.push(m.index);
    starts.forEach(function (start, i) {
      var block = html.slice(start, i + 1 < starts.length ? starts[i + 1] : html.length);
      var file = (block.match(/<div\b[^>]*class=["'][^"']*\bepisode-file-title\b[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i) || [])[1] || '';
      var n = text(file).match(/(?:^|[^a-z0-9])s(\d{1,2})e(\d{1,3})(?!\d)/i);
      if (!n || Number(n[1]) !== season || Number(n[2]) !== episode) return;
      var tags = block.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
      tags.forEach(function (tag) {
        var href = attr((tag.match(/^<a\b[^>]*>/i) || [])[0], 'href');
        if (/^https:\/\/greenmotors\.(?:club|cc)\//i.test(href) && /hubcloud/i.test(text(tag))) {
          var quality = (text(file).match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1] || 'Auto';
          if (!out.some(function (entry) { return entry.url === href; })) out.push({ url: href, quality: quality });
        }
      });
    });
    return out;
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
        : episodeEntries(html).map(function (ep) {
          return new Episode({ name: 'Episode ' + ep.episode,
            url: url + '#skyepisode=' + ep.season + '-' + ep.episode,
            season: ep.season, episode: ep.episode });
        });
      callback({ success: true, data: new MultimediaItem({
        title: title, url: url, posterUrl: poster, bannerUrl: poster,
        type: type, year: yearOf(title),
        description: meta(html, 'description') || meta(html, 'og:description'),
        episodes: episodes
      }) });
    } catch (error) { fail(callback, error); }
  }

  function decode64(value) {
    var input = String(value || '').replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (typeof atob === 'function') return atob(input);
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '', bits = 0, count = 0;
    for (var i = 0; i < input.length; i++) {
      var v = alphabet.indexOf(input.charAt(i));
      if (v < 0) continue;
      bits = (bits << 6) | v; count += 6;
      if (count >= 8) { count -= 8; out += String.fromCharCode((bits >> count) & 255); }
    }
    return out;
  }

  function rot13(s) {
    return String(s).replace(/[a-z]/gi, function (c) {
      var baseCode = c <= 'Z' ? 65 : 97;
      return String.fromCharCode((c.charCodeAt(0) - baseCode + 13) % 26 + baseCode);
    });
  }

  async function resolveHubLink(url) {
    var html = await get(url);
    var encoded = html.match(/\bs\s*\(\s*["']o["']\s*,\s*["']([A-Za-z0-9+/=_-]+)["']/i);
    if (!encoded) throw new Error('Intermediate link format changed');
    var data = JSON.parse(decode64(rot13(decode64(decode64(encoded[1])))));
    var hub = decode64(data.o || '');
    if (!/^https:\/\/(?:www\.)?hubcloud\.(?:mov|pw|cx)\/drive\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i.test(hub)) {
      throw new Error('Unsupported file host');
    }
    var hubHtml = await get(hub);
    var generator = hubHtml.match(/https:\/\/gamerxyt\.com\/hubcloud\.php\?[^\s"'<>]+/i);
    if (!generator) throw new Error('HubCloud download link not found');
    var page = await get(decode(generator[0]));
    var anchors = page.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
    var results = [];
    anchors.forEach(function (anchor) {
      var tag = (anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';
      var href = attr(tag, 'href');
      if (/^https:\/\/[a-z0-9-]+\.r2\.cloudflarestorage\.com\//i.test(href)) {
        results.push({ url: href, source: text(anchor) || 'HubCloud' });
      }
    });
    if (!results.length) throw new Error('No direct HubCloud video URL found');
    return results;
  }

  async function loadStreams(url, callback) {
    try {
      var match = String(url || '').match(/^(https?:\/\/[^#]+)#skyepisode=(\d+)-(\d+)$/);
      var post = match ? match[1] : url;
      if (!isPostPage(post)) throw new Error('Unsupported page URL');
      var html = await get(post), candidates;
      if (match) {
        candidates = individualLinks(html, Number(match[2]), Number(match[3]));
      } else {
        // For movies, collect HubCloud download buttons from the post.
        candidates = [];
        (html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || []).forEach(function (anchor) {
          var href = attr((anchor.match(/^<a\b[^>]*>/i) || [])[0], 'href');
          if (/^https:\/\/greenmotors\.(?:club|cc)\//i.test(href) && /hubcloud/i.test(text(anchor))) {
            candidates.push({ url: href, quality: 'Auto' });
          }
        });
      }
      if (!candidates.length) throw new Error('No supported HubCloud links found for this item');
      var streams = [], seen = {};
      var batches = candidates.slice(0, 12);
      for (var i = 0; i < batches.length; i += 3) {
        var resolved = await Promise.all(batches.slice(i, i + 3).map(async function (candidate) {
          try { return { urls: await resolveHubLink(candidate.url), quality: candidate.quality }; }
          catch (error) { console.error('HubCloud: ' + String(error)); return null; }
        }));
        resolved.forEach(function (result) {
          if (!result) return;
          result.urls.forEach(function (item) {
            if (!seen[item.url]) {
              seen[item.url] = true;
              streams.push(new StreamResult({ url: item.url, source: item.source,
                quality: result.quality }));
            }
          });
        });
      }
      if (!streams.length) throw new Error('Could not resolve a direct stream; host format may have changed');
      callback({ success: true, data: streams });
    } catch (error) { fail(callback, error); }
  }

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();
