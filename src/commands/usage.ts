import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { UsageStore, totalTokens, emptyCounts, UsageCounts } from "../services/usageStore";
import { USAGE_REPORT_MAX_ROWS } from "../constants";

export const data = new SlashCommandBuilder()
  .setName("usage")
  .setDescription("Show the Claude tokens and dollar cost for each person")
  .addStringOption((option) =>
    option
      .setName("period")
      .setDescription("The time period to show (default: last 30 days)")
      .addChoices(
        { name: "Today", value: "1" },
        { name: "Last 7 days", value: "7" },
        { name: "Last 30 days", value: "30" },
        { name: "All time", value: "all" },
      ),
  );

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function money(c: UsageCounts): string {
  const usd = c.costUsd < 0.01 && c.costUsd > 0 ? "<$0.01" : `$${c.costUsd.toFixed(2)}`;
  return c.costEstimated ? `~${usd}` : usd;
}

function line(label: string, c: UsageCounts): string {
  const input = c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens;
  const searches = c.webSearches > 0 ? `, ${c.webSearches} web searches` : "";
  return `**${label}**: ${money(c)}, ${fmt(totalTokens(c))} tokens (${fmt(input)} in, ${fmt(c.outputTokens)} out), ${c.requests} ${c.requests === 1 ? "call" : "calls"}${searches}`;
}

/** Builds the report text. Exported for tests. */
export function formatReport(
  periodLabel: string,
  rows: { userId: string; name: string; counts: UsageCounts }[],
  viewerId: string,
): string {
  if (rows.length === 0) return `No token use recorded for ${periodLabel.toLowerCase()}.`;
  const all = emptyCounts();
  for (const r of rows) {
    for (const k of [
      "requests",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "webSearches",
      "costUsd",
    ] as const) {
      all[k] += r.counts[k];
    }
    if (r.counts.costEstimated) all.costEstimated = true;
  }
  const out = [`📊 **Claude token use: ${periodLabel}**`, line("Everyone", all), ""];
  rows.slice(0, USAGE_REPORT_MAX_ROWS).forEach((r, i) => {
    out.push(`${i + 1}. ${line(r.name, r.counts)}`);
  });
  const viewerIndex = rows.findIndex((r) => r.userId === viewerId);
  if (viewerIndex >= USAGE_REPORT_MAX_ROWS) {
    out.push("…", `${viewerIndex + 1}. ${line(rows[viewerIndex].name, rows[viewerIndex].counts)}`);
  } else if (rows.length > USAGE_REPORT_MAX_ROWS) {
    out.push(`…and ${rows.length - USAGE_REPORT_MAX_ROWS} more.`);
  }
  if (rows.some((r) => r.counts.costEstimated)) {
    out.push("", "~ means the cost is an estimate (calls from before the bot kept costs).");
  }
  return out.join("\n");
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const period = interaction.options.getString("period") ?? "30";
  const days = period === "all" ? undefined : parseInt(period, 10);
  const { since, rows } = await UsageStore.getInstance().report(days);
  const label =
    days === undefined
      ? `all time (since ${since.slice(0, 10)})`
      : days === 1
        ? "Today (UTC)"
        : `Last ${days} days`;
  await interaction.reply({
    content: formatReport(label, rows, interaction.user.id).slice(0, 2000),
    ephemeral: true,
  });
}
