import { Message, TextChannel, DMChannel, NewsChannel } from 'discord.js';
import { ClaudeService } from '../services/claude';
import { ContextManager } from '../services/contextManager';

export class MessageHandler {
  private claudeService: ClaudeService;
  private contextManager: ContextManager;
  private botId: string;

  constructor(botId: string) {
    this.claudeService = new ClaudeService();
    this.contextManager = new ContextManager();
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
      await message.channel.sendTyping();

      // Get message context
      const channel = message.channel as TextChannel | DMChannel | NewsChannel;
      const contextMessages = await this.contextManager.getMessageContext(channel);

      // Format messages for Claude
      const formattedMessages = this.claudeService.formatDiscordMessages(
        Array.from(contextMessages.values()),
        this.botId
      );

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

        const response = await this.claudeService.generateResponse(formattedMessages, shouldRespondPrompt);

        if (response === "NO_RESPONSE" || response.includes("NO_RESPONSE")) {
          return;
        }

        // Increment follow-up count since we're responding
        this.contextManager.incrementFollowUpCount(message.channelId);

        // Send the response
        await this.sendResponse(message, response);
      } else {
        // Direct mention - always respond
        const response = await this.claudeService.generateResponse(formattedMessages);
        await this.sendResponse(message, response);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      await message.reply('Sorry, I encountered an error processing your message.');
    }
  }

  private async sendResponse(message: Message, response: string): Promise<void> {
    // Discord has a 2000 character limit
    if (response.length <= 2000) {
      await message.reply(response);
    } else {
      // Split long responses
      const chunks = this.splitMessage(response, 2000);
      for (const chunk of chunks) {
        await message.channel.send(chunk);
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