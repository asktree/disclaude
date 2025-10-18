export class WebSearchService {
  async search(query: string, limit: number = 5): Promise<SearchResult[]> {
    try {
      console.log(`🔍 Searching for: "${query}"`);

      // First, try using SearXNG public instance (no API key needed)
      const results = await this.searchWithSearXNG(query, limit);

      if (results.length > 0 && results[0].title !== 'No results found') {
        return results;
      }

      // Fallback to DuckDuckGo instant answers for specific queries
      return await this.searchWithDuckDuckGoInstant(query, limit);
    } catch (error) {
      console.error('Search error:', error);
      return [{
        title: 'Search Error',
        snippet: `Failed to search: ${error}`,
        url: '',
        source: 'Error'
      }];
    }
  }

  // Use SearXNG public instance (privacy-focused metasearch engine)
  private async searchWithSearXNG(query: string, limit: number): Promise<SearchResult[]> {
    try {
      // Using a public SearXNG instance
      const searchUrl = `https://searx.be/search?q=${encodeURIComponent(query)}&format=json&language=en`;

      const response = await fetch(searchUrl, {
        headers: {
          'Accept': 'application/json',
        }
      });

      if (!response.ok) {
        console.log(`SearXNG search failed with status ${response.status}, trying alternative...`);
        return this.searchWithAlternativeSearXNG(query, limit);
      }

      const data = await response.json();
      const results: SearchResult[] = [];

      if (data.results && Array.isArray(data.results)) {
        for (let i = 0; i < Math.min(data.results.length, limit); i++) {
          const item = data.results[i];
          results.push({
            title: item.title || 'Untitled',
            snippet: item.content || item.description || 'No description available',
            url: item.url || '',
            source: item.engine || 'Web Search'
          });
        }
      }

      return results.length > 0 ? results : [{
        title: 'No results found',
        snippet: `No search results found for "${query}".`,
        url: '',
        source: 'Search'
      }];
    } catch (error) {
      console.log('SearXNG search failed:', error);
      return [];
    }
  }

  // Try alternative SearXNG instance
  private async searchWithAlternativeSearXNG(query: string, limit: number): Promise<SearchResult[]> {
    try {
      // Alternative public SearXNG instances
      const instances = [
        'https://search.bus-hit.me',
        'https://searx.tiekoetter.com',
        'https://searx.fmac.xyz'
      ];

      for (const instance of instances) {
        try {
          const searchUrl = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=en`;

          const response = await fetch(searchUrl, {
            headers: {
              'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(5000) // 5 second timeout
          });

          if (response.ok) {
            const data = await response.json();
            const results: SearchResult[] = [];

            if (data.results && Array.isArray(data.results)) {
              for (let i = 0; i < Math.min(data.results.length, limit); i++) {
                const item = data.results[i];
                results.push({
                  title: item.title || 'Untitled',
                  snippet: item.content || item.description || 'No description available',
                  url: item.url || '',
                  source: item.engine || 'Web Search'
                });
              }
            }

            if (results.length > 0) {
              console.log(`✅ Search successful using ${instance}`);
              return results;
            }
          }
        } catch (instanceError) {
          console.log(`Instance ${instance} failed, trying next...`);
          continue;
        }
      }

      return [];
    } catch (error) {
      console.log('Alternative SearXNG search failed:', error);
      return [];
    }
  }

  // Fallback to DuckDuckGo instant answers for specific queries
  private async searchWithDuckDuckGoInstant(query: string, limit: number): Promise<SearchResult[]> {
    try {
      const response = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
      );

      if (!response.ok) {
        throw new Error(`DuckDuckGo search failed: ${response.status}`);
      }

      const data = await response.json();
      const results: SearchResult[] = [];

      // Extract instant answer if available
      if (data.AbstractText) {
        results.push({
          title: data.Heading || query,
          snippet: data.AbstractText,
          url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
          source: 'DuckDuckGo Instant Answer'
        });
      }

      // Add related topics if available
      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (let i = 0; i < Math.min(data.RelatedTopics.length, limit - results.length); i++) {
          const topic = data.RelatedTopics[i];
          if (topic && topic.Text) {
            results.push({
              title: topic.Text.split(' - ')[0] || 'Related Topic',
              snippet: topic.Text,
              url: topic.FirstURL || '',
              source: 'DuckDuckGo'
            });
          }
        }
      }

      // If we have any results, return them
      if (results.length > 0) {
        return results;
      }

      // Otherwise, return a search link as fallback
      return [{
        title: `Search for "${query}"`,
        snippet: `Click to search for "${query}" on DuckDuckGo. Direct API results were not available for this query.`,
        url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        source: 'DuckDuckGo'
      }];
    } catch (error) {
      console.error('DuckDuckGo instant search error:', error);
      return [{
        title: `Search for "${query}"`,
        snippet: 'Search service temporarily unavailable. Please try again later.',
        url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        source: 'Search'
      }];
    }
  }

  // Alternative: Use Serper API (better results, requires free API key)
  async searchWithSerper(query: string, apiKey: string): Promise<SearchResult[]> {
    try {
      const response = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: query })
      });

      const data = await response.json();

      return data.organic?.map((result: any) => ({
        title: result.title,
        snippet: result.snippet,
        url: result.link,
        source: 'Google'
      })) || [];
    } catch (error) {
      console.error('Serper search error:', error);
      return [];
    }
  }
}

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  source: string;
}