import { AsyncLocalStorage } from "async_hooks";
import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../config";
import { USAGE_DAYS_KEPT, USAGE_SAVE_DELAY_MS } from "../constants";

/** Who a Claude call is for. Set around each reply so every API call in it is counted for that person. */
export interface UsageRequester {
  userId: string;
  name: string;
}

export const usageContext = new AsyncLocalStorage<UsageRequester>();

export interface UsageCounts {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

interface UserUsage {
  name: string;
  total: UsageCounts;
  days: Record<string, UsageCounts>; // "YYYY-MM-DD" (UTC)
}

interface UsageData {
  since: string;
  users: Record<string, UserUsage>;
}

export interface UsageRow {
  userId: string;
  name: string;
  counts: UsageCounts;
}

export function emptyCounts(): UsageCounts {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
  };
}

function add(into: UsageCounts, from: UsageCounts): void {
  into.requests += from.requests;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  into.webSearches += from.webSearches;
}

/** All tokens billed for a call: input (fresh and cached) plus output. */
export function totalTokens(c: UsageCounts): number {
  return c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens + c.outputTokens;
}

/** Converts the API's `usage` object into our counts. */
export function countsFromApiUsage(usage: any): UsageCounts {
  return {
    requests: 1,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    webSearches: usage?.server_tool_use?.web_search_requests ?? 0,
  };
}

/**
 * Keeps how many Claude tokens each Discord user spent, in total and per day.
 * Stored as JSON next to the bot's other data, so it survives restarts.
 */
export class UsageStore {
  private static instance: UsageStore;
  private data: UsageData = { since: new Date().toISOString(), users: {} };
  private loaded = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private filePath: string = path.join(config.memory.dataDir, "token-usage.json")) {}

  static getInstance(): UsageStore {
    if (!UsageStore.instance) {
      UsageStore.instance = new UsageStore();
    }
    return UsageStore.instance;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      this.data = JSON.parse(await fs.readFile(this.filePath, "utf-8"));
    } catch (error: any) {
      if (error.code !== "ENOENT") console.error("❌ Error loading token usage:", error);
    }
    this.loaded = true;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, USAGE_SAVE_DELAY_MS);
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data));
    } catch (error) {
      console.error("❌ Error saving token usage:", error);
    }
  }

  async record(requester: UsageRequester, counts: UsageCounts, now = new Date()): Promise<void> {
    await this.ensureLoaded();
    const user = (this.data.users[requester.userId] ??= {
      name: requester.name,
      total: emptyCounts(),
      days: {},
    });
    user.name = requester.name;
    add(user.total, counts);
    const day = now.toISOString().slice(0, 10);
    add((user.days[day] ??= emptyCounts()), counts);

    // Drop day buckets older than we report on
    const cutoff = new Date(now.getTime() - USAGE_DAYS_KEPT * 86400000).toISOString().slice(0, 10);
    for (const d of Object.keys(user.days)) {
      if (d < cutoff) delete user.days[d];
    }
    this.scheduleSave();
  }

  /** Per-user counts, most tokens first. `days` limits to the last N days (UTC); omit for all time. */
  async report(days?: number, now = new Date()): Promise<{ since: string; rows: UsageRow[] }> {
    await this.ensureLoaded();
    const cutoff =
      days === undefined
        ? undefined
        : new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const rows: UsageRow[] = [];
    for (const [userId, user] of Object.entries(this.data.users)) {
      let counts: UsageCounts;
      if (cutoff === undefined) {
        counts = { ...user.total };
      } else {
        counts = emptyCounts();
        for (const [day, c] of Object.entries(user.days)) {
          if (day >= cutoff) add(counts, c);
        }
      }
      if (counts.requests > 0) rows.push({ userId, name: user.name, counts });
    }
    rows.sort((a, b) => totalTokens(b.counts) - totalTokens(a.counts));
    return { since: this.data.since, rows };
  }
}
