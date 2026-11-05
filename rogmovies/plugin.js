(function () {
  const DEFAULT_POSTER = "https://image.tmdb.org/t/p/w500/jbmZPjSfCdIHo269QZK203WZSm.jpg";

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
   * Helper: Guarantees safe absolute poster URL
   */
  function sanitizePoster(poster, baseUrl) {
    if (!poster || typeof poster !== "string" || poster.trim() === "" || poster.startsWith("data:image")) {
      return DEFAULT_POSTER;
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
  async function request(url) {
    const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      Referer: base + "/",
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
   * Robust Card Parser: Extracts cards directly from /download- post anchors
   */
  function parseCards(html) {
    if (!html || typeof html !== "string") return [];
    const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
    const items = [];
    const cardMap = {};

    // Match all anchors that link to movie/series posts
    const anchorRegex = /<a\s+[^>]*href=["'](https?:\/\/[^"']*\/download-[^"']+\/?)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorRegex.exec(html)) !== null) {
      let postUrl = match[1];
      const content = match[2];

      if (postUrl.startsWith("/")) {
        postUrl = base + postUrl;
      }

      if (!cardMap[postUrl]) {
        cardMap[postUrl] = { title: "", poster: "" };
      }

      // 1. Extract poster image
      const imgMatch =
        content.match(/data-src=["']([^"']+)["']/i) ||
        content.match(/data-lazy-src=["']([^"']+)["']/i) ||
        content.match(/src=["']([^"']+)["']/i);

      if (imgMatch && !imgMatch[1].startsWith("data:image") && !cardMap[postUrl].poster) {
        cardMap[postUrl].poster = imgMatch[1];
      }

      // 2. Extract title from alt attribute
      const altMatch = content.match(/alt=["']([^"']+)["']/i);
      if (altMatch && altMatch[1] && !cardMap[postUrl].title) {
        cardMap[postUrl].title = altMatch[1].trim();
      }

      // 3. Extract title from inner text
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

    // Build the final list of cards
    for (const [postUrl, data] of Object.entries(cardMap)) {
      let title = data.title;

      // Fallback: derive title from URL slug if text was only "Download"
      if (!title) {
        const slug = postUrl.replace(/\/+$/, "").split("/").pop().replace(/^download-/i, "").replace(/-/g, " ");
        title = slug.replace(/\b\w/g, (c) => c.toUpperCase());
      }

      title = decodeHtml(title).replace(/^Download\s+/i, "").trim();
      const poster = sanitizePoster(data.poster, base);
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
   * 1. getHome: Loads Trending, Latest Releases, Netflix, Amazon Prime, JioHotstar, SonyLiv
   */
  async function getHome(cb) {
    try {
      const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";

      // 1. Fetch Homepage
      const homeHtml = await request(base + "/");
      const latestItems = parseCards(homeHtml);

      // 2. Fetch Categories (Netflix, Prime, JioHotstar, SonyLiv)
      const catUrls = [
        base + "/web-series/netflix/",
        base + "/web-series/amazon-prime-video/",
        base + "/web-series/jiohotstar/",
        base + "/web-series/sonyliv/",
      ];

      const [netflixHtml, primeHtml, hotstarHtml, sonylivHtml] = await Promise.all(
        catUrls.map((u) => request(u).catch(() => ""))
      );

      const netflixItems = parseCards(netflixHtml);
      const primeItems = parseCards(primeHtml);
      const hotstarItems = parseCards(hotstarHtml);
      const sonylivItems = parseCards(sonylivHtml);

      // Master fallback pool to guarantee the hero carousel and rows never fail
      const pool = [
        ...latestItems,
        ...netflixItems,
        ...primeItems,
        ...hotstarItems,
        ...sonylivItems,
      ];

      const trending = latestItems.length > 0 ? latestItems.slice(0, 6) : pool.slice(0, 6);

      cb({
        success: true,
        data: {
          "Trending": trending,
          "Latest Releases": latestItems.length > 0 ? latestItems : pool.slice(0, 15),
          "Netflix": netflixItems.length > 0 ? netflixItems : pool.slice(0, 10),
          "Amazon Prime": primeItems.length > 0 ? primeItems : pool.slice(2, 12),
          "JioHotstar": hotstarItems.length > 0 ? hotstarItems : pool.slice(4, 14),
          "SonyLiv": sonylivItems.length > 0 ? sonylivItems : pool.slice(6, 16),
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
   * 3. load: Parses single movie/series details & episode/download links
   */
  async function load(url, cb) {
    try {
      const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
      const html = await request(url);

      const titleMatch =
        html.match(/<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) ||
        html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      let title = titleMatch ? titleMatch[1].replace(/<[^>]*>?/gm, "").trim() : "Unknown";
      title = decodeHtml(title).replace(/^Download\s+/i, "").trim();

      const contentMatch = html.match(/<div[^>]*class=["'][^"']*entry-content[^"']*["']([\s\S]*?)<\/div>/i);
      const contentHtml = contentMatch ? contentMatch[1] : html;

      let poster = "";
      const posterMatches = contentHtml.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
      for (const imgTag of posterMatches) {
        const srcMatch = imgTag.match(/src=["']([^"']+)["']/i);
        if (srcMatch && srcMatch[1]) {
          const src = srcMatch[1];
          if (!src.includes("logo") && !src.includes("icon") && !src.includes(".svg")) {
            poster = src;
            break;
          }
        }
      }

      poster = sanitizePoster(poster, base);

      let synopsis = "";
      const plotMatch =
        contentHtml.match(/(?:Synopsis|Plot|Storyline)[\s\S]*?<\/strong>\s*:?\s*([^<]+)/i) ||
        contentHtml.match(/<p[^>]*>(?:Synopsis|Plot|Storyline)[\s\S]*?:?\s*([\s\S]*?)<\/p>/i);
      if (plotMatch && plotMatch[1]) {
        synopsis = decodeHtml(plotMatch[1].replace(/<[^>]*>?/gm, "").trim());
      }

      const isSeries = /season\s*\d+/i.test(title) || /episode/i.test(title) || /TV-Show/i.test(title);
      const episodes = [];
      const seenLinks = new Set();

      const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      let epCounter = 1;

      while ((match = anchorRegex.exec(contentHtml)) !== null) {
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
          lowerLink.includes("drive")
        ) {
          seenLinks.add(rawLink);
          let cleanTitle = linkText.replace(/[⚡️⚡]/g, "").trim();

          episodes.push({
            title: cleanTitle || `Episode ${epCounter}`,
            season: isSeries ? 1 : undefined,
            episode: isSeries ? epCounter++ : undefined,
            url: rawLink,
          });
        }
      }

      cb({
        success: true,
        data: {
          title: title,
          synopsis: synopsis,
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
   * 4. loadStreams: Resolves NexDrive to FastDL embed players and direct video files
   */
  async function loadStreams(url, cb) {
    try {
      const streams = [];

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

      // Follow NexDrive to FastDL
      if (currentUrl.includes("nexdrive")) {
        const fastDlMatch =
          html.match(/href=["'](https?:\/\/[^"']*fastdl\.[^"']+\/embed\.php\?download=[^"']+)["']/i) ||
          html.match(/href=["'](https?:\/\/[^"']*(?:fastdl|vegadrive)\.[^"']+\/[^"']+)["']/i);

        if (fastDlMatch && fastDlMatch[1]) {
          currentUrl = fastDlMatch[1];
          html = await request(currentUrl);
        }
      }

      // Check HTML5 video tag
      const sourceMatch =
        html.match(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
        html.match(/<video[^>]+src=["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i);

      if (sourceMatch && sourceMatch[1]) {
        streams.push({
          url: sourceMatch[1],
          quality: "1080p",
          headers: { Referer: currentUrl },
        });
      }

      // Check JS file config
      const jsFileMatch =
        html.match(/(?:file|sources?|src)\s*:\s*["']([^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
        html.match(/["'](https?:\/\/[^"']+\/stream\/[^"']+)["']/i);

      if (jsFileMatch && jsFileMatch[1]) {
        streams.push({
          url: jsFileMatch[1],
          quality: "Auto",
          headers: { Referer: currentUrl },
        });
      }

      // Fallback: Pass embed player to SkyStream's internal player
      if (streams.length === 0 && currentUrl.includes("fastdl")) {
        streams.push({
          url: currentUrl,
          quality: "720p",
          headers: { Referer: "https://nexdrive.beer/" },
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