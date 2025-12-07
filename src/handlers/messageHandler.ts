import { Message, TextChannel, DMChannel, NewsChannel, Collection } from "discord.js";
import { ClaudeService } from "../services/claude";
import { UrlFetcher } from "../services/urlFetcher";
import { RepoReader } from "../services/repoReader";
import { TokenCounter } from "../utils/tokenCounter";
import { buildDiscordMessageRepresentation } from "../utils/messageFormatter";
import { config } from "../config";
import {
  MAX_CHANNEL_FETCH_LIMIT,
  MAX_TOOL_ROUNDS,
  MIN_PRESERVED_MESSAGES,
  DISCORD_MAX_MESSAGE_LENGTH,
  MAX_RECENT_MESSAGES_FOR_URL_SEARCH,
  DEFAULT_DISCORD_MESSAGES_LIMIT,
  MAX_DISCORD_MESSAGES_LIMIT,
  MAX_CODE_OUTPUT_LENGTH,
} from "../constants";
import {
  ClaudeMessage,
  ClaudeResponse,
  ClaudeToolCall,
  ClaudeToolResult,
  GeneratedFile,
  ChannelFetchResult,
  ChannelFetchError,
  FetchedUrl,
  ReadDiscordMessagesInput,
} from "../types";
import { ToolRegistry } from "../services/toolRegistry";
import {
  ReadSourceCodeHandler,
  FetchUrlHandler,
  ReadDiscordMessagesHandler,
  ListDiscordChannelsHandler,
} from "../tools";
import { ToolCall, ToolContext } from "../types/tool.types";

export class MessageHandler {
  private claudeService: ClaudeService;
  private urlFetcher: UrlFetcher;
  private repoReader: RepoReader;
  private tokenCounter: TokenCounter;
  private botId: string;
  private toolRegistry: ToolRegistry;

  constructor(botId: string) {
    this.claudeService = new ClaudeService();
    this.urlFetcher = new UrlFetcher();
    this.repoReader = new RepoReader();
    this.tokenCounter = new TokenCounter();
    this.botId = botId;

    // Initialize tool registry and register tools
    this.toolRegistry = new ToolRegistry();
    this.registerTools();
  }

  private registerTools(): void {
    // Register all tool handlers
    this.toolRegistry.register(new ReadSourceCodeHandler(this.repoReader));
    this.toolRegistry.register(new FetchUrlHandler(this.urlFetcher));
    this.toolRegistry.register(new ReadDiscordMessagesHandler(this.claudeService));
    this.toolRegistry.register(new ListDiscordChannelsHandler());

    console.log("🔧 Registered tools:", this.toolRegistry.getRegisteredTools());
  }

  async handleMessage(message: Message): Promise<void> {
    // Ignore bot's own messages
    if (message.author.id === this.botId) {
      return;
    }

    const isMentioned = message.mentions.has(this.botId);

    // Only respond if mentioned
    if (!isMentioned) {
      return;
    }

    try {
      // Show typing indicator
      if ("sendTyping" in message.channel) {
        await message.channel.sendTyping();
      }

      // Get message context - fetch recent messages from the channel
      const channel = message.channel as TextChannel | DMChannel | NewsChannel;
      const contextMessages = await channel.messages.fetch({
        limit: config.bot.maxContextMessages,
      });

      // Check if any messages have images
      // Note: Discord returns messages in reverse chronological order (newest first)
      // We reverse them to chronological order (oldest first) for proper context
      const messagesArray = Array.from(contextMessages.values()).reverse();

      // Check for channel mentions and auto-fetch their messages
      const channelMentions = message.content.match(/<#(\d+)>/g);
      let linkedChannelContext = "";

      if (channelMentions && isMentioned) {
        console.log(`🔗 Found ${channelMentions.length} channel mention(s) in message`);

        // Extract and validate channel IDs
        const channelIds: string[] = [];
        for (const mention of channelMentions) {
          const channelMatch = mention.match(/<#(\d+)>/);
          if (channelMatch && channelMatch[1]) {
            channelIds.push(channelMatch[1]);
          } else {
            console.error(`   ❌ Invalid channel mention format: ${mention}`);
          }
        }

        // Limit concurrent fetches to avoid rate limits
        const MAX_CONCURRENT_FETCHES = 3;
        const channelsToFetch = channelIds.slice(0, MAX_CONCURRENT_FETCHES);
        if (channelIds.length > MAX_CONCURRENT_FETCHES) {
          console.log(
            `   ⚠️ Limiting to first ${MAX_CONCURRENT_FETCHES} channels (${channelIds.length} mentioned)`,
          );
        }

        // Fetch all channels concurrently
        const channelPromises = channelsToFetch.map(
          async (channelId): Promise<ChannelFetchResult | ChannelFetchError | null> => {
            try {
              const mentionedChannel = await message.client.channels.fetch(channelId);

              if (mentionedChannel && "messages" in mentionedChannel) {
                console.log(`   📖 Fetching from #${(mentionedChannel as TextChannel).name}`);

                // Fetch messages
                const messages = await (mentionedChannel as TextChannel).messages.fetch({
                  limit: MAX_CHANNEL_FETCH_LIMIT,
                });
                const messageArray = Array.from(messages.values()).reverse();

                // Format messages concurrently
                const formattedMessages = await Promise.all(
                  messageArray.map((msg) =>
                    buildDiscordMessageRepresentation(msg, this.botId, true),
                  ),
                );

                return {
                  channelName: (mentionedChannel as TextChannel).name,
                  channelId,
                  content: formattedMessages.join("\n\n"),
                };
              }
              return null;
            } catch (error) {
              console.error(`   ❌ Failed to fetch channel ${channelId}:`, error);
              return {
                channelId,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        );

        // Wait for all channel fetches to complete
        const channelResults = await Promise.all(channelPromises);

        // Build the context string
        for (const result of channelResults) {
          if (result) {
            if ("error" in result) {
              linkedChannelContext += `\n\n[Failed to fetch messages from channel ${result.channelId}: ${result.error}]\n`;
            } else if (result.content) {
              linkedChannelContext += `\n\n=== Automatically fetched from mentioned channel #${result.channelName} (ID: ${result.channelId}) ===\n\n`;
              linkedChannelContext += result.content;
            }
          }
        }
      }
      const hasImages = messagesArray.some(
        (msg) =>
          msg.attachments.size > 0 &&
          Array.from(msg.attachments.values()).some(
            (att) =>
              att.contentType?.startsWith("image/") ||
              att.name?.match(/\.(png|jpg|jpeg|gif|webp)$/i),
          ),
      );

      // Format messages for Claude (with images if present)
      let formattedMessages: ClaudeMessage[];
      if (hasImages) {
        console.log("📸 Found images in message history, processing...");
        formattedMessages = await this.claudeService.formatDiscordMessagesWithImages(
          messagesArray,
          this.botId,
        );
      } else {
        formattedMessages = await this.claudeService.formatDiscordMessages(
          messagesArray,
          this.botId,
        );
      }

      // Apply token-based context trimming
      const initialTokenCount = this.tokenCounter.countMessageTokens(formattedMessages);
      console.log(
        `📊 Initial context: ${formattedMessages.length} messages, ${initialTokenCount} tokens`,
      );

      if (initialTokenCount > config.bot.maxContextTokens) {
        formattedMessages = this.tokenCounter.trimMessagesToTokenLimit(
          formattedMessages,
          config.bot.maxContextTokens,
          MIN_PRESERVED_MESSAGES, // Preserve at least the last 10 messages
        );
        const trimmedTokenCount = this.tokenCounter.countMessageTokens(formattedMessages);
        console.log(
          `✂️ Trimmed to ${formattedMessages.length} messages, ${trimmedTokenCount} tokens`,
        );
      }

      // Extract and fetch the most recent URL from the last 5 messages if enabled
      let urlContext = "";
      if (config.bot.fetchUrls) {
        // Get only the last few messages for URL search
        const recentMessages = formattedMessages.slice(-MAX_RECENT_MESSAGES_FOR_URL_SEARCH);

        // Find the most recent URL by checking messages from newest to oldest
        let mostRecentUrl: string | null = null;
        for (let i = recentMessages.length - 1; i >= 0; i--) {
          const messageText =
            typeof recentMessages[i].content === "string"
              ? recentMessages[i].content
              : JSON.stringify(recentMessages[i].content);

          const urls = this.urlFetcher.extractUrls(messageText as string);
          if (urls.length > 0) {
            mostRecentUrl = urls[urls.length - 1]; // Get the last URL in the message
            break;
          }
        }

        if (mostRecentUrl) {
          console.log(`🔗 Fetching most recent URL from last 5 messages: ${mostRecentUrl}`);
          const urlContents = await this.urlFetcher.fetchAllUrls([mostRecentUrl]);

          if (urlContents.length > 0) {
            urlContext = "\n\nContent from the most recent URL in conversation:\n\n";
            urlContext += `\n--- ${urlContents[0].url} ---\n${urlContents[0].content}\n---\n`;
          }
        } else {
          console.log("🔗 No URLs found in the last 5 messages");
        }
      }

      // Combine URL context and linked channel context
      const additionalContext = urlContext + linkedChannelContext;

      // Generate response for the mention
      const response = await this.claudeService.generateResponse(
        formattedMessages,
        undefined,
        additionalContext,
        undefined,
        true, // Enable tools
        0, // retryCount
        this.toolRegistry.getToolDefinitions(), // Pass tool definitions
      );

      // Handle tool execution if needed
      const finalResponse = await this.handleToolExecution(
        response,
        formattedMessages,
        undefined,
        additionalContext,
        message,
      );

      await this.sendResponse(message, finalResponse);
    } catch (error) {
      console.error("Error handling message:", error);
      await message.reply("Sorry, I encountered an error processing your message.");
    }
  }

  private async handleToolExecution(
    response: ClaudeResponse,
    formattedMessages: ClaudeMessage[],
    systemPrompt?: string,
    urlContext?: string,
    originalMessage?: Message,
    maxRounds: number = MAX_TOOL_ROUNDS,
  ): Promise<string | { text: string; files: GeneratedFile[] }> {
    let currentResponse = response;
    let roundCount = 0;

    // Keep executing tools until Claude returns a text response or we hit the max rounds
    while (roundCount < maxRounds) {
      // If it's a string response, we're done!
      if (typeof currentResponse === "string") {
        if (roundCount === 0) {
          console.log("💬 Claude responded with text (no tools needed)");
        } else {
          console.log(
            `✨ Claude generated final response after ${roundCount} round(s) of tool use`,
          );
        }
        return currentResponse;
      }

      // If it's a response with files, we're done!
      if ("text" in currentResponse && "files" in currentResponse) {
        console.log(`📎 Claude generated response with ${currentResponse.files.length} file(s)`);
        return currentResponse;
      }

      // If it needs tools, execute them
      if (currentResponse.needsTools) {
        roundCount++;
        console.log(
          `\n🤖 [Round ${roundCount}] Claude wants to use ${currentResponse.toolCalls.length} tool(s)`,
        );
        const toolResults: ClaudeToolResult[] = [];

        for (const toolCall of currentResponse.toolCalls) {
          console.log(`\n🔧 Tool Call: ${toolCall.name}`);
          console.log(`   Input: ${JSON.stringify(toolCall.input, null, 2)}`);

          // Check if this is a tool we handle with the registry
          if (this.toolRegistry.hasHandler(toolCall.name)) {
            // Use the tool registry to execute the tool
            const context: ToolContext = {
              message: originalMessage!,
              botId: this.botId,
            };

            const result = await this.toolRegistry.execute(toolCall as ToolCall, context);

            toolResults.push({
              tool_use_id: toolCall.id,
              content: result.content,
            });
          } else if (toolCall.name === "web_search" || toolCall.name === "code_execution") {
            // These tools are handled by Anthropic's API automatically
            // Add placeholder result that will be filled by the API
            console.log(`   ⚙️ Tool '${toolCall.name}' will be handled by Anthropic API`);
            toolResults.push({
              tool_use_id: toolCall.id,
              content: `[Handled by Anthropic API]`,
            });
          } else {
            console.log(`   ⚠️ Unknown tool: ${toolCall.name}`);
            toolResults.push({
              tool_use_id: toolCall.id,
              content: `Error: Unknown tool "${toolCall.name}"`,
            });
          }
        }

        // Add Claude's response (with tool use) to the conversation
        formattedMessages.push({
          role: "assistant",
          content: currentResponse.toolCalls,
        });

        // Add tool results to the conversation as user messages with tool_result blocks
        const toolResultContent = toolResults.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.tool_use_id,
          content: result.content,
        }));

        formattedMessages.push({
          role: "user",
          content: toolResultContent,
        });

        console.log(`\n🔄 [Round ${roundCount}] Sending tool results back to Claude...`);

        // Send thinking message to Discord
        if (originalMessage && "send" in originalMessage.channel) {
          await originalMessage.channel.send(`🤔 *Thinking...*`);
        }

        // Get Claude's next response (might want more tools or might be done)
        currentResponse = await this.claudeService.generateResponse(
          formattedMessages,
          systemPrompt,
          urlContext,
          undefined,
          true, // Keep tools enabled so Claude can use them again if needed
          0, // retryCount
          this.toolRegistry.getToolDefinitions(), // Pass tool definitions
        );
      } else {
        // Unexpected format
        return "I encountered an unexpected response format.";
      }
    }

    // Hit max rounds
    console.log(`⚠️ Reached maximum tool rounds (${maxRounds}), forcing final response...`);

    // Force a final text response without tools
    const finalResponse = await this.claudeService.generateResponse(
      formattedMessages,
      systemPrompt,
      urlContext,
      undefined,
      false, // Disable tools to force a text response
      0, // retryCount
      undefined, // No tool definitions needed when tools are disabled
    );

    return typeof finalResponse === "string"
      ? finalResponse
      : "I encountered an error after multiple tool uses.";
  }

  private async sendResponse(
    message: Message,
    response:
      | string
      | { text: string; files: Array<{ name: string; content: string; mimeType?: string }> },
  ): Promise<void> {
    // Extract text and files
    let responseText: string;
    let files: Array<{ name: string; content: string; mimeType?: string }> = [];

    if (typeof response === "string") {
      responseText = response;
    } else {
      responseText = response.text;
      files = response.files;
    }

    // Prepare Discord attachments from files
    const attachments = files.map((file) => ({
      attachment: Buffer.from(file.content),
      name: file.name,
      description: `Generated file: ${file.name}`,
    }));

    if (responseText.length <= DISCORD_MAX_MESSAGE_LENGTH) {
      // Response fits within limit, send as-is with attachments
      await message.reply({
        content: responseText,
        files: attachments,
      });
    } else {
      // Split long messages into chunks
      console.log(
        `📝 Response is ${responseText.length} chars (exceeds ${DISCORD_MAX_MESSAGE_LENGTH} limit), splitting...`,
      );

      // Log if response contains citations to help debug
      if (responseText.includes("](<")) {
        console.log("⚠️ Response contains citations - monitoring for issues");
      }

      const chunks = this.splitMessage(responseText, DISCORD_MAX_MESSAGE_LENGTH);

      // Send first chunk as reply with attachments (if any)
      await message.reply({
        content: chunks[0],
        files: attachments,
      });

      // Send remaining chunks as follow-up messages
      for (let i = 1; i < chunks.length; i++) {
        if ("send" in message.channel) {
          await message.channel.send(chunks[i]);
        }
      }
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        // Last chunk, add it all
        chunks.push(remaining);
        break;
      }

      // Find the nearest space or newline before the limit
      let splitAt = maxLength;

      // Search backwards from the limit for a space or newline
      for (let i = maxLength - 1; i > 0; i--) {
        if (remaining[i] === " " || remaining[i] === "\n") {
          splitAt = i + 1; // Include the space/newline in the current chunk
          break;
        }
      }

      // If we couldn't find any space/newline, force split at the limit
      // This handles edge cases like very long URLs or words
      if (splitAt === maxLength) {
        console.log("⚠️ No space/newline found, forcing split at character limit");
      }

      // Add this chunk and continue with the rest
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trim(); // Trim leading whitespace from next chunk
    }

    return chunks;
  }
}
