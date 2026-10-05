/**
 * Records the token use of the Claude Code session that develops this bot.
 * Run it before each commit (`pnpm dev-usage`), then stage dev-usage/log.jsonl.
 *
 * It reads the newest Claude Code transcript in ~/.claude/projects (the session that runs this
 * script) and its sub-agent transcripts, and appends the session's running totals to the log.
 * Pass a transcript path to pick another session.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import {
  DEV_USAGE_LOG_PATH,
  DevUsageRow,
  addDevTotals,
  emptyDevTotals,
  parseDevLog,
  totalsFromTranscript,
} from "../src/utils/devUsage";

function newestTranscript(): string | undefined {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) return undefined;
  let newest: { file: string; mtime: number } | undefined;
  for (const dir of fs.readdirSync(root)) {
    const full = path.join(root, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(full, name);
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
  }
  return newest?.file;
}

/** The session transcript plus the sub-agent transcripts stored next to it. */
function sessionFiles(transcript: string): string[] {
  const files = [transcript];
  const subDir = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
  if (fs.existsSync(subDir)) {
    for (const name of fs.readdirSync(subDir)) {
      if (name.endsWith(".jsonl")) files.push(path.join(subDir, name));
    }
  }
  return files;
}

function main(): void {
  const transcript = process.argv[2] ?? newestTranscript();
  if (!transcript || !fs.existsSync(transcript)) {
    console.log("No Claude Code transcript found. Nothing recorded.");
    return;
  }
  const totals = emptyDevTotals();
  for (const file of sessionFiles(transcript)) {
    addDevTotals(totals, totalsFromTranscript(fs.readFileSync(file, "utf-8").split("\n")));
  }
  if (totals.calls === 0) {
    console.log("The transcript has no API calls. Nothing recorded.");
    return;
  }
  totals.costUsd = Math.round(totals.costUsd * 10000) / 10000;

  const repoRoot = execSync("git rev-parse --show-toplevel").toString().trim();
  const logFile = path.join(repoRoot, DEV_USAGE_LOG_PATH);
  const session = path.basename(transcript, ".jsonl").slice(0, 8);
  const existing = fs.existsSync(logFile) ? parseDevLog(fs.readFileSync(logFile, "utf-8")) : [];
  const last = existing.filter((r) => r.session === session).pop();
  if (last && last.calls === totals.calls && last.costUsd === totals.costUsd) {
    console.log(
      `Session ${session}: no new use since the last row ($${totals.costUsd.toFixed(2)}).`,
    );
    return;
  }

  let by: string | undefined;
  try {
    by = execSync("git config user.name").toString().trim() || undefined;
  } catch {
    by = undefined;
  }
  const row: DevUsageRow = { at: new Date().toISOString(), session, by, ...totals };
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify(row) + "\n");
  console.log(
    `Session ${session}: ${totals.calls} calls, $${totals.costUsd.toFixed(2)} so far. Added a row to ${DEV_USAGE_LOG_PATH}.`,
  );
}

main();
