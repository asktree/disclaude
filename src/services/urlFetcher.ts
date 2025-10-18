import * as cheerio from 'cheerio';

export class UrlFetcher {
  private urlCache: Map<string, { content: string; timestamp: number }> = new Map();
  private cacheTimeout = 15 * 60 * 1000; // 15 minutes

  async fetchUrl(url: string): Promise<{ url: string; content: string; title?: string }> {
    try {
      // Check cache first
      const cached = this.urlCache.get(url);
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        console.log(`📦 Using cached content for ${url}`);
        return { url, content: cached.content };
      }

      console.log(`🌐 Fetching ${url}...`);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DisclaudeBot/1.0; +https://github.com/asktree/disclaude)',
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        return { url, content: `Failed to fetch (${response.status})` };
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text/html')) {
        const html = await response.text();
        const $ = cheerio.load(html);

        // Remove scripts and styles
        $('script').remove();
        $('style').remove();

        // Get title
        const title = $('title').text().trim();

        // Get main content (try various selectors)
        let content = '';
        const contentSelectors = [
          'main',
          'article',
          '[role="main"]',
          '.content',
          '#content',
          'body'
        ];

        for (const selector of contentSelectors) {
          const element = $(selector);
          if (element.length > 0) {
            content = element.text().trim();
            if (content.length > 100) break;
          }
        }

        // Clean up whitespace
        content = content.replace(/\s+/g, ' ').trim();

        // Limit content length
        if (content.length > 5000) {
          content = content.substring(0, 5000) + '... (truncated)';
        }

        const result = `Title: ${title}\n\n${content}`;

        // Cache the result
        this.urlCache.set(url, { content: result, timestamp: Date.now() });

        return { url, content: result, title };
      } else if (contentType.includes('text/plain')) {
        let content = await response.text();

        // Limit content length
        if (content.length > 5000) {
          content = content.substring(0, 5000) + '... (truncated)';
        }

        // Cache the result
        this.urlCache.set(url, { content, timestamp: Date.now() });

        return { url, content };
      } else if (contentType.includes('application/json')) {
        const json = await response.json();
        const content = JSON.stringify(json, null, 2);

        // Limit content length
        const limitedContent = content.length > 5000
          ? content.substring(0, 5000) + '... (truncated)'
          : content;

        // Cache the result
        this.urlCache.set(url, { content: limitedContent, timestamp: Date.now() });

        return { url, content: limitedContent };
      } else {
        return { url, content: `Unsupported content type: ${contentType}` };
      }
    } catch (error) {
      console.error(`Error fetching ${url}:`, error);
      if (error instanceof Error && error.name === 'AbortError') {
        return { url, content: 'Request timed out' };
      }
      return { url, content: `Error fetching URL: ${error}` };
    }
  }

  extractUrls(text: string): string[] {
    // Regex to match URLs
    const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;
    const matches = text.match(urlRegex) || [];
    return [...new Set(matches)]; // Remove duplicates
  }

  async fetchAllUrls(urls: string[]): Promise<Array<{ url: string; content: string; title?: string }>> {
    // Limit to 5 URLs to avoid overwhelming the context
    const limitedUrls = urls.slice(0, 5);

    const results = await Promise.all(
      limitedUrls.map(url => this.fetchUrl(url))
    );

    return results;
  }

  clearCache(): void {
    this.urlCache.clear();
  }
}