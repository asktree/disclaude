import { Message, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { ClaudeService } from '../services/claude';
import { ContextManager } from '../services/contextManager';
import { UrlFetcher } from '../services/urlFetcher';
import { RepoReader } from '../services/repoReader';
import { TokenCounter } from '../utils/tokenCounter';
import { config } from '../config';

export class MessageHandler {
  private claudeService: ClaudeService;
  private contextManager: ContextManager;
  private urlFetcher: UrlFetcher;
  private repoReader: RepoReader;
  private tokenCounter: TokenCounter;
  private botId: string;

  constructor(botId: string) {
    this.claudeService = new ClaudeService();
    this.contextManager = new ContextManager();
    this.urlFetcher = new UrlFetcher();
    this.repoReader = new RepoReader();
    this.tokenCounter = new TokenCounter();
    this.botId = botId;
  }

  async handleMessage(message: Message): Promise<void> {
    // Ignore bot's own messages
    if (message.author.id === this.botId) {
      return;
    }

    const isMentioned = message.mentions.has(this.botId);
    const isMonitoring = this.contextManager.isMonitoringChannel(message.channelId);

    // Check if we should respond
    if (!isMentioned && !isMonitoring) {
      return;
    }

    // If mentioned, reset the follow-up count and start monitoring
    if (isMentioned) {
      this.contextManager.resetFollowUpCount(message.channelId);
      this.contextManager.startMonitoring(message.channelId);
    } else if (isMonitoring && !this.contextManager.shouldRespond(message.channelId)) {
      return;
    }

    try {
      // Show typing indicator
      if ('sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }

      // Get message context
      const channel = message.channel as TextChannel | DMChannel | NewsChannel;
      const contextMessages = await this.contextManager.getMessageContext(channel);

      // Check if any messages have images
      const messagesArray = Array.from(contextMessages.values());
      const hasImages = messagesArray.some(msg =>
        msg.attachments.size > 0 &&
        Array.from(msg.attachments.values()).some(att =>
          att.contentType?.startsWith('image/') ||
          att.name?.match(/\.(png|jpg|jpeg|gif|webp)$/i)
        )
      );

      // Format messages for Claude (with images if present)
      let formattedMessages: any[];
      if (hasImages) {
        console.log('📸 Found images in message history, processing...');
        formattedMessages = await this.claudeService.formatDiscordMessagesWithImages(
          messagesArray,
          this.botId
        );
      } else {
        formattedMessages = this.claudeService.formatDiscordMessages(
          messagesArray,
          this.botId
        );
      }

      // Apply token-based context trimming
      const initialTokenCount = this.tokenCounter.countMessageTokens(formattedMessages);
      console.log(`📊 Initial context: ${formattedMessages.length} messages, ${initialTokenCount} tokens`);

      if (initialTokenCount > config.bot.maxContextTokens) {
        formattedMessages = this.tokenCounter.trimMessagesToTokenLimit(
          formattedMessages,
          config.bot.maxContextTokens,
          10 // Preserve at least the last 10 messages
        );
        const trimmedTokenCount = this.tokenCounter.countMessageTokens(formattedMessages);
        console.log(`✂️ Trimmed to ${formattedMessages.length} messages, ${trimmedTokenCount} tokens`);
      }

      // Extract and fetch the most recent URL from the last 5 messages if enabled
      let urlContext = '';
      if (config.bot.fetchUrls) {
        // Get only the last 5 messages
        const recentMessages = formattedMessages.slice(-5);

        // Find the most recent URL by checking messages from newest to oldest
        let mostRecentUrl: string | null = null;
        for (let i = recentMessages.length - 1; i >= 0; i--) {
          const messageText = typeof recentMessages[i].content === 'string'
            ? recentMessages[i].content
            : JSON.stringify(recentMessages[i].content);

          const urls = this.urlFetcher.extractUrls(messageText);
          if (urls.length > 0) {
            mostRecentUrl = urls[urls.length - 1]; // Get the last URL in the message
            break;
          }
        }

        if (mostRecentUrl) {
          console.log(`🔗 Fetching most recent URL from last 5 messages: ${mostRecentUrl}`);
          const urlContents = await this.urlFetcher.fetchAllUrls([mostRecentUrl]);

          if (urlContents.length > 0) {
            urlContext = '\n\nContent from the most recent URL in conversation:\n\n';
            urlContext += `\n--- ${urlContents[0].url} ---\n${urlContents[0].content}\n---\n`;
            console.log(`📑 Fetched content from: ${urlContents[0].url}`);
          }
        } else {
          console.log('🔗 No URLs found in the last 5 messages');
        }
      }


      // Determine if follow-up response is needed
      if (isMonitoring && !isMentioned) {
        // Add context about this being a follow-up
        const lastMessage = formattedMessages[formattedMessages.length - 1];
        const shouldRespondPrompt = `
You are in a Discord conversation. Someone previously mentioned you, and you're monitoring for follow-up messages.
The last message was: "${lastMessage.content}"

Decide if you should respond to continue the conversation. Only respond if:
1. The message is directed at you or continues the conversation
2. The message asks a question or needs clarification
3. The user seems to expect a response

If you decide not to respond, simply say "NO_RESPONSE".
Otherwise, provide a helpful response.
        `;

        const response = await this.claudeService.generateResponse(
          formattedMessages,
          shouldRespondPrompt,
          urlContext,
          undefined,
          true // Enable tools
        );

        if (typeof response === 'string' && (response === "NO_RESPONSE" || response.includes("NO_RESPONSE"))) {
          return;
        }

        // Increment follow-up count since we're responding
        this.contextManager.incrementFollowUpCount(message.channelId);

        // Handle tool execution if needed
        const finalResponse = await this.handleToolExecution(response, formattedMessages, undefined, urlContext, message);

        // Send the response
        await this.sendResponse(message, finalResponse);
      } else if (isMentioned) {
        // Direct mention - always use non-streaming
        const response = await this.claudeService.generateResponse(
          formattedMessages,
          undefined,
          urlContext,
          undefined,
          true // Enable tools
        );

        // Handle tool execution if needed
        const finalResponse = await this.handleToolExecution(response, formattedMessages, undefined, urlContext, message);

        await this.sendResponse(message, finalResponse);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      await message.reply('Sorry, I encountered an error processing your message.');
    }
  }



  private async handleToolExecution(
    response: string | { needsTools: true; toolCalls: any[] },
    formattedMessages: any[],
    systemPrompt?: string,
    urlContext?: string,
    originalMessage?: Message,
    maxRounds: number = 5
  ): Promise<string> {
    let currentResponse = response;
    let roundCount = 0;

    // Keep executing tools until Claude returns a text response or we hit the max rounds
    while (roundCount < maxRounds) {
      // If it's a string response, we're done!
      if (typeof currentResponse === 'string') {
        if (roundCount === 0) {
          console.log('💬 Claude responded with text (no tools needed)');
        } else {
          console.log(`✨ Claude generated final response after ${roundCount} round(s) of tool use`);
        }
        return currentResponse;
      }

      // If it needs tools, execute them
      if (currentResponse.needsTools) {
        roundCount++;
        console.log(`\n🤖 [Round ${roundCount}] Claude wants to use ${currentResponse.toolCalls.length} tool(s)`);
        const toolResults: any[] = [];

        for (const toolCall of currentResponse.toolCalls) {
          console.log(`\n🔧 Tool Call: ${toolCall.name}`);
          console.log(`   Input: ${JSON.stringify(toolCall.input, null, 2)}`);

          // Note: web_search is handled automatically by Anthropic's API
          // We only handle custom tools here
          if (toolCall.name === 'read_source_code') {
            try {
              const files = toolCall.input.files || [];
              console.log(`   📖 Reading source code: ${files.length === 0 ? 'repository structure' : files.join(', ')}`);

              // Send status message to Discord
              if (originalMessage && 'send' in originalMessage.channel) {
                if (files.length === 0) {
                  await originalMessage.channel.send(`📂 *Getting repository structure...*`);
                } else {
                  await originalMessage.channel.send(`📖 *Reading ${files.length} source file${files.length !== 1 ? 's' : ''}...*`);
                }
              }

              // Execute the file reading
              let sourceContent = '';
              if (files.length === 0) {
                // Get repository structure
                sourceContent = await this.repoReader.getRepoStructure();
                console.log(`   ✅ Loaded repository structure`);
              } else {
                // Read specific files
                for (const filePath of files) {
                  const content = await this.repoReader.getFileContent(filePath);
                  sourceContent += `\n--- ${filePath} ---\n\`\`\`typescript\n${content}\n\`\`\`\n`;
                }
                console.log(`   ✅ Loaded ${files.length} source file(s)`);
              }

              // Send completion message to Discord
              if (originalMessage && 'send' in originalMessage.channel) {
                if (files.length === 0) {
                  await originalMessage.channel.send(`✅ *Repository structure loaded*`);
                } else {
                  await originalMessage.channel.send(`✅ *Loaded ${files.length} file${files.length !== 1 ? 's' : ''}*`);
                }
              }

              toolResults.push({
                tool_use_id: toolCall.id,
                content: sourceContent
              });
            } catch (error) {
              console.error('   ❌ Error reading source code:', error);

              // Send error message to Discord
              if (originalMessage && 'send' in originalMessage.channel) {
                await originalMessage.channel.send(`⚠️ *Failed to read source code: ${error}*`);
              }

              toolResults.push({
                tool_use_id: toolCall.id,
                content: `Error reading source code: ${error}`
              });
            }
          } else if (toolCall.name === 'fetch_url') {
            try {
              const url = toolCall.input.url;
              console.log(`   🔗 Fetching URL: ${url}`);

              // Send status message to Discord
              if (originalMessage && 'send' in originalMessage.channel) {
                await originalMessage.channel.send(`🔗 *Fetching content from ${url}...*`);
              }

              // Fetch the URL content
              const fetchedUrls = await this.urlFetcher.fetchAllUrls([url]);
              let urlContent = '';

              if (fetchedUrls.length > 0 && fetchedUrls[0].content) {
                urlContent = `URL: ${fetchedUrls[0].url}\nTitle: ${fetchedUrls[0].title || 'N/A'}\n\nContent:\n${fetchedUrls[0].content}`;
                console.log(`   ✅ Successfully fetched content from ${url}`);

                // Send completion message to Discord
                if (originalMessage && 'send' in originalMessage.channel) {
                  await originalMessage.channel.send(`✅ *Content fetched from ${url}*`);
                }
              } else {
                urlContent = `Failed to fetch content from ${url}`;
                console.log(`   ❌ Failed to fetch content from ${url}`);

                // Send error message to Discord
                if (originalMessage && 'send' in originalMessage.channel) {
                  await originalMessage.channel.send(`⚠️ *Failed to fetch content from ${url}*`);
                }
              }

              toolResults.push({
                tool_use_id: toolCall.id,
                content: urlContent
              });
            } catch (error) {
              console.error(`   ❌ Error fetching URL:`, error);

              // Send error message to Discord
              if (originalMessage && 'send' in originalMessage.channel) {
                await originalMessage.channel.send(`⚠️ *Failed to fetch URL: ${error}*`);
              }

              toolResults.push({
                tool_use_id: toolCall.id,
                content: `Error fetching URL: ${error}`
              });
            }
          }
        }

        // Add Claude's response (with tool use) to the conversation
        formattedMessages.push({
          role: 'assistant',
          content: currentResponse.toolCalls
        });

        // Add tool results to the conversation as user messages with tool_result blocks
        const toolResultContent = toolResults.map(result => ({
          type: 'tool_result' as const,
          tool_use_id: result.tool_use_id,
          content: result.content
        }));

        formattedMessages.push({
          role: 'user',
          content: toolResultContent
        });

        console.log(`\n🔄 [Round ${roundCount}] Sending tool results back to Claude...`);

        // Send thinking message to Discord
        if (originalMessage && 'send' in originalMessage.channel) {
          await originalMessage.channel.send(`🤔 *Thinking...*`);
        }

        // Get Claude's next response (might want more tools or might be done)
        currentResponse = await this.claudeService.generateResponse(
          formattedMessages,
          systemPrompt,
          urlContext,
          undefined,
          true // Keep tools enabled so Claude can use them again if needed
        );
      } else {
        // Unexpected format
        return 'I encountered an unexpected response format.';
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
      false // Disable tools to force a text response
    );

    return typeof finalResponse === 'string' ? finalResponse : 'I encountered an error after multiple tool uses.';
  }

  private async sendResponse(message: Message, response: string): Promise<void> {
    // Discord has a 2000 character limit
    if (response.length <= 2000) {
      await message.reply(response);
    } else {
      // Split long responses
      const chunks = this.splitMessage(response, 2000);
      for (const chunk of chunks) {
        if ('send' in message.channel) {
          await message.channel.send(chunk);
        }
      }
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let currentChunk = '';

    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }

        // If a single sentence is too long, split by words
        if (sentence.length > maxLength) {
          const words = sentence.split(' ');
          for (const word of words) {
            if (currentChunk.length + word.length + 1 > maxLength) {
              chunks.push(currentChunk.trim());
              currentChunk = word;
            } else {
              currentChunk += (currentChunk ? ' ' : '') + word;
            }
          }
        } else {
          currentChunk = sentence;
        }
      } else {
        currentChunk += sentence;
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

}