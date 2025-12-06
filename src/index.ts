import { Client, GatewayIntentBits, Events, TextChannel } from "discord.js";
import { config } from "./config";
import { MessageHandler } from "./handlers/messageHandler";
import { getLatestCommitInfo, generateCommitSummary } from "./utils/gitInfo";

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

  private async sendStartupNotification(client: Client): Promise<void> {
    try {
      // Get the latest commit info
      const commitInfo = await getLatestCommitInfo();
      if (!commitInfo) {
        console.log("⚠️ Could not get commit info for startup notification");
        return;
      }

      console.log(`📢 Looking for computer-buddy-zone channels...`);

      // Search all guilds for channels named "computer-buddy-zone"
      for (const guild of client.guilds.cache.values()) {
        const channel = guild.channels.cache.find(
          (ch) =>
            ch.name === "computer-buddy-zone" &&
            ch.type === 0 // 0 = GUILD_TEXT channel type
        ) as TextChannel | undefined;

        if (channel) {
          console.log(
            `   📍 Found computer-buddy-zone in guild: ${guild.name}`
          );

          // Generate the commit summary
          const summary = generateCommitSummary(commitInfo);

          // Create the message with embed
          const message = {
            content: `🎉 I've been updated!`,
            embeds: [
              {
                title: "Update Details",
                description: summary,
                color: 0x00ff00, // Green color
                fields: [
                  {
                    name: "Commit",
                    value: `[\`${commitInfo.shortHash}\`](${commitInfo.githubUrl})`,
                    inline: true,
                  },
                  {
                    name: "Files Changed",
                    value: commitInfo.filesChanged.length.toString(),
                    inline: true,
                  },
                ],
                footer: {
                  text: `Deployed at ${new Date().toLocaleString()}`,
                },
              },
            ],
          };

          try {
            await channel.send(message);
            console.log(`   ✅ Sent startup notification to ${guild.name}`);
          } catch (error) {
            console.error(
              `   ❌ Failed to send to ${guild.name}:`,
              error
            );
          }
        }
      }
    } catch (error) {
      console.error("Error sending startup notification:", error);
    }
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, async (readyClient) => {
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

      // Send startup notification to computer-buddy-zone channels
      await this.sendStartupNotification(readyClient);
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
