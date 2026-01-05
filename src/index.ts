import {
  Client,
  GatewayIntentBits,
  Events,
  TextChannel,
  REST,
  Routes,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { config } from "./config";
import { MessageHandler } from "./handlers/messageHandler";
import { getLatestCommitInfo, generateCommitSummary } from "./utils/gitInfo";
import { commands, getCommandsJSON } from "./commands";
import { UserInfoStore } from "./services/userInfoStore";

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
          (ch) => ch.name === "computer-buddy-zone" && ch.type === 0, // 0 = GUILD_TEXT channel type
        ) as TextChannel | undefined;

        if (channel) {
          console.log(`   📍 Found computer-buddy-zone in guild: ${guild.name}`);

          // Generate the commit summary
          const summary = await generateCommitSummary(commitInfo);

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
            console.error(`   ❌ Failed to send to ${guild.name}:`, error);
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

    this.client.on(Events.InteractionCreate, async (interaction) => {
      // Handle slash commands
      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      }
      // Handle modal submissions
      else if (interaction.isModalSubmit()) {
        await this.handleModalSubmit(interaction);
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

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = commands.get(interaction.commandName);

    if (!command) {
      console.error(`❌ Unknown command: ${interaction.commandName}`);
      await interaction.reply({ content: "Unknown command", ephemeral: true });
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`❌ Error executing command ${interaction.commandName}:`, error);
      const errorMessage = "There was an error executing this command.";
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, ephemeral: true });
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true });
      }
    }
  }

  private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId === "setinfo_modal") {
      const pronouns = interaction.fields.getTextInputValue("pronouns").trim() || undefined;
      const bio = interaction.fields.getTextInputValue("bio").trim() || undefined;

      const userInfoStore = UserInfoStore.getInstance();
      await userInfoStore.setUserInfo(interaction.user.id, { pronouns, bio });

      const parts: string[] = [];
      if (pronouns) parts.push(`**Pronouns:** ${pronouns}`);
      if (bio) parts.push(`**Bio:** ${bio}`);

      const message =
        parts.length > 0
          ? `Your information has been saved:\n${parts.join("\n")}`
          : "Your information has been cleared.";

      await interaction.reply({ content: message, ephemeral: true });
    }
  }

  private async registerCommands(): Promise<void> {
    const rest = new REST().setToken(config.discord.token);

    try {
      console.log("🔄 Registering slash commands...");

      await rest.put(Routes.applicationCommands(config.discord.clientId), {
        body: getCommandsJSON(),
      });

      console.log("✅ Slash commands registered successfully");
    } catch (error) {
      console.error("❌ Error registering slash commands:", error);
    }
  }

  async start(): Promise<void> {
    try {
      // Ensure data directory exists for memory
      if (config.memory.enabled) {
        const fs = await import("fs/promises");
        try {
          await fs.mkdir(config.memory.dataDir, { recursive: true });
          console.log(`📁 Memory data directory ready: ${config.memory.dataDir}`);
        } catch (error) {
          console.error(`❌ Failed to create memory data directory:`, error);
        }
      }

      console.log("🚀 Starting Disclaude bot...");
      console.log(`📝 Using Claude model: ${config.anthropic.model}`);
      console.log(`💬 Max context messages: ${config.bot.maxContextMessages}`);
      console.log(`🧠 Memory enabled: ${config.memory.enabled ? "Yes" : "No"}`);

      // Register slash commands
      await this.registerCommands();

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
