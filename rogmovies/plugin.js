/*
 * SkyStream RogMovies provider
 * Use only media you are authorized to access.
 */

(function () {
  'use strict';

  function base() {
    return String(
      manifest.baseUrl || 'https://rogmovies.asia'
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

    var match = String(tag || '').match(
      new RegExp(pattern, 'i')
    );

    return match
      ? decode(match[1] || match[2] || match[3] || '')
      : '';
  }

  function normalizeRogUrl(url) {
    return String(url || '').replace(
      /^https?:\/\/(?:www\.)?rogmovies\.(?:im|asia)(?=\/|$)/i,
      base()
    );
  }

  function absolute(url) {
    url = decode(url || '').trim();

    if (/^https?:\/\//i.test(url)) {
      return normalizeRogUrl(url);
    }

    if (url.indexOf('//') === 0) {
      return normalizeRogUrl('https:' + url);
    }

    if (url.charAt(0) === '/') {
      return base() + url;
    }

    return url ? base() + '/' + url : '';
  }

  function isSourcePage(url) {
    return url.indexOf(base() + '/') === 0;
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

  function kind(title) {
    return /\b(series|season|episodes?|s\d{1,2}e\d{1,3}|tv[ -]?show)\b/i.test(title)
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

  function listings(html) {
    var items = [];
    var seen = {};

    var anchors =
      html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];

    anchors.forEach(function (anchor) {
      var opening =
        (anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';

      var href = absolute(attr(opening, 'href'));

      if (
        !isSourcePage(href) ||
        !/\/download-/i.test(href) ||
        seen[href]
      ) {
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
        attr(image, 'src')
      );

      if (!title || !poster) return;

      seen[href] = true;

      items.push(
        new MultimediaItem({
          title: title,
          url: href,
          posterUrl: poster,
          type: kind(title),
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
  // HOME
  // =====================================

  async function getHome(callback) {
    var sections = [
      { name: 'Latest Release', path: '/' },
      { name: 'TV Shows', path: '/tv-shows/' },
      { name: 'Netflix', path: '/web-series/netflix/' },
      {
        name: 'Amazon Prime',
        path: '/web-series/amazon-prime-video/'
      },
      {
        name: 'Jio Hotstar',
        path: '/web-series/jiohotstar/'
      },
      {
        name: 'SonyLiv',
        path: '/web-series/sonyliv/'
      }
    ];

    try {
      var results = await Promise.all(
        sections.map(async function (section) {
          try {
            return {
              items: listings(
                await get(base() + section.path)
              ),
              error: null
            };
          } catch (error) {
            console.error(
              'Home section ' +
              section.name +
              ': ' +
              String(error)
            );

            return {
              items: [],
              error: error
            };
          }
        })
      );

      if (
        results.every(function (result) {
          return result.error;
        })
      ) {
        throw new Error(
          'Unable to load any home section'
        );
      }

      var data = {};

      sections.forEach(function (section, index) {
        data[section.name] = results[index].items;
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

      var url =
        base() +
        '/ts-search.php?q=' +
        encodeURIComponent(term) +
        '&page=' +
        pageNumber;

      var response = JSON.parse(await get(url));

      if (
        !response ||
        !Array.isArray(response.hits)
      ) {
        throw new Error(
          'Unexpected search response'
        );
      }

      var seen = {};

      var items = response.hits
        .map(function (hit) {
          var document =
            hit && hit.document
              ? hit.document
              : {};

          var href = absolute(
            document.permalink || ''
          );

          var title = cleanTitle(
            document.post_title || ''
          );

          var poster = absolute(
            document.post_thumbnail ||
            '/wp-content/themes/rogmoviesofficial/images/default-poster.jpg'
          );

          if (
            !isSourcePage(href) ||
            !title ||
            seen[href]
          ) {
            return null;
          }

          seen[href] = true;

          return new MultimediaItem({
            title: title,
            url: href,
            posterUrl: poster,
            type: kind(title),
            year: yearOf(title)
          });
        })
        .filter(function (item) {
          return item !== null;
        });

      callback({
        success: true,
        data: items
      });
    } catch (error) {
      fail(callback, error);
    }
  }

  // =====================================
  // SERIES EPISODES
  // =====================================

  async function seriesEpisodes(html, seriesUrl) {
    var titleTag = (html.match(/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/i) || [])[0] || '';
    var fallbackSeasonMatch = text(titleTag).match(/\bseason\s*(\d+)\b|\bs0*(\d+)/i);
    var fallbackSeason = fallbackSeasonMatch ? Number(fallbackSeasonMatch[1] || fallbackSeasonMatch[2]) : 1;
    var heads = [], re = /<h[2-6]\b[^>]*>[\s\S]*?<\/h[2-6]\s*>/gi, m;
    while ((m = re.exec(html)) !== null) heads.push({start: m.index, end: re.lastIndex, label: text(m[0])});
    var groups = [];
    heads.forEach(function (h, i) {
      var q = h.label.match(/\b(720p|1080p|1440p|2160p|2k|4k)\b/i);
      if (!q) return;
      var sm = h.label.match(/\bseason\s*(\d+)\b|\bs0*(\d+)/i);
      var season = sm ? Number(sm[1] || sm[2]) : fallbackSeason;
      var range = h.label.match(/(?:episodes?\s*[.:]?\s*|\bs\d+\s*\.\s*e\s*)(\d+)\s*(?:[-–—+]|\bto\b)\s*(?:e(?:p(?:isode)?)?\s*)?(\d+)/i);
      var section = html.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : html.length);
      var anchors = section.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];
      anchors.forEach(function (a) {
        var tag = (a.match(/^<a\b[^>]*>/i) || [])[0] || '';
        var link = pageUrl(attr(tag, 'href'), seriesUrl);
        if (!/^https:\/\/(?:www\.)?nexdrive\.beer\//i.test(link)) return;
        var label = text(a);
        if (!/v\s*-?\s*cloud|download\s*now/i.test(label)) return;
        if (!groups.some(function (g) { return g.url === link; })) groups.push({url:link, season:season, quality:q[1].toUpperCase(), start:range ? Number(range[1]) : 0, end:range ? Number(range[2]) : 0});
      });
    });
    var pages = [];
    for (var start = 0; start < Math.min(groups.length, 32); start += 3) {
      var batch = await Promise.all(groups.slice(start, start + 3).map(async function (group) {
        try { return {group:group, html:await get(group.url)}; }
        catch (e) { console.error('Episode list request failed: ' + String(e)); return null; }
      }));
      pages = pages.concat(batch);
    }
    var entries = {};
    function add(group, first, last, links) {
      if (!first || !links.length) return;
      last = last || first;
      var key = group.season + ':' + first + ':' + last;
      if (!entries[key]) entries[key] = {season:group.season, first:first, last:last, links:[]};
      links.forEach(function (url) {
        if (!entries[key].links.some(function (e) { return e.url === url; })) entries[key].links.push({url:url, quality:group.quality});
      });
    }
    pages.forEach(function (page) {
      if (!page) return;
      var episodeHeads = [], er = /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi, match;
      while ((match = er.exec(page.html)) !== null) {
        var label = text(match[0]);
        var ep = label.match(/\bepisodes?\s*[.:]?\s*(\d+)(?:\s*(?:[-–—+]|\bto\b)\s*(?:ep?\s*)?(\d+))?/i);
        if (ep) episodeHeads.push({start:match.index, end:er.lastIndex, first:Number(ep[1]), last:ep[2] ? Number(ep[2]) : Number(ep[1])});
      }
      if (!episodeHeads.length) {
        // A single file may contain a range of episodes; list it as a pack,
        // not as individual playable episodes.
        if (page.group.start) add(page.group, page.group.start, page.group.end, [page.group.url]);
        return;
      }
      episodeHeads.forEach(function (ep, i) {
        var end = i + 1 < episodeHeads.length ? episodeHeads[i + 1].start : page.html.length;
        var links = extractLinks(page.html.slice(ep.end, end), page.group.url).filter(function (url) {
          return /^https:\/\/(?:www\.)?vcloud\.beer\//i.test(url) || isVDrive(url);
        });
        add(page.group, ep.first, ep.last, links);
      });
    });
    return Object.keys(entries).map(function (key) {
      var ep = entries[key];
      var name = ep.first === ep.last ? 'Episode ' + ep.first : 'Episodes ' + ep.first + '–' + ep.last + ' (combined file)';
      return new Episode({name:name, url:seriesUrl.split('#')[0] + '#skyepisode=' + encodeURIComponent(JSON.stringify(ep.links)), season:ep.season, episode:ep.first});
    }).sort(function (a,b) { return a.season-b.season || a.episode-b.episode; });
  }

  // =====================================
  // MOVIE / SERIES DETAILS
  // =====================================

  async function load(url, callback) {
    url = normalizeRogUrl(url);

    try {
      if (!isSourcePage(url)) {
        throw new Error(
          'Not a page on the configured site'
        );
      }

      var html = await get(url);

      var heading =
        (
          html.match(
            /<h1\b[^>]*>[\s\S]*?<\/h1>/i
          ) || []
        )[0];

      var title = cleanTitle(
        heading || meta(html, 'og:title')
      );

      if (!title) {
        throw new Error('Could not find title');
      }

      var imageTag =
        (
          html.match(
            /<meta\b(?=[^>]*\bitemprop=["']image["'])[^>]*>/i
          ) || []
        )[0];

      var poster = absolute(
        attr(imageTag, 'content') ||
        meta(html, 'og:image')
      );

      var itemType = kind(title);

      var item = new MultimediaItem({
        title: title,
        url: url,
        posterUrl: poster,
        type: itemType,
        year: yearOf(title),
        description:
          meta(html, 'description') ||
          meta(html, 'og:description'),

        episodes: itemType === 'movie'
          ? [
              new Episode({
                name: 'Full Movie',
                url: url,
                season: 1,
                episode: 1
              })
            ]
          : await seriesEpisodes(html, url)
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
    if (
      /^https?:\/\/(?:www\.)?megaup\.net\//i.test(url)
    ) {
      return false;
    }

    return (
      /^https?:\/\/[^\s]+\.(?:mp4|m3u8|mkv)(?:[?#].*)?$/i.test(url) ||
      /^https:\/\/pub-[a-f0-9]{32}\.r2\.dev\//i.test(url)
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
      (page.match(/^https?:\/\/[^/]+/i) || [])[0] ||
      base();

    if (raw.charAt(0) === '/') {
      return origin + raw;
    }

    return '';
  }

  function extractLinks(html, page) {
    var tags =
      html.match(
        /<(?:a|source|video)\b[^>]*>/gi
      ) || [];

    return tags
      .map(function (tag) {
        return pageUrl(
          attr(tag, 'href') ||
          attr(tag, 'src'),
          page
        );
      })
      .filter(Boolean);
  }

  function nextHost(url) {
    return /^https:\/\/(?:www\.)?(?:nexdrive\.beer|vcloud\.beer)\//i.test(url);
  }

  function qualityFrom(html, fallback) {
    var titleTag =
      (
        html.match(
          /<title\b[^>]*>[\s\S]*?<\/title>/i
        ) || []
      )[0] || '';

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
      var decodedUrl = atob(atob(match[1]));

      var cleanPage = page
        .split('?')[0]
        .split('#')[0];

      return decodedUrl.indexOf(
        cleanPage + '?token='
      ) === 0
        ? decodedUrl
        : '';
    } catch (error) {
      return '';
    }
  }

  function qualityRank(stream) {
    var label = String(
      stream.source || ''
    ).toUpperCase();

    if (
      label.indexOf('2160P') >= 0 ||
      label.indexOf('4K') >= 0
    ) return 2160;

    if (
      label.indexOf('1440P') >= 0 ||
      label.indexOf('2K') >= 0
    ) return 1440;

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

  // =====================================
  // LOAD STREAMS
  // =====================================

  async function loadStreams(url, callback) {
    url = normalizeRogUrl(url);

    try {
      var marker = '#skyepisode=';
      var markerIndex = url.indexOf(marker);
      var episodeLinks = null;

      if (markerIndex >= 0) {
        episodeLinks = JSON.parse(
          decodeURIComponent(
            url.slice(markerIndex + marker.length)
          )
        );

        url = url.slice(0, markerIndex);

        if (
          !isSourcePage(url) ||
          !Array.isArray(episodeLinks)
        ) {
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
      var vdriveCandidates = [];

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

        var links = extractLinks(html, page);
        var next = [];

        if (
          /^https:\/\/(?:www\.)?vcloud\.beer\//i.test(page)
        ) {
          var tokenUrl = tokenPage(html, page);

          if (tokenUrl) {
            links.push(tokenUrl);
          }
        }

        links.forEach(function (link) {
          if (mediaUrl(link) && !seenStreams[link]) {
            seenStreams[link] = true;

            found.push(
              new StreamResult({
                url: link,
                source:
                  'V-Cloud / Direct (' + quality + ')',
                quality: quality,
                headers: {
                  Referer: page
                }
              })
            );
          } else if (isVDrive(link)) {
            if (!vdriveCandidates.some(function (entry) { return entry.url === link; })) {
              vdriveCandidates.push({ url: link, quality: quality });
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

        var limited = next.slice(0, 8);

        for (var i = 0; i < limited.length; i += 2) {
          await Promise.all(
            limited.slice(i, i + 2).map(function (link) {
              return scan(link, depth + 1, quality);
            })
          );
        }
      }

      if (episodeLinks) {
        var validLinks = episodeLinks
          .filter(function (entry) {
            return (
              entry &&
              (nextHost(entry.url) || isVDrive(entry.url))
            );
          })
          .slice(0, 8);

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
        await scan(url, 0, 'Auto');
      }

      // Only try V-Drive when no usable V-Cloud/direct result was found.
      if (!found.some(function (stream) { return qualityRank(stream) !== 480; }) && vdriveCandidates.length) {
        var fallback = vdriveCandidates.slice(0, 8);
        for (var j = 0; j < fallback.length; j++) {
          try {
            var video = await resolveVDrive(fallback[j].url);
            if (!seenStreams[video]) {
              seenStreams[video] = true;
              var label = String(fallback[j].quality || 'Auto');
              found.push(new StreamResult({ url: video, source: 'V-Drive (' + label + ')', quality: label }));
            }
          } catch (error) {
            failures++;
            console.error('V-Drive fallback failed: ' + String(error));
          }
        }
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