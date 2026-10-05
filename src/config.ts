import dotenv from "dotenv";
import {
  DEFAULT_MAX_CONTEXT_MESSAGES,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_CLAUDE_MODEL,
  TWEET_DEFAULT_TRANSLATE_TO,
  DEFAULT_LEDGER_DEVELOPER,
  DEFAULT_LEDGER_PROJECT,
} from "./constants";

dotenv.config();

export const config = {
  discord: {
    token: process.env.DISCORD_BOT_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
  },
  bot: {
    maxContextMessages: parseInt(
      process.env.MAX_CONTEXT_MESSAGES || String(DEFAULT_MAX_CONTEXT_MESSAGES),
      10,
    ),
    maxContextTokens: parseInt(
      process.env.MAX_CONTEXT_TOKENS || String(DEFAULT_MAX_CONTEXT_TOKENS),
      10,
    ),
    fetchUrls: process.env.FETCH_URLS !== "false", // Default true
  },
  tweets: {
    enabled: process.env.TWEET_EMBEDS !== "false", // Default true
    // Language to translate posts into (like X's "Translate post"). Empty string disables.
    translateTo: (process.env.TWEET_TRANSLATE_TO ?? TWEET_DEFAULT_TRANSLATE_TO)
      .trim()
      .toLowerCase(),
  },
  // Developer requests go to Ledger when LEDGER_URL and LEDGER_TOKEN are set
  ledger: {
    url: (process.env.LEDGER_URL || "").trim(),
    token: (process.env.LEDGER_TOKEN || "").trim(),
    developer: process.env.LEDGER_DEVELOPER || DEFAULT_LEDGER_DEVELOPER,
    project: process.env.LEDGER_PROJECT || DEFAULT_LEDGER_PROJECT,
    // Comma-separated server IDs that may file requests; empty means every server
    guildIds: (process.env.LEDGER_GUILD_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  },
  memory: {
    dataDir:
      process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT
        ? "/data" // Use mounted volume in production (Railway)
        : "./data", // Use local directory in development
    enabled: process.env.ENABLE_MEMORY !== "false", // Default true
  },
};

// Validate required environment variables
const requiredEnvVars = ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "ANTHROPIC_API_KEY"];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

if (!process.env.CLAUDE_MODEL) {
  console.log(`🤖 CLAUDE_MODEL not set, using default: ${config.anthropic.model}`);
} else {
  console.log(`🤖 CLAUDE_MODEL set to: ${config.anthropic.model}`);
}
