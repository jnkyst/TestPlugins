(function () {
  /**
   * Helper: Decodes HTML and Hex entities
   */
  function decodeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/&#038;/g, "&")
      .replace(/&#8211;/g, "–")
      .replace(/&#8212;/g, "—")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  /**
   * Sanitizes poster URLs
   */
  function sanitizePoster(poster, baseUrl) {
    if (!poster || typeof poster !== "string" || poster.trim() === "" || poster.startsWith("data:image")) {
      return "";
    }
    poster = poster.trim();
    if (poster.startsWith("//")) return "https:" + poster;
    if (poster.startsWith("/")) return baseUrl + poster;
    if (!poster.startsWith("http")) return baseUrl + "/" + poster;
    return poster;
  }

  /**
   * Safe HTTP client using SkyStream's native Dart bridge
   */
  async function request(url, customHeaders = {}) {
    const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      Referer: base + "/",
      ...customHeaders,
    };

    if (typeof http_parallel === "function") {
      const res = await http_parallel([{ url: url, method: "GET", headers: headers }]);
      if (res && res[0]) {
        return typeof res[0] === "string" ? res[0] : res[0].body || res[0].data || "";
      }
    }

    if (typeof fetch === "function") {
      const res = await fetch(url, { headers });
      return await res.text();
    }

    throw new Error("No HTTP client found.");
  }

  /**
   * Batch HTTP helper
   */
  async function requestAll(urls) {
    const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      Referer: base + "/",
    };

    if (typeof http_parallel === "function") {
      try {
        const reqs = urls.map((u) => ({ url: u, method: "GET", headers: headers }));
        const responses = await http_parallel(reqs);
        if (responses && responses.length === urls.length) {
          return responses.map((r) => (typeof r === "string" ? r : r?.body || r?.data || ""));
        }
      } catch (_) {}
    }

    return Promise.all(urls.map((u) => request(u).catch(() => "")));
  }

  /**
   * Card Parser: Strips Header, Footer, and Sidebars
   */
  function parseCards(html) {
    if (!html || typeof html !== "string") return [];
    const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
    const items = [];
    const cardMap = {};

    let cleanHtml = html
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<aside[\s\S]*?<\/aside>/gi, "");

    const anchorRegex = /<a\s+[^>]*href=["'](https?:\/\/[^"']*\/download-[^"']+\/?)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorRegex.exec(cleanHtml)) !== null) {
      let postUrl = match[1];
      const content = match[2];

      if (postUrl.startsWith("/")) {
        postUrl = base + postUrl;
      }

      if (!cardMap[postUrl]) {
        cardMap[postUrl] = { title: "", poster: "" };
      }

      const b64PosterMatch = content.match(/[?&]u=([a-zA-Z0-9+/=]+)/);
      if (b64PosterMatch && b64PosterMatch[1]) {
        try {
          const atobFn = typeof atob !== "undefined" ? atob : (b) => Buffer.from(b, "base64").toString("utf-8");
          const decoded = atobFn(b64PosterMatch[1]);
          if (decoded.startsWith("http")) {
            cardMap[postUrl].poster = decoded;
          }
        } catch (_) {}
      }

      if (!cardMap[postUrl].poster) {
        const imgMatch =
          content.match(/data-src=["']([^"']+)["']/i) ||
          content.match(/data-lazy-src=["']([^"']+)["']/i) ||
          content.match(/src=["']([^"']+)["']/i);

        if (imgMatch && !imgMatch[1].startsWith("data:image")) {
          cardMap[postUrl].poster = imgMatch[1];
        }
      }

      const altMatch = content.match(/alt=["']([^"']+)["']/i);
      if (altMatch && altMatch[1] && !cardMap[postUrl].title) {
        cardMap[postUrl].title = altMatch[1].trim();
      }

      const cleanText = content.replace(/<[^>]*>?/gm, "").trim();
      if (
        cleanText &&
        cleanText.length > 3 &&
        !cleanText.toLowerCase().includes("download now") &&
        !cleanText.toLowerCase().includes("join") &&
        !cardMap[postUrl].title
      ) {
        cardMap[postUrl].title = cleanText;
      }
    }

    for (const [postUrl, data] of Object.entries(cardMap)) {
      let title = data.title;

      if (!title) {
        const slug = postUrl.replace(/\/+$/, "").split("/").pop().replace(/^download-/i, "").replace(/-/g, " ");
        title = slug.replace(/\b\w/g, (c) => c.toUpperCase());
      }

      title = decodeHtml(title).replace(/^Download\s+/i, "").trim();
      const poster = sanitizePoster(data.poster, base);

      if (!poster) continue;

      const isSeries = /season\s*\d+/i.test(title) || /TV-Show/i.test(title);

      const card = {
        title: title,
        url: postUrl,
        posterUrl: poster,
        type: isSeries ? "series" : "movie",
      };

      if (typeof MultimediaItem !== "undefined") {
        try {
          items.push(new MultimediaItem(card));
          continue;
        } catch (_) {}
      }
      items.push(card);
    }

    return items;
  }

  /**
   * Helper: Accurately unpacks a batch hub into clean Episode 1..N links (never matches CSS or post IDs)
   */
  function unpackBatchPage(html, quality, seasonNum) {
    const episodes = [];
    const validHostRegex = /(?:fastdl|vegadrive|vcloud|v-cloud|hubcloud|nexdrive|playdrive|gdflix|dgdrive|drive)/i;
    const seenUrls = new Set();

    // 1. Split by block elements
    const blocks = html.split(/<(?:p|div|tr|li|h\d)[\s>]/i);

    for (const block of blocks) {
      // CRITICAL: Strip all HTML tags first to eliminate attributes like style="font-size: 26426px" or id="post-7587707"
      const plainText = block.replace(/<[^>]*>/gm, " ");

      // Match strictly on visible text: "Episode 1" or "Ep 01" or "[E01]" or "E01"
      const epMatch =
        plainText.match(/\b(?:Episode|Ep)\s*[-.:#]?\s*(\d{1,3})\b/i) ||
        plainText.match(/\[E\s*(\d{1,3})\]/i) ||
        plainText.match(/\bE(\d{1,2})\b/i);

      if (!epMatch) continue;

      const epNum = parseInt(epMatch[1], 10);
      // Strictly ignore 0 or numbers larger than 100 (which are timestamps or database IDs)
      if (isNaN(epNum) || epNum < 1 || epNum > 100) continue;

      const anchors = block.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi) || [];
      for (const aTag of anchors) {
        const hMatch = aTag.match(/href=["']([^"']+)["']/i);
        if (!hMatch || !validHostRegex.test(hMatch[1]) || seenUrls.has(hMatch[1])) continue;

        const rawUrl = hMatch[1];
        seenUrls.add(rawUrl);

        const cleanBtn = aTag.replace(/<[^>]*>?/gm, "").toLowerCase();
        let server = "Server";
        if (cleanBtn.includes("v-cloud") || cleanBtn.includes("vcloud") || rawUrl.includes("vcloud") || rawUrl.includes("vegadrive")) {
          server = "V-Cloud [Resumable]";
        } else if (cleanBtn.includes("fastdl") || rawUrl.includes("fastdl") || cleanBtn.includes("instant") || cleanBtn.includes("g-direct")) {
          server = "G-Direct [Instant]";
        } else if (rawUrl.includes("hubcloud") || cleanBtn.includes("hubcloud")) {
          server = "HubCloud [Fast]";
        } else if (rawUrl.includes("dgdrive")) {
          server = "DGDrive";
        }

        episodes.push({
          title: `Episode ${epNum} [${quality}] - ${server}`,
          season: seasonNum,
          episode: epNum,
          url: rawUrl,
        });
      }
    }

    return episodes;
  }

  /**
   * 1. getHome: Loads deduplicated OTT & Latest categories
   */
  async function getHome(cb) {
    try {
      const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";

      const catUrls = [
        base + "/",
        base + "/web-series/netflix/",
        base + "/web-series/amazon-prime-video/",
        base + "/web-series/jiohotstar/",
        base + "/web-series/sonyliv/",
      ];

      const [homeHtml, netflixHtml, primeHtml, hotstarHtml, sonylivHtml] = await requestAll(catUrls);

      const rawLatest = parseCards(homeHtml);
      const rawNetflix = parseCards(netflixHtml);
      const rawPrime = parseCards(primeHtml);
      const rawHotstar = parseCards(hotstarHtml);
      const rawSonyliv = parseCards(sonylivHtml);

      const trending = rawLatest.slice(0, 6);
      const trendingUrls = new Set(trending.map((i) => i.url));

      const ottUrls = new Set([
        ...rawNetflix.map((i) => i.url),
        ...rawPrime.map((i) => i.url),
        ...rawHotstar.map((i) => i.url),
        ...rawSonyliv.map((i) => i.url),
      ]);

      const cleanLatest = rawLatest.filter(
        (i) => !trendingUrls.has(i.url) && !ottUrls.has(i.url)
      );

      const cleanNetflix = rawNetflix.filter((i) => !trendingUrls.has(i.url));
      const cleanPrime = rawPrime.filter((i) => !trendingUrls.has(i.url));
      const cleanHotstar = rawHotstar.filter((i) => !trendingUrls.has(i.url));
      const cleanSonyliv = rawSonyliv.filter((i) => !trendingUrls.has(i.url));

      cb({
        success: true,
        data: {
          "Trending": trending,
          "Latest Releases": cleanLatest.length > 0 ? cleanLatest : rawLatest.slice(6, 20),
          "Netflix": cleanNetflix,
          "Amazon Prime": cleanPrime,
          "JioHotstar": cleanHotstar,
          "SonyLiv": cleanSonyliv,
        },
      });
    } catch (err) {
      cb({ success: false, message: err.message });
    }
  }

  /**
   * 2. search: Uses RogMovies Typesense API
   */
  async function search(query, cb) {
    try {
      const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
      const searchApiUrl = `${base}/ts-search.php?q=${encodeURIComponent(query)}&page=1`;

      const rawResponse = await request(searchApiUrl);
      const items = [];

      try {
        const json = JSON.parse(rawResponse);
        if (json && json.hits && Array.isArray(json.hits)) {
          for (const hit of json.hits) {
            const doc = hit.document || hit;
            if (doc && doc.permalink) {
              const rawTitle = doc.post_title || "Unknown";
              const title = decodeHtml(rawTitle).replace(/^Download\s+/i, "").trim();
              const isSeries = /season\s*\d+/i.test(title);

              const card = {
                title: title,
                url: doc.permalink,
                posterUrl: sanitizePoster(doc.post_thumbnail, base),
                type: isSeries ? "series" : "movie",
              };

              if (typeof MultimediaItem !== "undefined") {
                try {
                  items.push(new MultimediaItem(card));
                  continue;
                } catch (_) {}
              }
              items.push(card);
            }
          }
        }
      } catch (parseErr) {
        items.push(...parseCards(rawResponse));
      }

      cb({
        success: true,
        data: items,
      });
    } catch (err) {
      cb({ success: false, message: err.message });
    }
  }

  /**
   * 3. load: Parses Title, TMDb Poster, Synopsis, and cleanly numbers all 72 episodes
   */
  async function load(url, cb) {
    try {
      const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
      const html = await request(url);

      // Title
      let title = "";
      const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
      const h1Match =
        html.match(/<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
        html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ||
        html.match(/<h2[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);

      if (ogTitleMatch && ogTitleMatch[1]) {
        title = ogTitleMatch[1].replace(/<[^>]*>?/gm, "").trim();
      } else if (h1Match && h1Match[1]) {
        title = h1Match[1].replace(/<[^>]*>?/gm, "").trim();
      } else {
        const pageTitle = html.match(/<title>([\s\S]*?)<\/title>/i);
        if (pageTitle && pageTitle[1]) {
          title = pageTitle[1].split("|")[0].split("-")[0].trim();
        }
      }

      if (!title || title.toLowerCase() === "unknown") {
        const slug = url.replace(/\/+$/, "").split("/").pop().replace(/^download-/i, "").replace(/-/g, " ");
        title = slug.replace(/\b\w/g, (c) => c.toUpperCase());
      }
      title = decodeHtml(title)
        .replace(/^Download\s+/i, "")
        .replace(/\s*\|\s*Rogmovies Official/i, "")
        .trim();

      // Poster
      let poster = "";
      const b64PosterMatch = html.match(/[?&]u=([a-zA-Z0-9+/=]+)/);
      if (b64PosterMatch && b64PosterMatch[1]) {
        try {
          const atobFn = typeof atob !== "undefined" ? atob : (b) => Buffer.from(b, "base64").toString("utf-8");
          const decoded = atobFn(b64PosterMatch[1]);
          if (decoded.startsWith("http")) {
            poster = decoded;
          }
        } catch (_) {}
      }

      if (!poster) {
        const ogImgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        if (ogImgMatch && ogImgMatch[1] && !ogImgMatch[1].includes("logo")) {
          poster = ogImgMatch[1];
        }
      }

      if (!poster) {
        const posterMatches = html.match(/<img[^>]+(?:data-src|data-lazy-src|data-orig-file|src)=["']([^"']+)["']/gi) || [];
        for (const imgTag of posterMatches) {
          const srcMatch =
            imgTag.match(/data-src=["']([^"']+)["']/i) ||
            imgTag.match(/data-lazy-src=["']([^"']+)["']/i) ||
            imgTag.match(/src=["']([^"']+)["']/i);

          if (srcMatch && srcMatch[1]) {
            const src = srcMatch[1];
            if (
              (src.includes("tmdb.org") || src.includes("imgbb") || src.includes("/uploads/")) &&
              !src.includes("logo") &&
              !src.includes("rlogo")
            ) {
              poster = src;
              break;
            }
          }
        }
      }
      poster = sanitizePoster(poster, base);

      // Synopsis
      let synopsis = "";
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
      if (ogDesc && ogDesc[1] && ogDesc[1].length > 20) {
        synopsis = decodeHtml(ogDesc[1]);
      }

      if (!synopsis) {
        const pTags = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
        for (const p of pTags) {
          const plainText = decodeHtml(p.replace(/<[^>]*>?/gm, "").trim());
          if (
            (plainText.toLowerCase().includes("storyline") ||
              plainText.toLowerCase().includes("synopsis") ||
              plainText.toLowerCase().includes("plot")) &&
            plainText.length > 25
          ) {
            synopsis = plainText.replace(/^(?:Storyline|Synopsis|Plot|Story):?\s*/i, "").trim();
            break;
          }
        }
      }

      const isSeries = /season\s*\d+/i.test(title) || /episode/i.test(title) || /TV-Show/i.test(title) || /Talk Show/i.test(title);
      let currentSeason = 1;
      const seasonMatch = title.match(/season\s*(\d+)/i);
      if (seasonMatch) {
        currentSeason = parseInt(seasonMatch[1], 10);
      }

      // Download Buttons with Quality Context
      const episodes = [];
      const seenLinks = new Set();
      let currentQualityContext = "";

      const segments = html.split(/(?=<h[2-5]|<p\s+style)/i);
      let epCounter = 1;

      for (const segment of segments) {
        const qDetect = segment.match(/\b(2160p|4K|1080p|720p|480p)\b/i);
        if (qDetect) {
          currentQualityContext = qDetect[1].toUpperCase();
        }

        const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;

        while ((match = anchorRegex.exec(segment)) !== null) {
          const rawLink = match[1];
          let linkText = match[2].replace(/<[^>]*>?/gm, "").trim();
          linkText = decodeHtml(linkText);

          const lowerLink = rawLink.toLowerCase();

          if (
            lowerLink.includes("rogmovies.im") ||
            lowerLink.includes("vegamovies-apk") ||
            lowerLink.includes("vglist") ||
            lowerLink.includes("telegram") ||
            lowerLink.includes("movies-by-") ||
            lowerLink.includes("#comment") ||
            seenLinks.has(rawLink)
          ) {
            continue;
          }

          if (
            lowerLink.includes("playdrive") ||
            lowerLink.includes("nexdrive") ||
            lowerLink.includes("hubcloud") ||
            lowerLink.includes("gdflix") ||
            lowerLink.includes("vcloud") ||
            lowerLink.includes("v-cloud") ||
            lowerLink.includes("vegadrive") ||
            lowerLink.includes("dgdrive") ||
            lowerLink.includes("fastdl") ||
            lowerLink.includes("drive")
          ) {
            seenLinks.add(rawLink);

            let cleanTitle = linkText.replace(/[⚡️⚡]/g, "").trim();
            const btnQuality = cleanTitle.match(/\b(2160p|4K|1080p|720p|480p)\b/i);
            const qualityBadge = btnQuality ? btnQuality[1].toUpperCase() : currentQualityContext;

            let displayTitle = cleanTitle || `Link ${epCounter}`;
            if (qualityBadge && !displayTitle.includes(qualityBadge)) {
              displayTitle = `${qualityBadge} - ${displayTitle}`;
            }

            if (lowerLink.includes("playdrive")) {
              displayTitle = `Watch Online (Direct Player) ${qualityBadge ? "[" + qualityBadge + "]" : ""}`.trim();
            }

            episodes.push({
              title: displayTitle,
              season: isSeries ? currentSeason : undefined,
              episode: epCounter,
              url: rawLink,
            });

            epCounter++;
          }
        }
      }

      // Batch Hub Unrolling: If series contains batch links, unroll into clean Episode 1..N
      const batchLinks = episodes.filter(
        (ep) =>
          ep.title.toLowerCase().includes("episode link") ||
          ep.title.toLowerCase().includes("batch") ||
          ep.title.toLowerCase().includes("all episode")
      );

      if (batchLinks.length > 0 && isSeries) {
        const batchUrls = batchLinks.map((b) => b.url);
        const batchPagesHtml = await requestAll(batchUrls);

        const unrolledEpisodes = [];
        for (let i = 0; i < batchLinks.length; i++) {
          const bLink = batchLinks[i];
          const bHtml = batchPagesHtml[i];
          const qMatch = bLink.title.match(/\b(2160p|4K|1080p|720p|480p)\b/i);
          const quality = qMatch ? qMatch[1].toUpperCase() : "720P";

          const extracted = unpackBatchPage(bHtml, quality, currentSeason);
          unrolledEpisodes.push(...extracted);
        }

        if (unrolledEpisodes.length > 0) {
          // Sort strictly by episode number (Episode 1, Episode 2, ... Episode 72)
          unrolledEpisodes.sort((a, b) => (a.episode || 0) - (b.episode || 0));
          return cb({
            success: true,
            data: {
              title: title,
              synopsis: synopsis || "Watch in HD on SkyStream.",
              posterUrl: poster,
              type: "series",
              episodes: unrolledEpisodes,
            },
          });
        }
      }

      cb({
        success: true,
        data: {
          title: title,
          synopsis: synopsis || "Watch in HD on SkyStream.",
          posterUrl: poster,
          type: isSeries ? "series" : "movie",
          episodes: episodes,
        },
      });
    } catch (err) {
      cb({ success: false, message: err.message });
    }
  }

  /**
   * 4. loadStreams: Resolves V-Cloud, VegaDrive, PlayDrive, FastDL, and video servers with seeking support
   */
  async function loadStreams(url, cb) {
    try {
      const streams = [];

      // Direct MP4/M3U8
      if (/\.(m3u8|mp4)/i.test(url)) {
        streams.push({
          url: url,
          quality: "1080p",
          headers: { Referer: "https://rogmovies.im/" },
        });
        return cb({ success: true, data: streams });
      }

      let currentUrl = url;
      let html = await request(currentUrl);

      // 1. Follow PlayDrive Embeds
      if (currentUrl.includes("playdrive.vip")) {
        const fileMatch =
          html.match(/file\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
          html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);

        if (fileMatch && fileMatch[1]) {
          streams.push({
            url: fileMatch[1],
            quality: "1080p",
            headers: { Referer: currentUrl, "User-Agent": "Mozilla/5.0" },
          });
          return cb({ success: true, data: streams });
        }
      }

      // 2. Follow V-Cloud / VegaDrive / HubCloud / DgDrive landing pages
      if (
        currentUrl.includes("vegadrive") ||
        currentUrl.includes("vcloud") ||
        currentUrl.includes("dgdrive") ||
        currentUrl.includes("hubcloud")
      ) {
        const cloudDestMatch =
          html.match(/href=["'](https?:\/\/[^"']*(?:fastdl|stream|dl|video|download)[^"']*)["']/i) ||
          html.match(/href=["'](https?:\/\/[^"']*\.(?:mp4|m3u8))["']/i);

        if (cloudDestMatch && cloudDestMatch[1]) {
          currentUrl = cloudDestMatch[1];
          if (/\.(m3u8|mp4)/i.test(currentUrl)) {
            streams.push({
              url: currentUrl,
              quality: "1080p",
              headers: { Referer: url, Range: "bytes=0-" },
            });
            return cb({ success: true, data: streams });
          }
          html = await request(currentUrl, { Referer: url });
        }
      }

      // 3. Follow NexDrive to FastDL / VegaDrive
      if (currentUrl.includes("nexdrive")) {
        const destMatch =
          html.match(/href=["'](https?:\/\/[^"']*(?:fastdl|vegadrive|vcloud|hubcloud)[^"']*)["']/i);

        if (destMatch && destMatch[1]) {
          currentUrl = destMatch[1];
          html = await request(currentUrl, { Referer: url });
        }
      }

      const playbackHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://fastdl.beer/",
        Accept: "*/*",
        Range: "bytes=0-",
      };

      // 4. Extract from FastDL redirect script (var reurl = "...")
      const reurlMatch =
        html.match(/var\s+reurl\s*=\s*["']([^"']+)["']/i) ||
        html.match(/reurl\s*=\s*["']([^"']+)["']/i);

      if (reurlMatch && reurlMatch[1]) {
        const targetReurl = reurlMatch[1];

        // Direct Stream Parameter (Google UserContent CDN)
        if (targetReurl.includes("link=")) {
          const directCdnUrl = decodeURIComponent(targetReurl.split("link=")[1]);
          if (directCdnUrl.startsWith("http")) {
            streams.push({
              url: directCdnUrl,
              quality: "1080p",
              headers: playbackHeaders,
            });
            streams.push({
              url: directCdnUrl,
              quality: "720p",
              headers: playbackHeaders,
            });
          }
        }

        // Secondary fallback
        streams.push({
          url: targetReurl,
          quality: "480p",
          headers: playbackHeaders,
        });
      }

      // 5. HTML5 video tag fallback
      const sourceMatch =
        html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
        html.match(/<video[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);

      if (sourceMatch && sourceMatch[1] && !streams.some((s) => s.url === sourceMatch[1])) {
        streams.push({
          url: sourceMatch[1],
          quality: "720p",
          headers: playbackHeaders,
        });
      }

      cb({
        success: true,
        data: streams,
      });
    } catch (err) {
      cb({ success: false, message: err.message });
    }
  }

  // Register methods globally for SkyStream
  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();