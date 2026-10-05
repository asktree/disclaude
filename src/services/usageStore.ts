import { AsyncLocalStorage } from "async_hooks";
import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../config";
import { USAGE_DAYS_KEPT, USAGE_SAVE_DELAY_MS, USAGE_LEGACY_MODEL } from "../constants";
import { costUsd as priceUsage } from "../utils/pricing";

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
  costUsd: number;
  // True when part of costUsd is an estimate: calls recorded before costs were kept,
  // or calls on a model with no known price (priced as USAGE_LEGACY_MODEL).
  costEstimated?: boolean;
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
    costUsd: 0,
  };
}

function add(into: UsageCounts, from: UsageCounts): void {
  into.requests += from.requests;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
  into.webSearches += from.webSearches;
  into.costUsd += from.costUsd;
  if (from.costEstimated) into.costEstimated = true;
}

/** Prices a bucket recorded before costs were kept, with the model that was live then. */
function backfillCost(c: UsageCounts): void {
  if (typeof c.costUsd === "number") return;
  c.costUsd =
    priceUsage(USAGE_LEGACY_MODEL, {
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cacheReadTokens: c.cacheReadTokens,
      cacheWrite5mTokens: c.cacheWriteTokens,
      cacheWrite1hTokens: 0,
      webSearches: c.webSearches,
    }) ?? 0;
  c.costEstimated = true;
}

/** All tokens billed for a call: input (fresh and cached) plus output. */
export function totalTokens(c: UsageCounts): number {
  return c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens + c.outputTokens;
}

/** Converts the API's `usage` object into our counts, priced for the model that answered. */
export function countsFromApiUsage(usage: any, model: string): UsageCounts {
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  // The split by cache lifetime is optional in the API; unsplit writes are priced as 5-minute writes
  const cacheWrite1h = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const billable = {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: Math.max(cacheWrite - cacheWrite1h, 0),
    cacheWrite1hTokens: cacheWrite1h,
    webSearches: usage?.server_tool_use?.web_search_requests ?? 0,
  };
  let cost = priceUsage(model, billable);
  let estimated = false;
  if (cost === undefined) {
    cost = priceUsage(USAGE_LEGACY_MODEL, billable) ?? 0;
    estimated = true;
  }
  return {
    requests: 1,
    inputTokens: billable.inputTokens,
    outputTokens: billable.outputTokens,
    cacheReadTokens: billable.cacheReadTokens,
    cacheWriteTokens: cacheWrite,
    webSearches: billable.webSearches,
    costUsd: cost,
    ...(estimated ? { costEstimated: true } : {}),
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
      for (const user of Object.values(this.data.users)) {
        backfillCost(user.total);
        Object.values(user.days).forEach(backfillCost);
      }
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

  /** Per-user counts, highest cost first. `days` limits to the last N days (UTC); omit for all time. */
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
    rows.sort((a, b) => b.counts.costUsd - a.counts.costUsd);
    return { since: this.data.since, rows };
  }
}
