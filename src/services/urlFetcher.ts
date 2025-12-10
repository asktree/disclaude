import * as cheerio from "cheerio";
import {
  URL_FETCH_TIMEOUT_MS,
  MAX_URL_CONTENT_LENGTH,
  URL_CACHE_TTL_MS,
  MAX_IMAGE_SIZE_MB,
  URL_CACHE_MAX_SIZE_MB,
  CACHE_CLEANUP_INTERVAL_MS,
} from "../constants";
import { FetchedUrl, UrlCacheEntry, ClaudeContent } from "../types";
import { LRUCache } from "../utils/cache";

export class UrlFetcher {
  private urlCache: LRUCache<UrlCacheEntry>;
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Initialize LRU cache with size and TTL limits
    this.urlCache = new LRUCache<UrlCacheEntry>(URL_CACHE_MAX_SIZE_MB, URL_CACHE_TTL_MS);

    // Run periodic cleanup to remove expired entries
    this.cleanupInterval = setInterval(() => {
      const statsBefore = this.urlCache.getStats();
      if (statsBefore.count > 0) {
        console.log(
          `🧹 Running cache cleanup - Current: ${statsBefore.count} entries, ${statsBefore.sizeMB.toFixed(2)}MB`,
        );
        // Getting an item triggers expiration check
        const keys = this.urlCache.getKeys();
        for (const key of keys) {
          this.urlCache.get(key); // This will auto-remove expired entries
        }
        const statsAfter = this.urlCache.getStats();
        if (statsAfter.count < statsBefore.count) {
          console.log(`   ✅ Cleaned up ${statsBefore.count - statsAfter.count} expired entries`);
        }
      }
    }, CACHE_CLEANUP_INTERVAL_MS);
  }

  /**
   * Clean up resources when the fetcher is destroyed
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.urlCache.clear();
  }

  async fetchUrl(url: string): Promise<FetchedUrl> {
    try {
      // Check cache first
      const cached = this.urlCache.get(url);
      if (cached) {
        console.log(`📦 Using cached content for ${url}`);
        const stats = this.urlCache.getStats();
        console.log(
          `   Cache stats: ${stats.count} entries, ${stats.sizeMB.toFixed(2)}MB / ${stats.maxSizeMB}MB (${stats.utilizationPercent.toFixed(1)}%)`,
        );
        return { url, content: cached.content, isImage: cached.isImage };
      }

      console.log(`🌐 Fetching ${url}...`);

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; DisclaudeBot/1.0; +https://github.com/asktree/disclaude)",
        },
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        return { url, content: `Failed to fetch (${response.status})` };
      }

      const contentType = response.headers.get("content-type") || "";

      // Handle images
      if (contentType.startsWith("image/")) {
        console.log(`🖼️ Detected image: ${url} (${contentType})`);

        const arrayBuffer = await response.arrayBuffer();
        const rawSizeMB = arrayBuffer.byteLength / (1024 * 1024);

        // Convert to base64 first
        const base64 = Buffer.from(arrayBuffer).toString("base64");

        // Check the actual base64-encoded size against Claude's limit
        const base64SizeBytes = base64.length;
        const base64SizeMB = base64SizeBytes / (1024 * 1024);

        if (base64SizeMB > MAX_IMAGE_SIZE_MB) {
          return {
            url,
            content: `Image too large to process (raw: ${rawSizeMB.toFixed(2)}MB, base64: ${base64SizeMB.toFixed(2)}MB > ${MAX_IMAGE_SIZE_MB}MB)`,
            isImage: true,
          };
        }

        // Determine the media type for Claude
        let mediaType = contentType;
        const supportedImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];

        // If unsupported type, try to infer from URL extension
        if (!supportedImageTypes.includes(contentType)) {
          const urlPath = new URL(url).pathname.toLowerCase();
          if (urlPath.endsWith(".jpg") || urlPath.endsWith(".jpeg")) {
            mediaType = "image/jpeg";
          } else if (urlPath.endsWith(".png")) {
            mediaType = "image/png";
          } else if (urlPath.endsWith(".gif")) {
            mediaType = "image/gif";
          } else if (urlPath.endsWith(".webp")) {
            mediaType = "image/webp";
          } else {
            // Default to JPEG if we can't determine
            mediaType = "image/jpeg";
          }
        }

        // Return as an image content block for Claude
        const imageContent = {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64,
          },
        } as const;

        // Cache the result
        this.urlCache.set(url, {
          content: imageContent,
          timestamp: Date.now(), // LRUCache will use its own timestamp but we keep for compatibility
          isImage: true,
        });

        console.log(
          `✅ Successfully fetched image: ${url} (raw: ${rawSizeMB.toFixed(2)}MB, base64: ${base64SizeMB.toFixed(2)}MB, ${mediaType})`,
        );
        return { url, content: imageContent, isImage: true };
      }

      if (contentType.includes("text/html")) {
        const html = await response.text();
        const $ = cheerio.load(html);

        // Remove scripts and styles
        $("script").remove();
        $("style").remove();

        // Get title
        const title = $("title").text().trim();

        // Get main content (try various selectors)
        let content = "";
        const contentSelectors = [
          "main",
          "article",
          '[role="main"]',
          ".content",
          "#content",
          "body",
        ];

        for (const selector of contentSelectors) {
          const element = $(selector);
          if (element.length > 0) {
            content = element.text().trim();
            if (content.length > 100) break;
          }
        }

        // Clean up whitespace
        content = content.replace(/\s+/g, " ").trim();

        // Limit content length
        if (content.length > MAX_URL_CONTENT_LENGTH) {
          content = content.substring(0, MAX_URL_CONTENT_LENGTH) + "... (truncated)";
        }

        const result = `Title: ${title}\n\n${content}`;

        // Cache the result
        this.urlCache.set(url, { content: result, timestamp: Date.now() });

        return { url, content: result, title };
      } else if (contentType.includes("text/plain")) {
        let content = await response.text();

        // Limit content length
        if (content.length > MAX_URL_CONTENT_LENGTH) {
          content = content.substring(0, MAX_URL_CONTENT_LENGTH) + "... (truncated)";
        }

        // Cache the result
        this.urlCache.set(url, { content, timestamp: Date.now() });

        return { url, content };
      } else if (contentType.includes("application/json")) {
        const json = await response.json();
        const content = JSON.stringify(json, null, 2);

        // Limit content length
        const limitedContent =
          content.length > MAX_URL_CONTENT_LENGTH
            ? content.substring(0, MAX_URL_CONTENT_LENGTH) + "... (truncated)"
            : content;

        // Cache the result
        this.urlCache.set(url, {
          content: limitedContent,
          timestamp: Date.now(),
        });

        return { url, content: limitedContent };
      } else {
        return { url, content: `Unsupported content type: ${contentType}` };
      }
    } catch (error) {
      console.error(`Error fetching ${url}:`, error);
      if (error instanceof Error && error.name === "AbortError") {
        return { url, content: "Request timed out" };
      }
      return { url, content: `Error fetching URL: ${error}` };
    }
  }

  extractUrls(text: string): string[] {
    // Regex to match URLs
    const urlRegex =
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
    const matches = text.match(urlRegex) || [];
    return [...new Set(matches)]; // Remove duplicates
  }

  async fetchAllUrls(urls: string[]): Promise<FetchedUrl[]> {
    // Limit to 5 URLs to avoid overwhelming the context
    const limitedUrls = urls.slice(0, 5);

    const results = await Promise.all(limitedUrls.map((url) => this.fetchUrl(url)));

    return results;
  }

  clearCache(): void {
    this.urlCache.clear();
  }
}
