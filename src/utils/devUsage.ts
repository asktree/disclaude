import { costUsd, BillableUsage } from "./pricing";

/**
 * Token use of the Claude Code sessions that develop this bot.
 * scripts/dev-usage.ts appends one row per session before each commit to DEV_USAGE_LOG_PATH.
 * Each row holds the session's running totals, so the newest row of a session is its total.
 */
export const DEV_USAGE_LOG_PATH = "dev-usage/log.jsonl";

export interface DevUsageRow {
  at: string; // ISO time the row was written
  session: string; // short id of the Claude Code session
  by?: string; // git user who ran the script
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number; // at API list prices
}

export type DevUsageTotals = Omit<DevUsageRow, "at" | "session" | "by">;

const NUMBER_KEYS = [
  "calls",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "webSearches",
  "costUsd",
] as const;

export function emptyDevTotals(): DevUsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
    costUsd: 0,
  };
}

/** Sums the API usage of one transcript's assistant messages. Lines that repeat a message id count once. */
export function totalsFromTranscript(lines: string[]): DevUsageTotals {
  const byMessage = new Map<string, { model: string; usage: any }>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (entry?.type !== "assistant" || !message?.usage || !message.id) continue;
    byMessage.set(message.id, { model: message.model ?? "", usage: message.usage });
  }
  const totals = emptyDevTotals();
  for (const { model, usage } of byMessage.values()) {
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheWrite1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const billable: BillableUsage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWrite5mTokens: Math.max(cacheWrite - cacheWrite1h, 0),
      cacheWrite1hTokens: cacheWrite1h,
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
    };
    totals.calls += 1;
    totals.inputTokens += billable.inputTokens;
    totals.outputTokens += billable.outputTokens;
    totals.cacheReadTokens += billable.cacheReadTokens;
    totals.cacheWriteTokens += cacheWrite;
    totals.webSearches += billable.webSearches;
    totals.costUsd += costUsd(model, billable) ?? 0;
  }
  return totals;
}

export function addDevTotals(into: DevUsageTotals, from: DevUsageTotals, sign = 1): void {
  for (const k of NUMBER_KEYS) into[k] += sign * from[k];
}

export function parseDevLog(text: string): DevUsageRow[] {
  const rows: DevUsageRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row.session === "string" && typeof row.at === "string") rows.push(row);
    } catch {
      // Skip a broken line, for example a merge leftover
    }
  }
  return rows;
}

/**
 * Dev use from `since` (ISO date or time) until now; omit `since` for all time.
 * Rows are running totals, so use in a period is the growth of each session in that period.
 */
export function devTotals(
  rows: DevUsageRow[],
  since?: string,
): DevUsageTotals & { sessions: number } {
  const bySession = new Map<string, DevUsageRow[]>();
  for (const row of rows) {
    const list = bySession.get(row.session) ?? [];
    list.push(row);
    bySession.set(row.session, list);
  }
  const totals = { ...emptyDevTotals(), sessions: 0 };
  for (const list of bySession.values()) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    let prev: DevUsageRow | undefined;
    let counted = false;
    for (const row of list) {
      if (since === undefined || row.at >= since) {
        addDevTotals(totals, row);
        if (prev) addDevTotals(totals, prev, -1);
        counted = true;
      }
      prev = row;
    }
    if (counted) totals.sessions += 1;
  }
  return totals;
}
