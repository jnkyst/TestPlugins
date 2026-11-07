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
    var groups = [];
    var headings = [];
    var headingRegex = /<h3\b[^>]*>[\s\S]*?<\/h3\s*>/gi;
    var heading;

    while ((heading = headingRegex.exec(html)) !== null) {
      headings.push({
        index: heading.index,
        end: headingRegex.lastIndex,
        label: text(heading[0])
      });
    }

    headings.forEach(function (item, index) {
      var seasonMatch = item.label.match(
        /\bseason\s*(\d+)\b/i
      );

      var qualityMatch = item.label.match(
        /\b(720p|1080p|1440p|2160p|2k|4k)\b/i
      );

      if (!seasonMatch || !qualityMatch) {
        return;
      }

      var end =
        index + 1 < headings.length
          ? headings[index + 1].index
          : html.length;

      var section = html.slice(item.end, end);

      var anchors =
        section.match(
          /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi
        ) || [];

      anchors.forEach(function (anchor) {
        var opening =
          (anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';

        var link = pageUrl(
          attr(opening, 'href'),
          seriesUrl
        );

        var isNexDrive =
          /^https:\/\/(?:www\.)?nexdrive\.beer\//i.test(link);

        var isVCloud =
          /v\s*-?\s*cloud/i.test(text(anchor));

        if (isNexDrive && isVCloud) {
          groups.push({
            url: link,
            season: Number(seasonMatch[1]),
            quality: qualityMatch[1].toUpperCase()
          });
        }
      });
    });

    var pages = await Promise.all(
      groups.slice(0, 12).map(async function (group) {
        try {
          return {
            group: group,
            html: await get(group.url)
          };
        } catch (error) {
          console.error(
            'Episode list request failed: ' +
            String(error)
          );

          return null;
        }
      })
    );

    var byEpisode = {};

    pages.forEach(function (page) {
      if (!page) return;

      var episodeHeadings = [];

      var regex =
        /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi;

      var match;

      while ((match = regex.exec(page.html)) !== null) {
        var episodeMatch = text(match[0]).match(
          /\bepisode\s*:?\s*(\d+)\b/i
        );

        if (episodeMatch) {
          episodeHeadings.push({
            index: match.index,
            end: regex.lastIndex,
            number: Number(episodeMatch[1])
          });
        }
      }

      episodeHeadings.forEach(function (episode, index) {
        var end =
          index + 1 < episodeHeadings.length
            ? episodeHeadings[index + 1].index
            : page.html.length;

        var section = page.html.slice(
          episode.end,
          end
        );

        var links = extractLinks(
          section,
          page.group.url
        ).filter(function (link) {
          return /^https:\/\/(?:www\.)?vcloud\.beer\//i.test(link);
        });

        if (!links.length) return;

        var key =
          page.group.season + ':' + episode.number;

        if (!byEpisode[key]) {
          byEpisode[key] = {
            season: page.group.season,
            number: episode.number,
            links: []
          };
        }

        links.forEach(function (link) {
          var alreadyAdded = byEpisode[key].links.some(
            function (entry) {
              return entry.url === link;
            }
          );

          if (!alreadyAdded) {
            byEpisode[key].links.push({
              url: link,
              quality: page.group.quality
            });
          }
        });
      });
    });

    return Object.keys(byEpisode)
      .map(function (key) {
        var episode = byEpisode[key];

        var episodeUrl =
          seriesUrl.split('#')[0] +
          '#skyepisode=' +
          encodeURIComponent(
            JSON.stringify(episode.links)
          );

        return new Episode({
          name: 'Episode ' + episode.number,
          url: episodeUrl,
          season: episode.season,
          episode: episode.number
        });
      })
      .sort(function (a, b) {
        return (
          a.season - b.season ||
          a.episode - b.episode
        );
      });
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

      if (!isSourcePage(url) && !nextHost(url)) {
        throw new Error('Unsupported page URL');
      }

      var seenPages = {};
      var seenStreams = {};
      var found = [];
      var failures = 0;

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
              /^https:\/\/(?:www\.)?vcloud\.beer\//i.test(entry.url)
            );
          })
          .slice(0, 8);

        await Promise.all(
          validLinks.map(function (entry) {
            return scan(
              entry.url,
              0,
              String(entry.quality || 'Auto')
            );
          })
        );
      } else {
        await scan(url, 0, 'Auto');
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