import { Message, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { ClaudeService } from '../services/claude';
import { ContextManager } from '../services/contextManager';
import { UrlFetcher } from '../services/urlFetcher';
import { WebSearchService } from '../services/webSearch';
import { TokenCounter } from '../utils/tokenCounter';
import { config } from '../config';

export class MessageHandler {
  private claudeService: ClaudeService;
  private contextManager: ContextManager;
  private urlFetcher: UrlFetcher;
  private webSearchService: WebSearchService;
  private tokenCounter: TokenCounter;
  private botId: string;

  constructor(botId: string) {
    this.claudeService = new ClaudeService();
    this.contextManager = new ContextManager();
    this.urlFetcher = new UrlFetcher();
    this.webSearchService = new WebSearchService();
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

      // Extract and fetch URLs if enabled
      let urlContext = '';
      if (config.bot.fetchUrls) {
        const allText = formattedMessages.map(m => m.content).join(' ');
        const urls = this.urlFetcher.extractUrls(allText);

        if (urls.length > 0) {
          console.log(`🔗 Found ${urls.length} URLs in messages`);
          const urlContents = await this.urlFetcher.fetchAllUrls(urls);

          if (urlContents.length > 0) {
            urlContext = '\n\nContent from URLs mentioned in the conversation:\n\n';
            for (const urlContent of urlContents) {
              urlContext += `\n--- ${urlContent.url} ---\n${urlContent.content}\n---\n`;
            }
            console.log(`📑 Fetched content from ${urlContents.length} URLs`);
          }
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
        // Direct mention - use streaming if enabled
        if (config.bot.streamResponses) {
          await this.sendStreamingResponse(
            message,
            formattedMessages,
            undefined,
            urlContext,
            true // Enable tools
          );
        } else {
          // Fallback to non-streaming
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
      }
    } catch (error) {
      console.error('Error handling message:', error);
      await message.reply('Sorry, I encountered an error processing your message.');
    }
  }

  private async sendStreamingResponse(
    message: Message,
    formattedMessages: any[],
    systemPrompt?: string,
    urlContext?: string,
    enableTools: boolean = false
  ): Promise<void> {
    // Send initial empty message that we'll edit
    const responseMessage = await message.reply("​"); // Zero-width space

    let accumulatedText = "";
    let lastUpdateTime = Date.now();
    let updateTimer: NodeJS.Timeout | null = null;
    let currentMessages = [...formattedMessages];
    let roundCount = 0;
    const maxRounds = 5;

    // Function to update Discord message
    const updateMessage = async (finalUpdate: boolean = false) => {
      if (accumulatedText.length > 0 || finalUpdate) {
        try {
          // Add typing indicator if still streaming (not final)
          let displayText = finalUpdate
            ? (accumulatedText || "​")
            : (accumulatedText + " ✍️");

          // Discord has a 2000 character limit for bot messages (not 4000!)
          const maxLength = 1900; // Leave buffer for formatting and safety

          if (displayText.length > maxLength) {
            // If we're over the limit, truncate and add continuation indicator
            displayText = displayText.substring(0, maxLength) + "... [message too long, continuing in next message]";

            // If this is a final update and we're over the limit, we need to send additional messages
            if (finalUpdate) {
              await responseMessage.edit(displayText.substring(0, maxLength));

              // Send the rest in new messages
              let remainingText = accumulatedText.substring(maxLength);
              while (remainingText.length > 0) {
                const chunk = remainingText.substring(0, 2000);
                if ('send' in message.channel) {
                  await message.channel.send(chunk);
                }
                remainingText = remainingText.substring(2000);
              }
              return;
            }
          }

          await responseMessage.edit(displayText);
        } catch (error) {
          console.error("Error updating message:", error);
          // If we can't edit, try sending a new message
          if (finalUpdate && 'send' in message.channel) {
            await message.channel.send("Response too long to edit. Here's the complete message:");
            // Send in chunks
            let chunks = accumulatedText.match(/.{1,2000}/gs) || [];
            for (const chunk of chunks) {
              await message.channel.send(chunk);
            }
          }
        }
      }
    };

    // Stream responses until we get a text response or hit max rounds
    while (roundCount < maxRounds) {
      let streamedText = "";

      // Callback for each token
      const onToken = (token: string) => {
        streamedText += token;
        accumulatedText += token;

        // Update message every N milliseconds to avoid rate limiting
        const now = Date.now();
        if (now - lastUpdateTime >= config.bot.streamUpdateInterval) {
          updateMessage();
          lastUpdateTime = now;
        } else {
          // Schedule an update if we haven't updated recently
          if (updateTimer) clearTimeout(updateTimer);
          updateTimer = setTimeout(() => {
            updateMessage();
            lastUpdateTime = Date.now();
          }, config.bot.streamUpdateInterval);
        }
      };

      // Get the response with streaming
      const response = await this.claudeService.generateResponseWithStream(
        currentMessages,
        systemPrompt,
        urlContext,
        undefined,
        enableTools,
        onToken
      );

      // Clear any pending timer
      if (updateTimer) {
        clearTimeout(updateTimer);
        updateTimer = null;
      }

      // If it's a text response, we're done
      if (typeof response === 'string') {
        // Always do a final update to remove the writing indicator
        await updateMessage(true); // Final update without ✍️
        return;
      }

      // If tools are needed, execute them
      if (response.needsTools) {
        roundCount++;

        // Clear the message for tool execution status
        accumulatedText = "";
        await updateMessage(true);

        // Send tool execution messages
        for (const toolCall of response.toolCalls) {
          if (toolCall.name === 'web_search') {
            // Show searching status
            if ('send' in message.channel) {
              await message.channel.send(`🔍 *Searching for: "${toolCall.input.query}"...*`);
            }

            // Execute the search
            const searchResults = await this.webSearchService.search(toolCall.input.query, 5);

            // Show results with titles
            if ('send' in message.channel) {
              if (searchResults.length > 0) {
                let resultMessage = `📊 **Found ${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}:**\n`;
                searchResults.forEach((result, index) => {
                  // Truncate title if too long
                  const title = result.title.length > 80
                    ? result.title.substring(0, 77) + '...'
                    : result.title;
                  resultMessage += `${index + 1}. ${title}\n`;
                });
                await message.channel.send(resultMessage);
              } else {
                await message.channel.send(`❌ *No results found*`);
              }
            }

            // Add tool results to conversation
            currentMessages.push({
              role: 'assistant',
              content: response.toolCalls
            });

            currentMessages.push({
              role: 'user',
              content: [{
                type: 'tool_result' as const,
                tool_use_id: toolCall.id,
                content: this.formatSearchResults(searchResults, toolCall.input.query)
              }]
            });
          }
        }

        // Send thinking message
        if ('send' in message.channel) {
          await message.channel.send(`🤔 *Thinking...*`);
        }

        // Continue the loop to get next response
        enableTools = true; // Keep tools enabled for next iteration
      } else {
        // Unexpected response
        await updateMessage(true);
        return;
      }
    }

    // Hit max rounds - force final response without tools
    const finalResponse = await this.claudeService.generateResponse(
      currentMessages,
      systemPrompt,
      urlContext,
      undefined,
      false
    );

    accumulatedText = typeof finalResponse === 'string' ? finalResponse : 'I encountered an error after multiple tool uses.';
    await updateMessage(true); // Final update to remove indicator
  }

  private formatSearchResults(results: any[], query: string): string {
    let resultsText = `Search results for "${query}":\n\n`;
    for (const result of results) {
      resultsText += `**${result.title}**\n`;
      resultsText += `${result.snippet}\n`;
      if (result.url) {
        resultsText += `URL: ${result.url}\n`;
      }
      resultsText += `\n`;
    }
    return resultsText;
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

          if (toolCall.name === 'web_search') {
            try {
              const searchQuery = toolCall.input.query;
              console.log(`   🔍 Executing search for: "${searchQuery}"`);

              // Send thinking message to Discord
              if (originalMessage && 'send' in originalMessage.channel) {
                await originalMessage.channel.send(`🔍 *Searching for: "${searchQuery}"...*`);
              }

              const searchResults = await this.webSearchService.search(searchQuery, 5);

              // Format search results for Claude
              let resultsText = `Search results for "${searchQuery}":\n\n`;
              for (const result of searchResults) {
                resultsText += `**${result.title}**\n`;
                resultsText += `${result.snippet}\n`;
                if (result.url) {
                  resultsText += `URL: ${result.url}\n`;
                }
                resultsText += `\n`;
              }

              console.log(`   ✅ Found ${searchResults.length} search results`);

              // Send results with titles to Discord
              if (originalMessage && 'send' in originalMessage.channel) {
                if (searchResults.length > 0) {
                  let resultMessage = `📊 **Found ${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}:**\n`;
                  searchResults.forEach((result, index) => {
                    // Truncate title if too long
                    const title = result.title.length > 80
                      ? result.title.substring(0, 77) + '...'
                      : result.title;
                    resultMessage += `${index + 1}. ${title}\n`;
                  });
                  await originalMessage.channel.send(resultMessage);
                } else {
                  await originalMessage.channel.send(`❌ *No results found*`);
                }
              }

              toolResults.push({
                tool_use_id: toolCall.id,
                content: resultsText
              });
            } catch (error) {
              console.error('   ❌ Error executing web search:', error);

              // Send error message to Discord
              if (originalMessage && 'send' in originalMessage.channel) {
                await originalMessage.channel.send(`⚠️ *Search failed: ${error}*`);
              }

              toolResults.push({
                tool_use_id: toolCall.id,
                content: `Error performing search: ${error}`
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