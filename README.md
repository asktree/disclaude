# Disclaude - Claude AI Discord Bot

A Discord bot that brings Claude AI into your Discord server! When someone mentions `@Claude`, the bot reads the channel's message history and responds intelligently. It also monitors for follow-up messages to maintain natural conversations.

## Features

- **@Mention Response**: Mention the bot to start a conversation
- **Context-Aware**: Reads message history to understand the conversation
- **Follow-Up Monitoring**: Continues responding to relevant messages after being mentioned
- **Smart Response Logic**: Decides when follow-ups are appropriate
- **Multi-Server Support**: Works in multiple Discord servers and DMs
- **Message Splitting**: Handles long responses by splitting them appropriately

## Prerequisites

- Node.js 20+ and pnpm
- Discord Bot Token (from Discord Developer Portal)
- Anthropic API Key (for Claude)

## Setup Instructions

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to "Bot" section in the sidebar
4. Click "Reset Token" to get your bot token (save this!)
5. Under "Privileged Gateway Intents", enable:
   - Message Content Intent
   - Server Members Intent
6. Copy the Application ID from "General Information" section

### 2. Add Bot to Your Server

1. Go to "OAuth2" → "URL Generator" in Discord Developer Portal
2. Select scopes:
   - `bot`
   - `applications.commands` (optional, for future slash commands)
3. Select bot permissions:
   - Send Messages
   - Read Message History
   - View Channels
   - Mention Everyone (optional)
4. Copy the generated URL and open it to add the bot to your server

### 3. Get Anthropic API Key

1. Sign up at [Anthropic Console](https://console.anthropic.com)
2. Generate an API key from your account settings

### 4. Configure Environment

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your credentials
# Add your Discord bot token, client ID, and Anthropic API key
```

### 5. Install & Run

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Or build and run in production
pnpm build
pnpm start
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_BOT_TOKEN` | Your Discord bot token | Required |
| `DISCORD_CLIENT_ID` | Your Discord application ID | Required |
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Required |
| `CLAUDE_MODEL` | Claude model to use | `claude-3-5-sonnet-20241022` |
| `MAX_CONTEXT_MESSAGES` | Number of messages to include as context | `20` |
| `FOLLOW_UP_TIMEOUT_MS` | How long to monitor for follow-ups (ms) | `30000` |
| `FOLLOW_UP_MESSAGE_COUNT` | Max follow-up responses | `3` |

## Deployment Options

### Docker

```bash
# Build and run with Docker
docker build -t disclaude .
docker run --env-file .env disclaude

# Or use docker-compose
docker-compose up -d
```

### Railway

1. Fork this repository
2. Connect Railway to your GitHub
3. Create new project from your fork
4. Add environment variables in Railway dashboard
5. Deploy!

### Render

1. Fork this repository
2. Create new "Background Worker" on Render
3. Connect to your GitHub repository
4. Add environment variables in Render dashboard
5. Deploy!

### Fly.io

```bash
# Install flyctl
# Create fly.toml (example provided)
fly launch
fly secrets set DISCORD_BOT_TOKEN=xxx
fly secrets set ANTHROPIC_API_KEY=xxx
fly secrets set DISCORD_CLIENT_ID=xxx
fly deploy
```

### Traditional VPS

```bash
# Clone repository
git clone https://github.com/yourusername/disclaude.git
cd disclaude

# Install dependencies
pnpm install

# Build
pnpm build

# Run with PM2
npm install -g pm2
pm2 start dist/index.js --name disclaude
pm2 save
pm2 startup
```

## How It Works

1. **Mention Detection**: When someone mentions the bot, it activates
2. **Context Building**: Fetches recent messages from the channel (up to `MAX_CONTEXT_MESSAGES`)
3. **Response Generation**: Sends context to Claude API for intelligent response
4. **Follow-Up Monitoring**: Watches the channel for a period after responding
5. **Smart Follow-Ups**: Evaluates if new messages warrant a response

## Bot Commands

Currently, the bot responds to @mentions only. Slash commands can be added in future versions.

## Development

```bash
# Run in watch mode
pnpm dev

# Type checking
pnpm tsc --noEmit

# Build for production
pnpm build
```

## Project Structure

```
disclaude/
├── src/
│   ├── config.ts           # Configuration loader
│   ├── index.ts            # Main entry point
│   ├── handlers/
│   │   └── messageHandler.ts # Message handling logic
│   ├── services/
│   │   ├── claude.ts       # Claude API integration
│   │   └── contextManager.ts # Context & follow-up management
│   └── types/              # TypeScript type definitions
├── .env.example            # Environment variables template
├── Dockerfile              # Docker configuration
├── docker-compose.yml      # Docker Compose setup
├── railway.toml           # Railway deployment config
└── render.yaml            # Render deployment config
```

## Troubleshooting

### Bot is not responding
- Check if the bot is online in your server's member list
- Verify Message Content Intent is enabled in Discord Developer Portal
- Check logs for any error messages
- Ensure the bot has permission to read/send messages in the channel

### "Missing required environment variable" error
- Copy `.env.example` to `.env`
- Fill in all required values
- Restart the bot

### Rate limiting issues
- Claude API has rate limits; consider adding request throttling
- Discord also has rate limits for sending messages

## Contributing

Pull requests are welcome! Please ensure:
- Code follows TypeScript best practices
- All features are properly typed
- Error handling is comprehensive

## License

ISC

## Support

For issues or questions, please open a GitHub issue.