import { Client, GatewayIntentBits, Events } from "discord.js";
import { config } from "./config";
import { MessageHandler } from "./handlers/messageHandler";

class DisclaudeBot {
  private client: Client;
  private messageHandler: MessageHandler | null = null;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, (readyClient) => {
      console.log(`✅ Logged in as ${readyClient.user.tag}!`);
      console.log(`🤖 Bot ID: ${readyClient.user.id}`);
      console.log(`📡 Connected to ${readyClient.guilds.cache.size} guilds`);

      // Initialize message handler with bot ID
      this.messageHandler = new MessageHandler(readyClient.user.id);

      // Set bot presence
      readyClient.user.setPresence({
        activities: [{ name: "ping me for a reply 😃", type: 3 }], // Type 3 = Watching
        status: "online",
      });
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (this.messageHandler) {
        await this.messageHandler.handleMessage(message);
      }
    });

    this.client.on(Events.Error, (error) => {
      console.error("Discord client error:", error);
    });

    this.client.on(Events.Warn, (warning) => {
      console.warn("Discord client warning:", warning);
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log("\n🛑 Shutting down gracefully...");
      this.client.destroy();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      console.log("\n🛑 Shutting down gracefully...");
      this.client.destroy();
      process.exit(0);
    });
  }

  async start(): Promise<void> {
    try {
      console.log("🚀 Starting Disclaude bot...");
      console.log(`📝 Using Claude model: ${config.anthropic.model}`);
      console.log(`💬 Max context messages: ${config.bot.maxContextMessages}`);
      console.log(`⏱️  Follow-up timeout: ${config.bot.followUpTimeoutMs}ms`);
      console.log(
        `🔄 Max follow-up messages: ${config.bot.followUpMessageCount}`
      );

      await this.client.login(config.discord.token);
    } catch (error) {
      console.error("Failed to start bot:", error);
      process.exit(1);
    }
  }
}

// Start the bot
const bot = new DisclaudeBot();
bot.start().catch(console.error);
