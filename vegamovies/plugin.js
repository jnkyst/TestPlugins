/*
 * SkyStream VegaMovies provider
 * Use only media you are authorized to access.
 */

(function () {
    'use strict';

    // plugin.json -> baseUrl is the ONLY domain setting. Do not add a
    // hardcoded mirror here; SkyStream injects that value as manifest.baseUrl.
    function base() {
        var configured = typeof manifest !== 'undefined'
            ? String(manifest.baseUrl || '').trim()
            : '';

        if (!/^https?:\/\/[^/]+/i.test(configured)) {
            throw new Error('Set a valid baseUrl in plugin.json');
        }

        return configured.replace(/\/+$/, '');
    }

    function hostOf(url) {
        var match = String(url || '').match(/^https?:\/\/([^/]+)/i);
        return match
            ? match[1].toLowerCase().replace(/^www\./, '')
            : '';
    }

    function baseHost() {
        return hostOf(base());
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

    function normalizeVegaUrl(url) {
        var value = String(url || '').trim();
        var host = hostOf(value);

        // Accept saved links from older VegaMovies mirrors and convert them
        // to the currently configured baseUrl. Other hosts are left intact.
        if (
            host === baseHost() ||
            /^vegamovies\.[a-z0-9.-]+$/i.test(host)
        ) {
            return value.replace(/^https?:\/\/[^/]+/i, base());
        }

        return value;
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

        // VegaMovies' og:image is an image-proxy URL. SkyStream's image
        // loader may reject that proxied WebP response. The proxy's `u`
        // parameter contains the original image URL encoded with Base64.
        var imageHost = hostOf(url);
        if (
            imageHost === 'img.' + baseHost() ||
            /^img\.vegamovies\.[a-z0-9.-]+$/i.test(imageHost)
        ) {
            var match = url.match(/[?&]u=([^&]+)/i);

            if (match) {
                try {
                    var encoded = decodeURIComponent(match[1])
                        .replace(/-/g, '+')
                        .replace(/_/g, '/');
                    var original = atob(encoded);

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

        return /\b(series|season|episodes?|s\d{1,2}e\d{1,3}|tv[ -]?shows?)\b/i.test(value)
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

    function listingGrid(html) {
        // Category pages contain the same featured carousel as the home page.
        // Parse only the real post grid; scanning the whole document duplicates
        // the carousel items in every home section.
        var gridPattern = /<div\b(?=[^>]*\bid=["']moviesGridMain["'])[^>]*>/i;
        var grid = gridPattern.exec(html);

        if (!grid) {
            throw new Error('Post grid not found; the site layout may have changed');
        }

        var start = grid.index + grid[0].length;
        var remainder = html.slice(start);
        var end = /<\/section\s*>|<nav\b[^>]*class=["'][^"']*pagination/i.exec(remainder);

        return remainder.slice(0, end ? end.index : remainder.length);
    }

    function listings(html) {
        var items = [];
        var seen = {};
        var grid = listingGrid(html);

        var anchors =
            grid.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || [];

        anchors.forEach(function (anchor) {
            var opening =
                (anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';

            var href = absolute(attr(opening, 'href'));

            if (!isSourcePage(href) || seen[href]) {
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
        var url =
            base() +
            '/ts-search.php?q=' +
            encodeURIComponent(term) +
            '&page=' +
            pageNumber;

        var response = JSON.parse(await get(url));

        if (!response || !Array.isArray(response.hits)) {
            throw new Error('Unexpected search response');
        }

        var seen = {};

        return response.hits
            .map(function (hit) {
                var document =
                    hit && hit.document
                        ? hit.document
                        : {};

                var href = absolute(document.permalink || '');
                var title = cleanTitle(document.post_title || '');

                var poster = absolute(
                    document.post_thumbnail ||
                    '/wp-content/themes/vegamoviesofficial/images/default-poster.jpg'
                );

                if (!isSourcePage(href) || !title || seen[href]) {
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
            { name: 'Netflix', path: '/web-series/netflix/' },
            {
                name: 'Amazon Prime',
                path: '/web-series/amazon-prime-video/'
            },
            {
                name: 'Disney Hotstar',
                path: '/web-series/disney-plus-hotstar/'
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

    async function seriesEpisodes(html, seriesUrl) {
        var titleTag = (html.match(/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/i) || [])[0] || '';
        var fallbackSeasonMatch = text(titleTag).match(/\bseason\s*(\d+)\b|\bs0*(\d+)/i);
        var fallbackSeason = fallbackSeasonMatch ? Number(fallbackSeasonMatch[1] || fallbackSeasonMatch[2]) : 1;
        var heads = [], re = /<h[2-6]\b[^>]*>[\s\S]*?<\/h[2-6]\s*>/gi, m;
        while ((m = re.exec(html)) !== null) heads.push({ start: m.index, end: re.lastIndex, label: text(m[0]) });
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
                if (!/v\s*-?\s*cloud|g\s*-?\s*direct|batch\s*\/\s*zip|download\s*now|episode\s*links/i.test(label)) return;
                if (!groups.some(function (g) { return g.url === link; })) groups.push({ url: link, season: season, quality: q[1].toUpperCase(), start: range ? Number(range[1]) : 0, end: range ? Number(range[2]) : 0 });
            });
        });
        var pages = [];
        for (var start = 0; start < Math.min(groups.length, 32); start += 3) {
            var batch = await Promise.all(groups.slice(start, start + 3).map(async function (group) {
                try { return { group: group, html: await get(group.url) }; }
                catch (e) { console.error('Episode list request failed: ' + String(e)); return null; }
            }));
            pages = pages.concat(batch);
        }
        var entries = {};
        var seasonFiles = [];
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
            var episodeHeads = [], er = /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]\s*>/gi, match;
            while ((match = er.exec(page.html)) !== null) {
                var label = text(match[0]);
                var ep = label.match(/\bepisodes?\s*[.:]?\s*(\d+)(?:\s*(?:[-–—+]|\bto\b)\s*(?:ep?\s*)?(\d+))?/i);
                if (ep) episodeHeads.push({ start: match.index, end: er.lastIndex, first: Number(ep[1]), last: ep[2] ? Number(ep[2]) : Number(ep[1]) });
            }
            if (!episodeHeads.length) {
                // A single file may contain a range of episodes; list it as a pack,
                // not as individual playable episodes.
                if (page.group.start) {
                    add(page.group, page.group.start, page.group.end, [page.group.url]);
                } else {
                    // When the site offers a season file without individual episode
                    // headings, keep the season file as one item, not fake episodes.
                    var hasHost = extractLinks(page.html, page.group.url).some(function (link) {
                        return /^https:\/\/(?:www\.)?vcloud\.beer\//i.test(link) || isFastDl(link) || isFilepress(link) || isVDrive(link);
                    });
                    var pageTitle = text((page.html.match(/<title\b[^>]*>[\s\S]*?<\/title\s*>/i) || [])[0] || '');
                    if (hasHost && /\b(?:season\s*\d+|s0*\d+)\b/i.test(pageTitle)) seasonFiles.push(page.group);
                }
                return;
            }
            episodeHeads.forEach(function (ep, i) {
                var end = i + 1 < episodeHeads.length ? episodeHeads[i + 1].start : page.html.length;
                var links = extractLinks(page.html.slice(ep.end, end), page.group.url).filter(function (url) {
                    return /^https:\/\/(?:www\.)?vcloud\.beer\//i.test(url) || isFastDl(url) || isFilepress(url) || isVDrive(url);
                });
                add(page.group, ep.first, ep.last, links);
            });
        });
        if (!Object.keys(entries).length && seasonFiles.length) {
            seasonFiles.forEach(function (group) {
                add(group, 1, 1, [group.url]);
                entries[group.season + ':1:1'].seasonFile = true;
            });
        }
        return Object.keys(entries).map(function (key) {
            var ep = entries[key];
            var name = ep.seasonFile ? 'Season ' + ep.season + ' (single file)' : ep.first === ep.last ? 'Episode ' + ep.first : 'Episodes ' + ep.first + '–' + ep.last + ' (combined file)';
            var episodeUrl = seriesUrl.split('#')[0] + '#skyepisode=' + encodeURIComponent(JSON.stringify(ep.links));

            // Always retain every host and quality. Never reduce an episode to
            // its first FastDL link: doing so discards 1080P/4K alternatives.
            return new Episode({
                name: name,
                url: episodeUrl,
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

    function isFastDl(url) {
        return /^https:\/\/(?:www\.)?fastdl\.beer\/(?:embed\?download=[A-Za-z0-9_-]+|dl\.php\?link=https(?:%3A|:))/i.test(url || '');
    }

    function fastDlRedirect(html) {
        var match = String(html || '').match(
            /\bvar\s+reurl\s*=\s*["'](https:\/\/fastdl\.beer\/dl\.php\?link=[^"']+)["']/i
        );

        return match ? decode(match[1]).trim() : '';
    }

    function isFilepress(url) {
        return /^https:\/\/(?:filebee\.(?:xyz|live)|(?:new\d+\.)?filepress\.[a-z0-9.-]+)\/file\/[a-f0-9]{24}\/?/i.test(url || '');
    }

    async function postJson(url, body, referer, extraHeaders) {
        var headers = {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };

        if (referer) headers.Referer = referer;

        Object.keys(extraHeaders || {}).forEach(function (key) {
            headers[key] = extraHeaders[key];
        });

        var response = await http_post(
            url,
            headers,
            JSON.stringify(body)
        );

        if (
            !response ||
            (response.status && (response.status < 200 || response.status >= 400))
        ) {
            throw new Error('POST request failed: ' + (response && response.status));
        }

        return JSON.parse(String(response.body || ''));
    }

    async function resolveDotFlix(shareUrl) {
        var html = await get(shareUrl);
        var codeMatch = html.match(
            /var\s+obfuscatedCode\s*=\s*btoa\(\s*["']([^"']+)["']\s*\)/i
        );
        var endpointMatch = html.match(
            /fetch\(\s*["'](https:\/\/[^"']+\/api\/extract-download)["']/i
        );

        if (!codeMatch || !endpointMatch) {
            throw new Error('Instant download page format changed');
        }

        var requestId = Math.random().toString(36).substring(2, 15);
        var timestamp = Date.now();
        var obfuscated = btoa(codeMatch[1])
            .split('')
            .reverse()
            .join('');
        var origin = (shareUrl.match(/^https?:\/\/[^/]+/i) || [])[0];

        var result = await postJson(
            endpointMatch[1],
            {
                requestId: requestId,
                timestamp: timestamp,
                data: obfuscated
            },
            shareUrl,
            {
                'X-Request-ID': requestId,
                'X-Timestamp': String(timestamp),
                'Origin': origin
            }
        );

        if (
            !result ||
            result.success !== true ||
            !mediaUrl(result.downloadUrl)
        ) {
            throw new Error('Instant download did not return a playable URL');
        }

        return result.downloadUrl;
    }

    async function resolveFilepress(url) {
        var idMatch = String(url).match(/\/file\/([a-f0-9]{24})/i);
        if (!idMatch) throw new Error('Invalid FilePress URL');

        var id = idMatch[1];
        var origin = (url.match(/^https?:\/\/[^/]+/i) || [])[0];
        var hosts = ['https://new3.filepress.lat'];

        if (origin && hosts.indexOf(origin) < 0) hosts.push(origin);

        var lastError = null;

        for (var i = 0; i < hosts.length; i++) {
            try {
                var result = await postJson(
                    hosts[i] + '/api/file/downlaod/',
                    {
                        id: id,
                        method: 'dotFlixDownlaod',
                        captchaValue: null
                    },
                    hosts[i] + '/file/' + id
                );

                if (
                    result &&
                    result.status === true &&
                    /^https:\/\/[^/]+\/share\/[a-f0-9]+/i.test(String(result.data || ''))
                ) {
                    return await resolveDotFlix(result.data);
                }

                throw new Error(
                    result && result.statusText
                        ? result.statusText
                        : 'FilePress instant download unavailable'
                );
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error('FilePress instant download failed');
    }

    function nextHost(url) {
        // Playback priority: only V-Cloud and V-Drive. NexDrive is allowed
        // solely as an intermediate page used to discover those two hosts.
        if (/^https:\/\/(?:www\.)?vcloud\.beer\//i.test(url)) return true;
        if (isVDrive(url)) return true;
        // FastDL's dl.php page is a redirect hop for the last-resort G-Direct
        // path; it is never selected as an initial candidate.
        if (isFastDl(url)) return true;
        return /^https:\/\/(?:www\.)?nexdrive\.beer\/genxfm\d+\/?(?:[?#].*)?$/i.test(url);
    }

    function withTimeout(promise, milliseconds, label) {
        return new Promise(function (resolve, reject) {
            var finished = false;
            var timer = setTimeout(function () {
                if (finished) return;
                finished = true;
                reject(new Error(label || 'Host request timed out'));
            }, milliseconds);

            promise.then(function (value) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                resolve(value);
            }, function (error) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                reject(error);
            });
        });
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
            var decodedUrl = atob(atob(match[1]));

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

        // Vega Drive exposes the prepared link through download-link. It may
        // answer 202 {"ready":false,"retry_after_ms":N} while preparing.
        var fetchLink = root + '/download-link/' + id + '/skydrop';

        for (var attempt = 0; attempt < 4; attempt++) {
            var data;

            try {
                data = JSON.parse(await request(fetchLink, intermediate, 'application/json'));
            } catch (error) {
                if (/HTTP 40[13]/.test(String(error))) {
                    try {
                        await request(root + '/__vega_bridge/prepare/' + id + '?provider=skydrop', intermediate, 'application/json');
                    } catch (ignored) { }
                    data = JSON.parse(await request(fetchLink, intermediate, 'application/json'));
                } else {
                    throw error;
                }
            }

            if (data && data.ready === true && typeof data.download_url === 'string') {
                // Accept Google's download/content hosts, which Vega Drive serves.
                if (!/^https:\/\/(?:[A-Za-z0-9-]+\.)*(?:googleusercontent|googlevideo)\.com(?::443)?\//i.test(data.download_url)) {
                    throw new Error('Unexpected V-Drive download host');
                }

                return data.download_url;
            }

            if (attempt < 3) {
                var wait = Number(data && data.retry_after_ms) || 1200;
                await new Promise(function (resolve) {
                    setTimeout(resolve, Math.min(wait, 3000));
                });
            }
        }

        throw new Error('V-Drive link not ready');
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
            var vdriveCandidates = [];

            async function scan(page, depth, quality) {
                if (seenPages[page] || depth > 3) {
                    return;
                }

                seenPages[page] = true;

                if (isFilepress(page)) {
                    try {
                        var filepressVideo = await resolveFilepress(page);

                        if (!seenStreams[filepressVideo]) {
                            seenStreams[filepressVideo] = true;
                            found.push(
                                new StreamResult({
                                    url: filepressVideo,
                                    source: 'FilePress / Instant (' + quality + ')',
                                    quality: quality,
                                    headers: { Referer: page }
                                })
                            );
                        }
                    } catch (error) {
                        failures++;
                        console.error('FilePress instant download failed: ' + String(error));
                    }

                    return;
                }

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
                var pixelCandidates = [];
                // Only explicit V-Drive download buttons, not arbitrary navigation links.
                var vdriveButtons = (html.match(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi) || []).filter(function (anchor) {
                    return /v\s*-?\s*drive/i.test(text(anchor));
                }).map(function (anchor) {
                    var tag = (anchor.match(/^<a\b[^>]*>/i) || [])[0] || '';
                    return pageUrl(attr(tag, 'href'), page);
                });

                if (/^https:\/\/(?:www\.)?vcloud\.beer\//i.test(page)) {
                    var tokenUrl = tokenPage(html, page);

                    if (tokenUrl) {
                        links.push(tokenUrl);
                    }

                    // Some V-Cloud pages replace a placeholder PixelServer href using
                    // `var pxl = "..."; document.getElementById("pxl-1").href = pxl;`.
                    // Read only this constrained pattern; never execute remote scripts.
                    if (/document\.getElementById\s*\(\s*["']pxl-1["']\s*\)\s*\.href\s*=\s*pxl\s*;/i.test(html)) {
                        var pixelAssignment = html.match(/\b(?:var|let|const)\s+pxl\s*=\s*["'](https:\/\/pixeldrain\.dev\/u\/[A-Za-z0-9]+\/?)["']/i);
                        if (pixelAssignment) links.push(pixelAssignment[1]);
                    }
                }

                // FastDL embeds use a JavaScript redirect rather than an anchor.
                // Read the constrained reurl assignment; never execute page scripts.
                if (isFastDl(page)) {
                    var fastDlPage = fastDlRedirect(html);
                    if (fastDlPage) links.push(fastDlPage);
                }

                links.forEach(function (link) {
                    if (mediaUrl(link) && !seenStreams[link]) {
                        seenStreams[link] = true;

                        found.push(
                            new StreamResult({
                                url: link,
                                source: (isFastDl(page) ? 'G-Direct' : 'V-Cloud / Direct') + ' (' + quality + ')',
                                quality: quality,
                                headers: { Referer: page }
                            })
                        );
                    } else if (/^https:\/\/(?:www\.)?vcloud\.beer\//i.test(page) &&
                        /^https:\/\/pixeldrain\.dev\/u\/[A-Za-z0-9]+\/?(?:[?#].*)?$/i.test(link)) {
                        var pixelId = link.match(/^https:\/\/pixeldrain\.dev\/u\/([A-Za-z0-9]+)/i)[1];
                        if (pixelCandidates.indexOf(pixelId) < 0) pixelCandidates.push(pixelId);
                    } else if (isVDrive(link) && vdriveButtons.indexOf(link) >= 0) {
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
                        if (!seenStreams[pixelVideo]) {
                            seenStreams[pixelVideo] = true;
                            found.push(new StreamResult({ url: pixelVideo, source: 'V-Cloud / PixelServer (' + quality + ')', quality: quality }));
                        }
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

            // Resolve V-Drive shares in parallel; each prepares a short-lived
            // Google URL. Failures never discard streams from other hosts.
            var vdriveHandled = false;
            var filepressCandidates = [];
            var fastDlCandidates = [];

            async function addVDriveStreams(entries) {
                if (!entries || !entries.length) return;

                await Promise.all(entries.map(async function (entry) {
                    try {
                        var video = await withTimeout(
                            resolveVDrive(entry.url),
                            9000,
                            'V-Drive request timed out'
                        );

                        if (!seenStreams[video]) {
                            seenStreams[video] = true;
                            var label = String(entry.quality || 'Auto');
                            found.push(new StreamResult({
                                url: video,
                                source: 'V-Drive (' + label + ')',
                                quality: label
                            }));
                        }
                    } catch (error) {
                        failures++;
                        console.error('V-Drive resolution failed: ' + String(error));
                    }
                }));
            }

            var initialQualityMatch = url.match(/[?&]quality=([^&]+)/i);
            var initialQuality = initialQualityMatch
                ? decodeURIComponent(initialQualityMatch[1])
                : 'Auto';

            if (episodeLinks) {
                // Keep up to three links per quality so a lower quality listed
                // first can never push the 1080P/4K alternatives out.
                var validLinks = [];
                var seenCandidates = {};

                episodeLinks.forEach(function (entry) {
                    if (!entry || !entry.url) return;
                    if (isFilepress(entry.url)) {
                        // Kept aside only; used if both priority clouds fail.
                        filepressCandidates.push(entry);
                        return;
                    }
                    if (isFastDl(entry.url)) {
                        // G-Direct is a last resort only, never a first choice.
                        fastDlCandidates.push(entry);
                        return;
                    }
                    if (!nextHost(entry.url) && !isVDrive(entry.url)) return;
                    if (seenCandidates[entry.url]) return;

                    var entryQuality = String(entry.quality || 'Auto');
                    var sameQuality = validLinks.filter(function (item) {
                        return item.quality === entryQuality;
                    }).length;

                    if (sameQuality >= 3) return;

                    seenCandidates[entry.url] = true;
                    validLinks.push({ url: entry.url, quality: entryQuality });
                });

                validLinks.forEach(function (entry) {
                    if (isVDrive(entry.url)) vdriveCandidates.push(entry);
                });

                var hostLinks = validLinks.filter(function (entry) {
                    return !isVDrive(entry.url);
                });

                // Start V-Drive immediately so it prepares its link while the
                // V-Cloud pages are still being fetched.
                var vdriveEarly = addVDriveStreams(vdriveCandidates.slice(0, 4));

                // Start the highest-quality FilePress link now, in parallel with
                // the priority hosts, but merge it only if that quality is still
                // missing. This removes the serial wait for 1080P.
                var fillEntries = [];
                filepressCandidates.slice().sort(function (a, b) {
                    return qualityRank({ source: String(b.quality || '') }) -
                        qualityRank({ source: String(a.quality || '') });
                }).forEach(function (entry) {
                    var label = String(entry.quality || 'Auto');

                    if (fillEntries.length < 2 &&
                        !fillEntries.some(function (item) { return item.quality === label; })) {
                        fillEntries.push(entry);
                    }
                });

                // FilePress rejects simultaneous requests, so start each one
                // shortly after the previous instead of blocking on it.
                var earlyFill = fillEntries.length
                    ? Promise.all(fillEntries.map(function (entry, index) {
                        return new Promise(function (resolve) {
                            setTimeout(resolve, index * 900);
                        }).then(function () {
                            return withTimeout(
                                resolveFilepress(entry.url),
                                9000,
                                'FilePress request timed out'
                            ).then(function (video) {
                                return { url: video, quality: String(entry.quality || 'Auto'), referer: entry.url };
                            });
                        }).catch(function (error) {
                            console.error('FilePress pre-fetch failed: ' + String(error));
                            return null;
                        });
                    }))
                    : Promise.resolve([]);

                // V-Cloud qualities are independent, so resolve them together.
                // A failed or slow host must not discard streams from others.
                await Promise.all(hostLinks.map(function (entry) {
                    return withTimeout(
                        scan(entry.url, 0, String(entry.quality || 'Auto')),
                        8000,
                        'V-Cloud request timed out'
                    ).catch(function (error) {
                        failures++;
                        console.error('V-Cloud resolution failed: ' + String(error));
                    });
                }));

                await vdriveEarly;
                vdriveHandled = true;

                var filled = await earlyFill;
                var covered = {};
                found.forEach(function (stream) {
                    covered[String(stream.quality || '')] = true;
                });

                filled.forEach(function (item) {
                    if (!item || !item.url || covered[item.quality] || seenStreams[item.url]) return;
                    seenStreams[item.url] = true;
                    covered[item.quality] = true;
                    found.push(new StreamResult({
                        url: item.url,
                        source: 'FilePress / Instant (' + item.quality + ')',
                        quality: item.quality,
                        headers: { Referer: item.referer }
                    }));
                });
            } else if (isVDrive(url)) {
                vdriveCandidates.push({ url: url, quality: 'Auto' });
            } else {
                await withTimeout(
                    scan(url, 0, initialQuality),
                    8000,
                    'Host request timed out'
                ).catch(function (error) {
                    failures++;
                    console.error('Host resolution failed: ' + String(error));
                });
            }

            // Resolve any remaining V-Drive links (single-file URLs, or links
            // discovered while scanning V-Cloud pages).
            if (!vdriveHandled && vdriveCandidates.length) {
                await addVDriveStreams(vdriveCandidates.slice(0, 4));
            }

            // FilePress/FileBee is used only to fill a quality that V-Cloud and
            // V-Drive could not supply (for example when 1080P is Cloudflare
            // blocked), so it never delays the normal fast path.
            var missingQualityLinks = [];

            if (filepressCandidates.length) {
                var coveredQualities = {};

                found.forEach(function (stream) {
                    coveredQualities[String(stream.quality || '')] = true;
                });

                filepressCandidates.forEach(function (entry) {
                    var label = String(entry.quality || 'Auto');

                    if (!coveredQualities[label] && missingQualityLinks.length < 2 &&
                        !missingQualityLinks.some(function (item) { return item.url === entry.url; })) {
                        missingQualityLinks.push(entry);
                    }
                });
            }

            if (missingQualityLinks.length) {
                await Promise.all(missingQualityLinks.map(async function (entry) {
                    try {
                        var video = await withTimeout(
                            resolveFilepress(entry.url),
                            12000,
                            'FilePress request timed out'
                        );

                        if (!seenStreams[video]) {
                            seenStreams[video] = true;
                            var label = String(entry.quality || 'Auto');
                            found.push(new StreamResult({
                                url: video,
                                source: 'FilePress / Instant (' + label + ')',
                                quality: label,
                                headers: { Referer: entry.url }
                            }));
                        }
                    } catch (error) {
                        failures++;
                        console.error('FilePress resolution failed: ' + String(error));
                    }
                }));
            }

            // G-Direct (FastDL) is followed only when neither priority cloud
            // produced anything, so it cannot slow down or outrank them.
            if (!found.length && fastDlCandidates.length) {
                await Promise.all(fastDlCandidates.slice(0, 8).map(async function (entry) {
                    try {
                        await withTimeout(
                            scan(entry.url, 0, String(entry.quality || 'Auto')),
                            8000,
                            'G-Direct request timed out'
                        );
                    } catch (error) {
                        failures++;
                        console.error('G-Direct fallback failed: ' + String(error));
                    }
                }));
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
