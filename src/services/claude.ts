import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { Message } from 'discord.js';

export class ClaudeService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: config.anthropic.apiKey,
    });
  }

  async generateResponse(messages: Array<{ role: string; content: string }>, systemPrompt?: string): Promise<string> {
    try {
      const response = await this.anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 2000,
        system: systemPrompt || "You are Claude, a helpful AI assistant in a Discord server. Keep your responses concise and friendly. You can use Discord markdown formatting.",
        messages: messages.map(msg => ({
          role: msg.role === 'user' || msg.role === 'assistant' ? msg.role : 'user',
          content: msg.content,
        })) as Anthropic.MessageParam[],
      });

      // Extract text content from the response
      const textContent = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as Anthropic.TextBlock).text)
        .join('\n');

      return textContent || "I couldn't generate a response.";
    } catch (error) {
      console.error('Error generating Claude response:', error);
      return "Sorry, I encountered an error while processing your request.";
    }
  }

  formatDiscordMessages(messages: Message[], botId: string): Array<{ role: string; content: string }> {
    return messages.map(msg => ({
      role: msg.author.id === botId ? 'assistant' : 'user',
      content: `${msg.author.username}: ${msg.content}`,
    }));
  }
}