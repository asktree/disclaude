import { Message, TextChannel, Collection } from "discord.js";
import { ToolHandler, ToolInput, ToolContext, ToolResult, ToolSchema } from "../types/tool.types";
import { ClaudeService } from "../services/claude";
import { DEFAULT_DISCORD_MESSAGES_LIMIT, MAX_DISCORD_MESSAGES_LIMIT } from "../constants";

interface ReadDiscordMessagesInput {
  channel_id?: string;
  limit?: number;
  before_message_id?: string;
  after_message_id?: string;
  around_message_id?: string;
}

export class ReadDiscordMessagesHandler implements ToolHandler {
  name = "read_discord_messages";
  description = "Read messages from a Discord channel";
  input_schema: ToolSchema = {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The Discord channel ID. If not provided, uses the current channel",
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

      // Use current channel if not specified
      const targetChannelId = channel_id || originalMessage?.channelId;

      if (!targetChannelId) {
        throw new Error("No channel ID provided and current channel not available");
      }

      console.log(
        `   📜 Reading Discord messages from channel ${targetChannelId} (limit: ${limit})`,
      );

      // Send initial status message to Discord
      if (originalMessage && "send" in originalMessage.channel) {
        statusMessage = await originalMessage.channel.send(
          `📜 *Reading ${limit} messages from ${
            channel_id ? `channel <#${channel_id}>` : "this channel"
          }...*`,
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
        await statusMessage.edit(
          `✅ *Read ${messageArray.length} messages from ${
            channel_id ? `<#${channel_id}>` : "this channel"
          }*`,
        );
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
        content: `Error reading Discord messages: ${error}`,
        error: true,
      };
    }
  }
}
