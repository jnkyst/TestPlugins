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
   * Sanitizes poster URLs. Returns empty string if invalid (no hardcoded fallback).
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
   * Precise Card Parser: Strips Header, Footer, and Sidebars; requires genuine poster image
   */
  function parseCards(html) {
    if (!html || typeof html !== "string") return [];
    const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
    const items = [];
    const cardMap = {};

    // 1. Strip Header, Footer, Aside/Sidebar widgets so text links never bleed into categories
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

      // Extract real image from data-src or src
      const imgMatch =
        content.match(/data-src=["']([^"']+)["']/i) ||
        content.match(/data-lazy-src=["']([^"']+)["']/i) ||
        content.match(/src=["']([^"']+)["']/i);

      if (imgMatch && !imgMatch[1].startsWith("data:image") && !cardMap[postUrl].poster) {
        cardMap[postUrl].poster = imgMatch[1];
      }

      // Extract title from alt attribute
      const altMatch = content.match(/alt=["']([^"']+)["']/i);
      if (altMatch && altMatch[1] && !cardMap[postUrl].title) {
        cardMap[postUrl].title = altMatch[1].trim();
      }

      // Extract title from inner text
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

    // 2. Build items (STRICT: ignore any card without a genuine image)
    for (const [postUrl, data] of Object.entries(cardMap)) {
      let title = data.title;

      if (!title) {
        const slug = postUrl.replace(/\/+$/, "").split("/").pop().replace(/^download-/i, "").replace(/-/g, " ");
        title = slug.replace(/\b\w/g, (c) => c.toUpperCase());
      }

      title = decodeHtml(title).replace(/^Download\s+/i, "").trim();
      const poster = sanitizePoster(data.poster, base);

      // Discard text-only links from sidebars / footers
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
   * 1. getHome: Completely deduplicated, platform-specific categories
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

      // Hero banner takes top 6 valid latest cards
      const trending = rawLatest.slice(0, 6);
      const trendingUrls = new Set(trending.map((i) => i.url));

      // Collect all OTT URLs
      const ottUrls = new Set([
        ...rawNetflix.map((i) => i.url),
        ...rawPrime.map((i) => i.url),
        ...rawHotstar.map((i) => i.url),
        ...rawSonyliv.map((i) => i.url),
      ]);

      // Latest Releases row: Only non-OTT, non-Trending theatrical films & shows
      const cleanLatest = rawLatest.filter(
        (i) => !trendingUrls.has(i.url) && !ottUrls.has(i.url)
      );

      // OTT rows: Exclude items already featured in the Hero banner
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
   * 3. load: Accurately parses Poster, Synopsis, and Episode titles
   */
  async function load(url, cb) {
    try {
      const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
      const html = await request(url);

      // 1. Title
      const titleMatch =
        html.match(/<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
        html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      let title = titleMatch ? titleMatch[1].replace(/<[^>]*>?/gm, "").trim() : "Unknown";
      title = decodeHtml(title).replace(/^Download\s+/i, "").trim();

      // 2. Poster: Search data-src or src for TMDb or WP CDN image
      let poster = "";
      const posterMatches = html.match(/<img[^>]+(?:data-src|data-lazy-src|src)=["']([^"']+)["']/gi) || [];
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
            !src.includes("favicon") &&
            !src.includes("rlogo")
          ) {
            poster = src;
            break;
          }
        }
      }
      poster = sanitizePoster(poster, base);

      // 3. Synopsis: Extract storyline/plot narrative paragraph
      let synopsis = "";
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

      if (!synopsis) {
        for (const p of pTags) {
          const plainText = decodeHtml(p.replace(/<[^>]*>?/gm, "").trim());
          if (
            plainText.length > 60 &&
            !plainText.toLowerCase().includes("download") &&
            !plainText.toLowerCase().includes("480p") &&
            !plainText.toLowerCase().includes("720p") &&
            !plainText.toLowerCase().includes("1080p") &&
            !plainText.toLowerCase().includes("http")
          ) {
            synopsis = plainText;
            break;
          }
        }
      }

      const isSeries = /season\s*\d+/i.test(title) || /episode/i.test(title) || /TV-Show/i.test(title);
      let currentSeason = 1;
      const seasonMatch = title.match(/season\s*(\d+)/i);
      if (seasonMatch) {
        currentSeason = parseInt(seasonMatch[1], 10);
      }

      const episodes = [];
      const seenLinks = new Set();

      const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      let epCounter = 1;

      while ((match = anchorRegex.exec(html)) !== null) {
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
          lowerLink.includes("nexdrive") ||
          lowerLink.includes("hubcloud") ||
          lowerLink.includes("gdflix") ||
          lowerLink.includes("v-cloud") ||
          lowerLink.includes("fastdl") ||
          lowerLink.includes("drive")
        ) {
          seenLinks.add(rawLink);

          let cleanTitle = linkText.replace(/[⚡️⚡]/g, "").trim();

          let epNum = epCounter;
          const epNumMatch = linkText.match(/(?:Episode|EP|E)\s*[-:]?\s*(\d+)/i);
          if (epNumMatch) {
            epNum = parseInt(epNumMatch[1], 10);
          }

          // Ensure episode title is NEVER blank in SkyStream UI
          if (!cleanTitle || cleanTitle.length < 2) {
            cleanTitle = isSeries ? `Episode ${epNum}` : `Stream Link ${epCounter}`;
          } else if (!cleanTitle.toLowerCase().includes("episode") && isSeries) {
            cleanTitle = `Episode ${epNum} - ${cleanTitle}`;
          }

          episodes.push({
            title: cleanTitle,
            season: isSeries ? currentSeason : undefined,
            episode: isSeries ? epNum : undefined,
            url: rawLink,
          });

          epCounter++;
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
   * 4. loadStreams: Resolves NexDrive & FastDL redirect scripts to raw video streams
   */
  async function loadStreams(url, cb) {
    try {
      const streams = [];

      // 1. If URL is already a direct video stream
      if (/\.(m3u8|mp4)/i.test(url)) {
        streams.push({
          url: url,
          quality: "Auto",
          headers: { Referer: "https://rogmovies.im/" },
        });
        return cb({ success: true, data: streams });
      }

      let currentUrl = url;
      let html = await request(currentUrl);

      // 2. Follow NexDrive landing page to FastDL / VegaDrive embed
      if (currentUrl.includes("nexdrive")) {
        const destMatch =
          html.match(/href=["'](https?:\/\/[^"']*(?:fastdl|vegadrive|vcloud|hubcloud)[^"']*)["']/i);

        if (destMatch && destMatch[1]) {
          currentUrl = destMatch[1];
          html = await request(currentUrl, { Referer: url });
        }
      }

      const standardHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://fastdl.beer/",
      };

      // 3. Extract direct video from FastDL redirect script (var reurl = "...")
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
              headers: standardHeaders,
            });
          }
        }

        // Secondary fallback to the fastdl download endpoint
        streams.push({
          url: targetReurl,
          quality: "Auto",
          headers: standardHeaders,
        });
      }

      // 4. Extract from HTML5 <source> or <video> tags
      const sourceMatch =
        html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
        html.match(/<video[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);

      if (sourceMatch && sourceMatch[1] && !streams.some((s) => s.url === sourceMatch[1])) {
        streams.push({
          url: sourceMatch[1],
          quality: "720p",
          headers: standardHeaders,
        });
      }

      // 5. Extract from JS player configs (file: "...", sources: [...])
      const jsMatches = [
        ...html.matchAll(/(?:file|source|src|url)\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/gi),
      ];

      for (const m of jsMatches) {
        if (m[1] && !streams.some((s) => s.url === m[1])) {
          streams.push({
            url: m[1],
            quality: "Auto",
            headers: standardHeaders,
          });
        }
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