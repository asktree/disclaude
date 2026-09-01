import { Message, TextChannel, Collection } from "discord.js";
import { ToolHandler, ToolInput, ToolContext, ToolResult, ToolSchema } from "../types/tool.types";
import { ClaudeService } from "../services/claude";
import { DEFAULT_DISCORD_MESSAGES_LIMIT, MAX_DISCORD_MESSAGES_LIMIT } from "../constants";
import { findChannelByNameOrId, isSnowflake } from "../utils/discordNames";

interface ReadDiscordMessagesInput {
  channel_id?: string;
  limit?: number;
  before_message_id?: string;
  after_message_id?: string;
  around_message_id?: string;
}

export class ReadDiscordMessagesHandler implements ToolHandler {
  name = "read_discord_messages";
  description =
    "Read actual messages from a Discord channel, by channel name or ID. Returns real messages only - never make up content if this tool fails. Use list_discord_channels if you are unsure which channels exist, or search_discord_messages to find something specific.";
  input_schema: ToolSchema = {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description:
          "The Discord channel to read, by ID or by name (e.g. 'general'). If not provided, uses the current channel",
      },
      limit: {
        type: "integer",
        description: `Number of messages to fetch (default: ${DEFAULT_DISCORD_MESSAGES_LIMIT}, max: ${MAX_DISCORD_MESSAGES_LIMIT})`,
      },
      before_message_id: {
        type: "string",
        description: "Get messages before this message ID",
      },
      after_message_id: {
        type: "string",
        description: "Get messages after this message ID",
      },
      around_message_id: {
        type: "string",
        description: "Get messages around this message ID",
      },
    },
    additionalProperties: false,
  };

  private claudeService: ClaudeService;

  constructor(claudeService: ClaudeService) {
    this.claudeService = claudeService;
  }

  validateInput(input: ToolInput): boolean {
    const typed = input as ReadDiscordMessagesInput;

    // channel_id is optional (string if provided)
    if (typed.channel_id !== undefined && typeof typed.channel_id !== "string") {
      return false;
    }

    // limit is optional (number if provided)
    if (typed.limit !== undefined && typeof typed.limit !== "number") {
      return false;
    }

    // Message IDs are optional (string if provided)
    const messageIds = ["before_message_id", "after_message_id", "around_message_id"];
    for (const idField of messageIds) {
      if (
        typed[idField as keyof ReadDiscordMessagesInput] !== undefined &&
        typeof typed[idField as keyof ReadDiscordMessagesInput] !== "string"
      ) {
        return false;
      }
    }

    return true;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let statusMessage: Message | undefined;
    const originalMessage = context.message;

    try {
      // Parse tool input
      const {
        channel_id,
        limit = DEFAULT_DISCORD_MESSAGES_LIMIT,
        before_message_id,
        after_message_id,
        around_message_id,
      } = input as ReadDiscordMessagesInput;

      // Resolve the target channel: name or ID given by Claude, else the current channel
      let targetChannelId: string | undefined;
      let targetChannelName: string | undefined;
      if (channel_id) {
        if (isSnowflake(channel_id)) {
          targetChannelId = channel_id;
        } else if (originalMessage?.guild) {
          const found = findChannelByNameOrId(originalMessage.guild, channel_id);
          if (!found) {
            throw new Error(
              `Channel "${channel_id}" not found. Use list_discord_channels to see available channels.`,
            );
          }
          targetChannelId = found.id;
          targetChannelName = found.name;
        } else {
          throw new Error("Channel names can only be resolved inside a server");
        }
      } else {
        targetChannelId = originalMessage?.channelId;
      }

      if (!targetChannelId) {
        throw new Error("No channel ID provided and current channel not available");
      }

      // Prefer a human-readable channel label for logs and status messages
      const cachedChannel = originalMessage?.client.channels.cache.get(targetChannelId);
      if (!targetChannelName && cachedChannel && "name" in cachedChannel && cachedChannel.name) {
        targetChannelName = cachedChannel.name;
      }
      const channelLabel = channel_id
        ? targetChannelName
          ? `#${targetChannelName}`
          : `<#${targetChannelId}>`
        : "this channel";

      console.log(`   📜 Reading Discord messages from ${channelLabel} (limit: ${limit})`);

      // Send initial status message to Discord
      if (originalMessage && "send" in originalMessage.channel) {
        statusMessage = await originalMessage.channel.send(
          `📜 *Reading ${limit} messages from ${channelLabel}...*`,
        );
      }

      // Get the Discord client from the original message
      const client = originalMessage?.client;
      if (!client) {
        throw new Error("Discord client not available");
      }

      // Fetch the channel
      const targetChannel = await client.channels.fetch(targetChannelId);
      if (!targetChannel || !("messages" in targetChannel)) {
        throw new Error(`Channel ${targetChannelId} not found or not a text channel`);
      }

      // Build fetch options for Discord API
      interface FetchOptions {
        limit: number;
        before?: string;
        after?: string;
        around?: string;
      }
      const fetchOptions: FetchOptions = {
        limit: Math.min(limit, MAX_DISCORD_MESSAGES_LIMIT),
      };
      if (before_message_id) fetchOptions.before = before_message_id;
      if (after_message_id) fetchOptions.after = after_message_id;
      if (around_message_id) fetchOptions.around = around_message_id;

      // Fetch messages
      const messages = (await (targetChannel as TextChannel).messages.fetch(
        fetchOptions,
      )) as unknown as Collection<string, Message>;

      // Convert to array and reverse to get chronological order
      const messageArray = Array.from(messages.values()).reverse() as Message[];

      console.log(`   ✅ Fetched ${messageArray.length} messages`);

      // Format messages using the same methods as initial context
      // This now includes all metadata: timestamps, usernames, reactions, attachments, etc.
      const hasImages = messageArray.some(
        (msg) =>
          msg.attachments.size > 0 &&
          Array.from(msg.attachments.values()).some(
            (att) =>
              att.contentType?.startsWith("image/") ||
              att.name?.match(/\.(png|jpg|jpeg|gif|webp)$/i),
          ),
      );

      // Add channel information to the content
      let formattedContent = `=== Messages from #${
        (targetChannel as TextChannel).name
      } (ID: ${targetChannelId}) ===\n\n`;

      if (hasImages) {
        console.log("   📸 Found images in fetched messages");
        const formatted = await this.claudeService.formatDiscordMessagesWithImages(
          messageArray,
          context.botId,
        );
        // Convert formatted messages to text (already includes rich metadata)
        for (const msg of formatted) {
          if (typeof msg.content === "string") {
            formattedContent += msg.content + "\n\n";
          } else {
            // Handle complex content with images
            const textParts = msg.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("");
            const imageParts = msg.content.filter((c: any) => c.type === "image").length;

            formattedContent += textParts;
            if (imageParts > 0) {
              formattedContent += ` [${imageParts} image(s) loaded]`;
            }
            formattedContent += "\n\n";
          }
        }
      } else {
        // Simple text formatting (already includes rich metadata)
        const formatted = await this.claudeService.formatDiscordMessages(
          messageArray,
          context.botId,
        );
        for (const msg of formatted) {
          formattedContent += msg.content + "\n\n";
        }
      }

      // Edit the status message to show completion
      if (statusMessage) {
        await statusMessage.edit(`✅ *Read ${messageArray.length} messages from ${channelLabel}*`);
      }

      return {
        content: formattedContent || "No messages found",
      };
    } catch (error) {
      console.error("   ❌ Error reading Discord messages:", error);

      // Edit status message to show error
      if (statusMessage) {
        await statusMessage.edit(`⚠️ *Failed to read Discord messages: ${error}*`);
      } else if (originalMessage && "send" in originalMessage.channel) {
        await originalMessage.channel.send(`⚠️ *Failed to read Discord messages: ${error}*`);
      }

      return {
        content: `Error reading Discord messages: ${error}\n\n⚠️ IMPORTANT: Could not read this channel. Do not make up or hallucinate any messages. If you need to check what channels exist, use the list_discord_channels tool first.`,
        error: true,
      };
    }
  }
}
