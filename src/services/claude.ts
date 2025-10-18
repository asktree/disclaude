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
    messages: Array<{ role: string; content: string | Anthropic.MessageParam['content'] }>,
    systemPrompt?: string,
    additionalContext?: string,
    model?: string
  ): Promise<string> {
    try {
      // Build the system prompt with additional context if provided
      let fullSystemPrompt =
        systemPrompt ||
        `You are Claude, also known as Computer Buddy, a helpful AI assistant in a Discord server. Keep your responses concise and friendly. You can use Discord markdown formatting, your messages will be sent as normal user messages.

When users share images, you can see and analyze them. Describe what you see and answer any questions about them.

You're built with TypeScript, Discord.js, and the Anthropic SDK.
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


  formatDiscordMessages(
    messages: Message[],
    botId: string
  ): Array<{ role: string; content: string }> {
    return messages.map((msg) => ({
      role: msg.author.id === botId ? "assistant" : "user",
      content: `${msg.author.username}: ${msg.content}`,
    }));
  }

  async formatDiscordMessagesWithImages(
    messages: Message[],
    botId: string
  ): Promise<Array<{ role: string; content: string | any[] }>> {
    const formattedMessages = [];

    for (const msg of messages) {
      const role = msg.author.id === botId ? "assistant" : "user";
      const content: any[] = [];

      // Add text content if present
      if (msg.content) {
        content.push({
          type: "text",
          text: `${msg.author.username}: ${msg.content}`,
        });
      }

      // Add image attachments
      const imageAttachments = Array.from(msg.attachments.values()).filter(att =>
        att.contentType?.startsWith('image/') ||
        att.name?.match(/\.(png|jpg|jpeg|gif|webp)$/i)
      );

      for (const attachment of imageAttachments) {
        try {
          console.log(`🖼️ Processing image: ${attachment.name} (${attachment.url})`);

          // Fetch the image data
          const response = await fetch(attachment.url);
          const arrayBuffer = await response.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');

          // Determine media type
          const mediaType = attachment.contentType || 'image/jpeg';

          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64,
            },
          });

          // Add description of the image
          if (!msg.content) {
            content.unshift({
              type: "text",
              text: `${msg.author.username} shared an image: ${attachment.name}`,
            });
          }
        } catch (error) {
          console.error(`Failed to fetch image ${attachment.url}:`, error);
          content.push({
            type: "text",
            text: `[Failed to load image: ${attachment.name}]`,
          });
        }
      }

      // Only add message if there's content
      if (content.length > 0) {
        formattedMessages.push({
          role,
          content: content.length === 1 && typeof content[0].text === 'string'
            ? content[0].text
            : content,
        });
      }
    }

    return formattedMessages;
  }
}
