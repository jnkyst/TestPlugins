
/*
 * RogMovies — SkyStream Gen 2 plugin
 * WordPress REST API source: https://rogmovies.im
 *
 * Implements: getHome, search, load, loadStreams
 */

(function () {
  "use strict";

  const API_FIELDS =
  "id,date,link,title,excerpt,content,meta,categories,class_list,fifu_image_url,_embedded";
  const DEFAULT_POSTER = "https://rogmovies.im/wp-content/uploads/placeholder.jpg";

  function baseUrl() {
    const configured =
      (typeof manifest !== "undefined" && manifest && manifest.baseUrl)
        ? manifest.baseUrl
        : "https://rogmovies.im";
    return String(configured).replace(/\/+$/, "");
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, function (_, n) {
        return String.fromCharCode(Number(n));
      })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) {
        return String.fromCharCode(parseInt(n, 16));
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  function getTitle(post) {
    return cleanText(post && post.title && post.title.rendered) || "Untitled";
  }

  function getDescription(post) {
    return cleanText(
      (post && post.excerpt && post.excerpt.rendered) ||
      (post && post.content && post.content.rendered) ||
      ""
    );
  }

  function getPoster(post) {
    const embedded =
      post && post._embedded && post._embedded["wp:featuredmedia"] &&
      post._embedded["wp:featuredmedia"][0] &&
      post._embedded["wp:featuredmedia"][0].source_url;

    return (
      (post && post.fifu_image_url) ||
      (post && post.meta && post.meta.fifu_image_url) ||
      embedded ||
      DEFAULT_POSTER
    );
  }

  function getYear(post) {
    const titleYear = getTitle(post).match(/\b(19|20)\d{2}\b/);
    const dateYear = String(post && post.date || "").match(/^\d{4}/);
    return titleYear ? Number(titleYear[0]) : (dateYear ? Number(dateYear[0]) : undefined);
  }

  function isSeries(post) {
    const title = getTitle(post);
    const classes = Array.isArray(post && post.class_list) ? post.class_list.join(" ") : "";

    return (
      /\b(web[\s-]?series|series|season|s\d{1,2}\s*e\d{1,2}|complete\s+series)\b/i.test(title) ||
      /category-(web-series|tv-series|series)\b/i.test(classes)
    );
  }

  function toItem(post) {
    return {
      title: getTitle(post),
      url: "rogmovies:post:" + String(post.id),
      posterUrl: getPoster(post),
      type: isSeries(post) ? "series" : "movie",
      year: getYear(post),
      description: getDescription(post)
    };
  }

  // Use SkyStream's native HTTP helper. Browser fetch() is unavailable.
  async function requestText(url, accept) {
    if (typeof http_get !== "function") {
      throw new Error("SkyStream HTTP helper http_get() is unavailable.");
    }

    const response = await http_get(url, {
      Accept: accept || "*/*",
      "Cache-Control": "no-cache",
      "User-Agent": "Mozilla/5.0"
    });

    if (!response || response.status < 200 || response.status >= 300) {
      const status = response ? response.status : "no response";
      throw new Error("HTTP request failed (" + status + "): " + url);
    }

    return String(response.body || "");
  }

  async function requestJson(url) {
    const body = await requestText(url, "application/json");

    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error("WordPress API returned invalid JSON: " + url);
    }
  }

 
async function getPosts(params) {
  const url =
    baseUrl() +
    "/wp-json/wp/v2/posts/?" +
    params +
    "&_embed=1&_fields=" +
    encodeURIComponent(API_FIELDS);

  // First retrieve the list of post IDs.
  const summaries = await requestJson(url);

  if (!Array.isArray(summaries)) {
    throw new Error("WordPress posts API did not return a list.");
  }

  // Then retrieve complete details for each post.
  const posts = [];

  for (let i = 0; i < summaries.length; i += 5) {
    const batch = summaries.slice(i, i + 5);

    const details = await Promise.all(
      batch.map(async function (post) {
        if (!post || !post.id) return null;

        const detailUrl =
          baseUrl() +
          "/wp-json/wp/v2/posts/" +
          post.id +
          "?_embed=1";

        return await requestJson(detailUrl);
      })
    );

    for (const post of details) {
      if (post) posts.push(post);
    }
  }

  return posts;
}


  function sendError(cb, error, code) {
    cb({
      success: false,
      errorCode: code || "NETWORK_ERROR",
      message: String(error && error.message ? error.message : error)
    });
  }

  async function getHome(cb) {
    try {
      const posts = await getPosts("per_page=30&page=1&orderby=date&order=desc");
      const items = Array.isArray(posts) ? posts.map(toItem) : [];
      const series = items.filter(function (item) { return item.type === "series"; });
      const movies = items.filter(function (item) { return item.type === "movie"; });

      const data = {};
      if (items.length) data["Trending"] = items.slice(0, 10);
      if (movies.length) data["Latest Movies"] = movies.slice(0, 20);
      if (series.length) data["Latest Series"] = series.slice(0, 20);

      cb({ success: true, data: data });
    } catch (error) {
      sendError(cb, error);
    }
  }

  
  async function search(query, pageOrCb, maybeCb) {
    const page = typeof pageOrCb === "number" ? pageOrCb : 1;
    const cb = typeof pageOrCb === "function" ? pageOrCb : maybeCb;
    if (typeof cb !== "function") return;

    try {
      const terms = String(query || "")
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(function (word) {
          return word.length > 1 &&
            !["the", "a", "an", "and", "or", "in", "on", "of", "to"].includes(word);
        });

      if (!terms.length) {
        return cb({ success: true, data: [] });
      }

      // Read the sitemap index.
      const indexXml = await requestText(
        baseUrl() + "/sitemap.xml",
        "application/xml,text/xml,*/*"
      );

      // Find all post sitemap URLs.
      const sitemapUrls = [];
      const sitemapPattern = /<loc>\s*([^<]+)\s*<\/loc>/gi;
      let sitemapMatch;

      while ((sitemapMatch = sitemapPattern.exec(indexXml)) !== null) {
        const sitemapUrl = cleanText(sitemapMatch[1]);

        if (/\/post-sitemap\d*\.xml(?:\?|$)/i.test(sitemapUrl)) {
          sitemapUrls.push(sitemapUrl);
        }
      }

      if (!sitemapUrls.length) {
        throw new Error("No post sitemaps were found.");
      }

      // Download all post sitemaps.
      const sitemapResults = await Promise.all(
        sitemapUrls.map(async function (url) {
          try {
            return await requestText(url, "application/xml,text/xml,*/*");
          } catch (_) {
            return "";
          }
        })
      );

      // Collect post URLs whose slugs contain every search term.
      const candidates = [];
      const seen = {};

      for (const xml of sitemapResults) {
        const locPattern = /<loc>\s*([^<]+)\s*<\/loc>/gi;
        let match;

        while ((match = locPattern.exec(xml)) !== null) {
          const postUrl = cleanText(match[1]);

          if (!/^https:\/\/rogmovies\.im\//i.test(postUrl)) continue;

          let slug = "";
          try {
            const parsed = new URL(postUrl);
            const parts = parsed.pathname.split("/").filter(Boolean);
            slug = decodeURIComponent(parts[parts.length - 1] || "")
              .toLowerCase();
          } catch (_) {
            continue;
          }

          if (!slug || seen[postUrl]) continue;

          const matches = terms.every(function (term) {
            return slug.indexOf(term) !== -1;
          });

          if (matches) {
            seen[postUrl] = true;
            candidates.push(postUrl);
          }
        }
      }

      // Apply pagination.
      const pageSize = 20;
      const start = (Math.max(1, page) - 1) * pageSize;
      const selected = candidates.slice(start, start + pageSize);

      // Read metadata from each matching movie page.
      const items = await Promise.all(
        selected.map(async function (postUrl) {
          try {
            const html = await requestText(
              postUrl,
              "text/html,application/xhtml+xml,*/*"
            );

            function getMeta(name) {
              const tags = html.match(/<meta\b[^>]*>/gi) || [];

              for (const tag of tags) {
                const keyMatch = tag.match(
                  /\b(?:property|name)\s*=\s*["']([^"']+)["']/i
                );

                if (!keyMatch ||
                    keyMatch[1].toLowerCase() !== name.toLowerCase()) {
                  continue;
                }

                const contentMatch = tag.match(
                  /\bcontent\s*=\s*["']([^"']*)["']/i
                );

                if (contentMatch) return cleanText(contentMatch[1]);
              }

              return "";
            }

            const title = getMeta("og:title") ||
              getMeta("twitter:title");

            const description = getMeta("og:description") ||
              getMeta("description");

            const poster = getMeta("og:image") ||
              getMeta("twitter:image");

            // The RogMovies poster URL contains the WordPress post ID.
            const idMatch = poster.match(/[?&]p=(\d+)/i);

            if (!title || !idMatch) return null;

            const yearMatch = title.match(/\b(19|20)\d{2}\b/);
            const series = /\b(web[\s-]?series|series|season|S\d{1,2}\s*E\d{1,2})\b/i
              .test(title);

            return {
              title: title,
              url: "rogmovies:post:" + idMatch[1],
              posterUrl: poster || DEFAULT_POSTER,
              type: series ? "series" : "movie",
              year: yearMatch ? Number(yearMatch[0]) : undefined,
              description: description
            };
          } catch (_) {
            return null;
          }
        })
      );

      cb({
        success: true,
        data: items.filter(Boolean)
      });

    } catch (error) {
      sendError(cb, error, "SEARCH_FAILED");
    }
  }


  async function findPost(itemUrl) {
  const value = String(itemUrl || "").trim();

  // Handle SkyStream internal post IDs.
  const internalMatch = value.match(/^rogmovies:post:(\d+)$/);

  if (internalMatch) {
    return await requestJson(
      baseUrl() +
      "/wp-json/wp/v2/posts/" +
      internalMatch[1] +
      "?_embed=1"
    );
  }

  // Handle numeric WordPress post IDs.
  if (/^\d+$/.test(value)) {
    return await requestJson(
      baseUrl() +
      "/wp-json/wp/v2/posts/" +
      value +
      "?_embed=1"
    );
  }

  let slug = value;

  // Extract the slug from a permalink.
  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split("/").filter(Boolean);
    slug = parts.length ? parts[parts.length - 1] : "";

    const queryId = parsed.searchParams.get("p");

    if (queryId && /^\d+$/.test(queryId)) {
      return await requestJson(
        baseUrl() +
        "/wp-json/wp/v2/posts/" +
        queryId +
        "?_embed=1"
      );
    }
  } catch (_) {
    // Treat the supplied value as a slug.
  }

  slug = String(slug).replace(/\/+$/, "");

  if (!slug) {
    throw new Error("Could not identify the RogMovies post.");
  }

  // First request: resolve the exact slug to a post ID.
  const summaries = await requestJson(
    baseUrl() +
    "/wp-json/wp/v2/posts/?slug=" +
    encodeURIComponent(slug) +
    "&per_page=1&_fields=id,slug,link,title"
  );

  if (
    !Array.isArray(summaries) ||
    !summaries.length ||
    !summaries[0].id
  ) {
    throw new Error("Post not found in RogMovies API: " + slug);
  }

  // Second request: fetch the full post using its verified ID.
  return await requestJson(
    baseUrl() +
    "/wp-json/wp/v2/posts/" +
    summaries[0].id +
    "?_embed=1"
  );
}
  

  function extractDownloadLinks(html) {
    const source = String(html || "");
    const anchorPattern = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    const results = [];
    let match;

    while ((match = anchorPattern.exec(source)) !== null) {
      let href = String(match[2] || "").replace(/&amp;/g, "&").trim();
      const label = cleanText(match[4]);

      if (!/^https?:\/\//i.test(href)) continue;

      const before = source.slice(Math.max(0, match.index - 260), match.index);
      const context = cleanText(before.slice(-220) + " " + label);
      const combined = (context + " " + href).toLowerCase();

      const looksLikeDownload =
        /\b(download|g-direct|v-cloud|watch|play|480p|720p|1080p|2160p|4k|web-dl|episode|season)\b/i.test(combined) ||
        /nexdrive|drive\.google|gofile|pixeldrain|mixdrop|streamtape|filemoon|voe\./i.test(href);

      if (!looksLikeDownload) continue;
      if (/youtube\.com|youtu\.be|imdb\.com|rogmovies\.im\/category\//i.test(href)) continue;

      if (!results.some(function (entry) { return entry.url === href; })) {
        results.push({
          url: href,
          label: label || context || "Open source " + (results.length + 1),
          context: context
        });
      }
    }

    return results;
  }

  function parseSeasonEpisode(text, fallbackIndex) {
    const seasonMatch = String(text || "").match(/\bS(?:eason\s*)?0*(\d{1,2})\b/i);
    const episodeMatch = String(text || "").match(/\bE(?:pisode\s*)?0*(\d{1,3})\b/i);

    return {
      season: seasonMatch ? Number(seasonMatch[1]) : 1,
      episode: episodeMatch ? Number(episodeMatch[1]) : fallbackIndex
    };
  }

  async function load(url, cb) {
  try {
    const post = await findPost(url);
    const item = toItem(post);
    const html = post && post.content && post.content.rendered || "";
    const links = extractDownloadLinks(html);

    const episodes = links.map(function (link, index) {
      const label = (link.context || "") + " " + (link.label || "");
      const se = parseSeasonEpisode(label, index + 1);

const quality = qualityFromUrl(
  (link.context || "") + " " + (link.label || "")
);      return {
        name: "Watch " + quality,
        url: link.url + "?skystream_quality=" + encodeURIComponent(quality),
        quality: quality,
        season: se.season,
        episode: se.episode
      };
    });

    const detail = Object.assign({}, item, {
      url: String(post.link || item.url),
      description: getDescription(post),
      episodes: episodes
    });

    cb({ success: true, data: detail });

  } catch (error) {
    sendError(cb, error, "LOAD_FAILED");
  }
}

  function isDirectMedia(url) {
    return /\.(m3u8|mp4|m4v|webm|mpd)(?:$|[?#])/i.test(String(url || ""));
  }

 function qualityFromUrl(value) {
  const text = String(value || "").toLowerCase();

  if (/\b2160p?\b|\b4k\b/.test(text)) return "2160p";
  if (/\b1080p?\b/.test(text)) return "1080p";
  if (/\b720p?\b/.test(text)) return "720p";
  if (/\b480p?\b/.test(text)) return "480p";
  if (/\b1440p?\b/.test(text)) return "1440p";

  return "Auto";
}

  function extractEmbedUrls(html, pageUrl) {
  const source = String(html || "");
  const found = [];

  const patterns = [
    /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<video\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi
  ];

  const downloadHosts = [
    "fastdl.beer",
    "vcloud.beer",
    "one.vegadrive.app",
    "filebee.top"
  ];

  patterns.forEach(function (pattern, index) {
    let match;

    while ((match = pattern.exec(source)) !== null) {
      let candidate = String(match[1] || "").replace(/&amp;/g, "&");

      if (candidate.startsWith("//")) {
        candidate = "https:" + candidate;
      }

      if (candidate.startsWith("/")) {
        try {
          candidate = new URL(candidate, pageUrl).toString();
        } catch (_) {}
      }

      if (!/^https?:\/\//i.test(candidate)) continue;

      // Only accept known download hosts from ordinary links.
      if (index === 3) {
        try {
          const hostname = new URL(candidate).hostname;
          if (downloadHosts.indexOf(hostname) < 0) continue;
        } catch (_) {
          continue;
        }
      }

      if (found.indexOf(candidate) < 0) {
        found.push(candidate);
      }
    }
  });

  return found;
}

function extractFastDlVideoUrl(html) {
  const source = String(html || "");

  // Find the intermediate download page.
  const reurlMatch = source.match(
    /var\s+reurl\s*=\s*["']([^"']+)["']/i
  );

  if (!reurlMatch) return "";

  // Decode common HTML entities.
  const downloadPage = reurlMatch[1]
    .replace(/&amp;/g, "&")
    .replace(/\\\//g, "/");

  return downloadPage;
}

function extractGoogleVideoUrl(html) {
  const source = String(html || "");

  // Find the anchor with id="vd".
  const anchorMatch = source.match(
    /<a\b(?=[^>]*\bid\s*=\s*["']vd["'])[^>]*>/i
  );

  if (!anchorMatch) return "";

  const hrefMatch = anchorMatch[0].match(
    /\bhref\s*=\s*["']([^"']+)["']/i
  );

  if (!hrefMatch) return "";

  const videoUrl = hrefMatch[1].replace(/&amp;/g, "&");

  try {
    const parsed = new URL(videoUrl);

    if (
      parsed.hostname !== "video-downloads.googleusercontent.com"
    ) {
      return "";
    }

    return videoUrl;
  } catch (_) {
    return "";
  }
}
async function loadStreams(url, cb) {
  try {
const originalTarget = String(url || "").trim();

const qualityMatch = originalTarget.match(
  /[?&]skystream_quality=(2160p|1440p|1080p|720p|480p)/i
);

const detectedQuality = qualityMatch
  ? qualityMatch[1].toLowerCase()
  : "Auto";

const target = originalTarget
  .replace(/[?&]skystream_quality=(2160p|1440p|1080p|720p|480p)/i, "")
  .replace(/[?&]$/, "");
    if (!target) {
      return cb({ success: true, data: [] });
    }

   

    if (isDirectMedia(target)) {
      return cb({
        success: true,
        data: [{
          url: target,
          source: "RogMovies",
          quality: detectedQuality
        }]
      });
    }

    const html = await requestText(
      target,
      "text/html,application/json;q=0.9,*/*;q=0.8"
    );

    const embeds = extractEmbedUrls(html, target);
    const streams = [];

    for (let i = 0; i < embeds.length; i++) {
      const embedUrl = embeds[i];

      try {
        if (new URL(embedUrl).hostname === "fastdl.beer") {
          const fastDlHtml = await requestText(
            embedUrl,
            "text/html,*/*;q=0.8"
          );

          const downloadPage = extractFastDlVideoUrl(fastDlHtml);
          if (!downloadPage) continue;

          const downloadHtml = await requestText(
            downloadPage,
            "text/html,*/*;q=0.8"
          );

          const videoUrl = extractGoogleVideoUrl(downloadHtml);

          if (videoUrl) {
            streams.push({
              url: videoUrl,
              source: "RogMovies FastDL",
              quality: detectedQuality
            });
          }

          continue;
        }

        if (isDirectMedia(embedUrl)) {
          streams.push({
            url: embedUrl,
            source: "RogMovies Embed " + (i + 1),
            quality: detectedQuality
          });
        }
      } catch (_) {}
    }

    cb({ success: true, data: streams });

  } catch (error) {
    sendError(cb, error, "STREAMS_FAILED");
  }
}

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();
