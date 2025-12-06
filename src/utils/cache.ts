/**
 * LRU (Least Recently Used) Cache implementation
 * Automatically evicts oldest entries when size or age limits are exceeded
 */
export class LRUCache<T> {
  private cache = new Map<string, { value: T; timestamp: number; size: number }>();
  private accessOrder = new Map<string, number>(); // Track access times for LRU
  private currentSize = 0;
  private maxSize: number; // in bytes
  private maxAge: number; // in milliseconds
  private accessCounter = 0;

  constructor(maxSizeMB: number = 100, maxAgeMs: number = 15 * 60 * 1000) {
    this.maxSize = maxSizeMB * 1024 * 1024;
    this.maxAge = maxAgeMs;
  }

  /**
   * Estimate the size of a value in bytes
   */
  private estimateSize(value: T): number {
    // Rough estimation based on JSON stringification
    try {
      const jsonStr = JSON.stringify(value);
      // Each character in a string is typically 2 bytes in JavaScript
      return jsonStr.length * 2;
    } catch {
      // If we can't stringify, assume a default size
      return 1024; // 1KB default
    }
  }

  /**
   * Get a value from the cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    // Check if entry has expired
    const now = Date.now();
    if (now - entry.timestamp > this.maxAge) {
      this.delete(key);
      return undefined;
    }

    // Update access order for LRU tracking
    this.accessOrder.set(key, ++this.accessCounter);

    return entry.value;
  }

  /**
   * Set a value in the cache
   */
  set(key: string, value: T): void {
    // Remove old entry if it exists
    if (this.cache.has(key)) {
      this.delete(key);
    }

    const size = this.estimateSize(value);

    // Evict entries if necessary before adding new one
    this.evictIfNeeded(size);

    // Add the new entry
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      size
    });
    this.accessOrder.set(key, ++this.accessCounter);
    this.currentSize += size;
  }

  /**
   * Delete a specific key from the cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentSize -= entry.size;
      this.cache.delete(key);
      this.accessOrder.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder.clear();
    this.currentSize = 0;
    this.accessCounter = 0;
  }

  /**
   * Get the current size of the cache in bytes
   */
  getSize(): number {
    return this.currentSize;
  }

  /**
   * Get the number of entries in the cache
   */
  getCount(): number {
    return this.cache.size;
  }

  /**
   * Evict entries if needed to make room for new data
   */
  private evictIfNeeded(requiredSize: number): void {
    const now = Date.now();

    // First, remove all expired entries
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.maxAge) {
        this.delete(key);
      }
    }

    // If adding the new item would exceed the size limit, remove LRU items
    while (this.currentSize + requiredSize > this.maxSize && this.cache.size > 0) {
      const lruKey = this.findLRUKey();
      if (lruKey) {
        console.log(`🗑️ Cache eviction: Removing LRU entry '${lruKey}' (size: ${this.cache.get(lruKey)?.size || 0} bytes)`);
        this.delete(lruKey);
      } else {
        break; // Safety check to avoid infinite loop
      }
    }
  }

  /**
   * Find the least recently used key
   */
  private findLRUKey(): string | undefined {
    let lruKey: string | undefined;
    let minAccessTime = Infinity;

    for (const [key, accessTime] of this.accessOrder.entries()) {
      if (accessTime < minAccessTime) {
        minAccessTime = accessTime;
        lruKey = key;
      }
    }

    return lruKey;
  }

  /**
   * Get all keys in the cache
   */
  getKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): {
    count: number;
    sizeBytes: number;
    sizeMB: number;
    maxSizeMB: number;
    utilizationPercent: number;
    oldestEntryAge: number | null;
  } {
    const now = Date.now();
    let oldestAge: number | null = null;

    for (const entry of this.cache.values()) {
      const age = now - entry.timestamp;
      if (oldestAge === null || age > oldestAge) {
        oldestAge = age;
      }
    }

    return {
      count: this.cache.size,
      sizeBytes: this.currentSize,
      sizeMB: this.currentSize / (1024 * 1024),
      maxSizeMB: this.maxSize / (1024 * 1024),
      utilizationPercent: (this.currentSize / this.maxSize) * 100,
      oldestEntryAge: oldestAge
    };
  }
}