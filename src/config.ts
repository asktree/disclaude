import dotenv from "dotenv";
import { DEFAULT_MAX_CONTEXT_MESSAGES, DEFAULT_MAX_CONTEXT_TOKENS } from "./constants";

dotenv.config();

export const config = {
  discord: {
    token: process.env.DISCORD_BOT_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: process.env.CLAUDE_MODEL || "claude-3-5-sonnet-20241022",
  },
  bot: {
    maxContextMessages: parseInt(process.env.MAX_CONTEXT_MESSAGES || String(DEFAULT_MAX_CONTEXT_MESSAGES), 10),
    maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || String(DEFAULT_MAX_CONTEXT_TOKENS), 10),
    fetchUrls: process.env.FETCH_URLS !== "false", // Default true
  },
};

// Validate required environment variables
const requiredEnvVars = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_ID",
  "ANTHROPIC_API_KEY",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}
