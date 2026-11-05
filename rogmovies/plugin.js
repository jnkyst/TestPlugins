(function () {
  /**
   * Decodes HTML and Hex entities
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
   * HTTP client using SkyStream's native Dart bridge
   */
  async function request(url) {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json, text/html, */*",
      "Accept-Language": "en-US,en;q=0.5",
      Referer: "https://rogmovies.im/",
    };

    if (typeof http_parallel === "function") {
      const res = await http_parallel([
        {
          url: url,
          method: "GET",
          headers: headers,
        },
      ]);
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
   * RogMovies Card Parser for HTML Home & Catalog pages
   */
  function parseCards(html) {
    const items = [];
    const seenUrls = new Set();

    const liRegex = /<li[\s\S]*?<\/li>/gi;
    const listItems = html.match(liRegex) || [];

    for (const block of listItems) {
      const dlLinkMatch =
        block.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?Download Now[\s\S]*?<\/a>/i) ||
        block.match(/<h[2-4][^>]*>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ||
        block.match(/<a\s+[^>]*href=["'](https?:\/\/[^"']*\/(?:download-)?[^"']+\/?)["'][^>]*>/i);

      if (!dlLinkMatch || !dlLinkMatch[1]) continue;

      let postUrl = dlLinkMatch[1];
      if (postUrl.startsWith("/")) {
        postUrl = "https://rogmovies.im" + postUrl;
      }

      if (
        seenUrls.has(postUrl) ||
        postUrl === "https://rogmovies.im/" ||
        postUrl.includes("/category/") ||
        postUrl.includes("/genre/") ||
        postUrl.includes("/page/") ||
        postUrl.includes("/dmca") ||
        postUrl.includes("/telegram") ||
        postUrl.includes("how-to")
      ) {
        continue;
      }

      let rawTitle = "";
      const headingMatch = block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i);
      const altMatch = block.match(/<img\s+[^>]*alt=["']([^"']+)["']/i);

      if (headingMatch) {
        rawTitle = headingMatch[1].replace(/<[^>]*>?/gm, "").trim();
      } else if (altMatch && altMatch[1]) {
        rawTitle = altMatch[1].trim();
      } else if (dlLinkMatch[2]) {
        rawTitle = dlLinkMatch[2].replace(/<[^>]*>?/gm, "").trim();
      }

      let title = decodeHtml(rawTitle).replace(/^Download\s+/i, "").trim();

      let poster = "";
      const imgMatch =
        block.match(/data-src=["']([^"']+)["']/i) ||
        block.match(/data-lazy-src=["']([^"']+)["']/i) ||
        block.match(/src=["']([^"']+)["']/i);

      if (imgMatch && !imgMatch[1].startsWith("data:image")) {
        poster = imgMatch[1];
      }

      if (postUrl && title && title.length > 2) {
        seenUrls.add(postUrl);
        items.push({
          title: title,
          url: postUrl,
          posterUrl: poster,
          type: /season\s*\d+/i.test(title) ? "series" : "movie",
        });
      }
    }

    return items;
  }

  /**
   * 1. getHome
   */
  async function getHome(cb) {
    try {
      const base = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://rogmovies.im";
      const html = await request(base);
      const items = parseCards(html);

      cb({
        success: true,
        data: {
          "Latest Releases": items,
        },
      });
    } catch (err) {
      cb({ success: false, message: err.message });
    }
  }

  /**
   * 2. search: Directly targets RogMovies' /ts-search.php backend
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

              items.push({
                title: title,
                url: doc.permalink,
                posterUrl: doc.post_thumbnail || "",
                type: /season\s*\d+/i.test(title) ? "series" : "movie",
              });
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
          lowerLink.includes("movies-by-quality") ||
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

      // Embed fallback
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

  // Register in global scope for SkyStream
  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();