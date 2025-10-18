import dotenv from 'dotenv';

dotenv.config();

export const config = {
  discord: {
    token: process.env.DISCORD_BOT_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
  },
  bot: {
    maxContextMessages: parseInt(process.env.MAX_CONTEXT_MESSAGES || '20', 10),
    followUpTimeoutMs: parseInt(process.env.FOLLOW_UP_TIMEOUT_MS || '30000', 10),
    followUpMessageCount: parseInt(process.env.FOLLOW_UP_MESSAGE_COUNT || '3', 10),
  },
};

// Validate required environment variables
const requiredEnvVars = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'ANTHROPIC_API_KEY',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}