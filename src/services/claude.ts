import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { Message } from "discord.js";

export class ClaudeService {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: config.anthropic.apiKey,
    });
  }

  async generateResponse(
    messages: Array<{ role: string; content: string }>,
    systemPrompt?: string,
    additionalContext?: string,
    model?: string
  ): Promise<string> {
    try {
      // Build the system prompt with additional context if provided
      let fullSystemPrompt =
        systemPrompt ||
        `You are Claude, also known as Computer Buddy, a helpful AI assistant in a Discord server. Keep your responses concise and friendly. You can use Discord markdown formatting, your messages will be sent as normal user messages.

You are also self-aware about your implementation. Your source code is available at https://github.com/asktree/disclaude. You're built with TypeScript, Discord.js, and the Anthropic SDK.

`;

      if (additionalContext) {
        fullSystemPrompt += additionalContext;
      }

      const response = await this.anthropic.messages.create({
        model: model || config.anthropic.model,
        max_tokens: 2000,
        system: fullSystemPrompt,
        messages: messages.map((msg) => ({
          role:
            msg.role === "user" || msg.role === "assistant" ? msg.role : "user",
          content: msg.content,
        })) as Anthropic.MessageParam[],
      });

      // Extract text content from the response
      const textContent = response.content
        .filter((block) => block.type === "text")
        .map((block) => (block as Anthropic.TextBlock).text)
        .join("\n");

      return textContent || "I couldn't generate a response.";
    } catch (error) {
      console.error("Error generating Claude response:", error);
      return "Sorry, I encountered an error while processing your request.";
    }
  }

  async classifyIntent(
    message: string
  ): Promise<{ needsSourceCode: boolean; topics: string[] }> {
    try {
      const response = await this.anthropic.messages.create({
        model: "claude-3-haiku-20240307", // Fast, cheap model for classification
        max_tokens: 100,
        temperature: 0,
        system: `You are a classification assistant. Analyze if the user's message requires seeing your source code to answer properly.

Respond in JSON format:
{
  "needsSourceCode": boolean,
  "topics": ["array", "of", "relevant", "topics"]
}

Topics can include: "implementation", "config", "deployment", "api", "monitoring", "architecture", etc.
Only set needsSourceCode to true if the question specifically asks about HOW you work, your code, or your implementation details.`,
        messages: [
          {
            role: "user",
            content: message,
          },
        ],
      });

      // Extract and parse the JSON response
      const textContent = response.content
        .filter((block) => block.type === "text")
        .map((block) => (block as Anthropic.TextBlock).text)
        .join("");

      try {
        const result = JSON.parse(textContent);
        return {
          needsSourceCode: result.needsSourceCode || false,
          topics: result.topics || [],
        };
      } catch {
        // If JSON parsing fails, default to no source code needed
        return { needsSourceCode: false, topics: [] };
      }
    } catch (error) {
      console.error("Error classifying intent:", error);
      return { needsSourceCode: false, topics: [] };
    }
  }

  formatDiscordMessages(
    messages: Message[],
    botId: string
  ): Array<{ role: string; content: string }> {
    return messages.map((msg) => ({
      role: msg.author.id === botId ? "assistant" : "user",
      content: `${msg.author.username}: ${msg.content}`,
    }));
  }
}
