import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../config";
import { TWEET_LINK_TTL_MS } from "../constants";

export interface EmbedLink {
  sourceMessageId: string;
  botMessageId: string;
  channelId: string;
  /** The Discord user who posted the original link */
  authorId: string;
  createdAt: number;
}

/**
 * Remembers which bot reply belongs to which source message so embeds can be
 * cleaned up after a restart. Persisted as a small JSON file in the data dir,
 * written lazily so a burst of links doesn't hammer the disk.
 */
export class TweetLinkStore {
  /** One source message can have several bot replies (one per tweet link) */
  private bySource = new Map<string, EmbedLink[]>();
  private byBotMessage = new Map<string, EmbedLink>();
  private filePath: string;
  private loaded = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(filePath = path.join(config.memory.dataDir, "tweet-embeds.json")) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const links = JSON.parse(raw) as EmbedLink[];
      const cutoff = Date.now() - TWEET_LINK_TTL_MS;
      for (const link of links) {
        if (link.createdAt >= cutoff) this.index(link);
      }
      console.log(`🐦 Loaded ${this.byBotMessage.size} tracked tweet embed(s)`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.error("❌ Error loading tweet embed links:", error);
    }
  }

  add(link: EmbedLink): void {
    this.index(link);
    this.scheduleSave();
  }

  getBySource(sourceMessageId: string): EmbedLink[] {
    return this.bySource.get(sourceMessageId) ?? [];
  }

  getByBotMessage(botMessageId: string): EmbedLink | undefined {
    return this.byBotMessage.get(botMessageId);
  }

  remove(botMessageId: string): void {
    const link = this.byBotMessage.get(botMessageId);
    if (!link) return;
    this.unindex(link);
    this.scheduleSave();
  }

  prune(): void {
    const cutoff = Date.now() - TWEET_LINK_TTL_MS;
    let removed = 0;
    for (const link of Array.from(this.byBotMessage.values())) {
      if (link.createdAt < cutoff) {
        this.unindex(link);
        removed++;
      }
    }
    if (removed > 0) this.scheduleSave();
  }

  destroy(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private index(link: EmbedLink): void {
    const siblings = this.bySource.get(link.sourceMessageId) ?? [];
    siblings.push(link);
    this.bySource.set(link.sourceMessageId, siblings);
    this.byBotMessage.set(link.botMessageId, link);
  }

  private unindex(link: EmbedLink): void {
    this.byBotMessage.delete(link.botMessageId);
    const siblings = (this.bySource.get(link.sourceMessageId) ?? []).filter(
      (l) => l.botMessageId !== link.botMessageId,
    );
    if (siblings.length > 0) this.bySource.set(link.sourceMessageId, siblings);
    else this.bySource.delete(link.sourceMessageId);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 1000);
    this.saveTimer.unref();
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const links = Array.from(this.byBotMessage.values());
      await fs.writeFile(this.filePath, JSON.stringify(links));
    } catch (error) {
      console.error("❌ Error saving tweet embed links:", error);
    }
  }
}
