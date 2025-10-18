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
    maxContextMessages: parseInt(process.env.MAX_CONTEXT_MESSAGES || '100', 10), // Fetch more messages
    maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '8000', 10), // But limit by tokens
    followUpTimeoutMs: parseInt(process.env.FOLLOW_UP_TIMEOUT_MS || '30000', 10),
    followUpMessageCount: parseInt(process.env.FOLLOW_UP_MESSAGE_COUNT || '3', 10),
    fetchUrls: process.env.FETCH_URLS !== 'false', // Default true
    streamResponses: process.env.STREAM_RESPONSES !== 'false', // Default true - stream tokens like Claude UI
    streamUpdateInterval: parseInt(process.env.STREAM_UPDATE_INTERVAL || '500', 10), // Update Discord message every 500ms
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