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

  async generateResponseWithStream(
    messages: Array<{
      role: string;
      content: string | Anthropic.MessageParam["content"];
    }>,
    systemPrompt?: string,
    additionalContext?: string,
    model?: string,
    enableTools: boolean = false,
    onToken?: (token: string) => void,
    retryCount: number = 0
  ): Promise<string | { needsTools: true; toolCalls: any[] }> {
    try {
      console.log(
        `\n🧠 Claude is thinking (${
          config.bot.streamResponses ? "streaming" : "batch"
        })... (model: ${model || config.anthropic.model}, tools: ${
          enableTools ? "enabled" : "disabled"
        })${retryCount > 0 ? ` [Retry ${retryCount}]` : ''}`
      );

      // Build the system prompt with additional context if provided
      const currentDate = new Date();
      const dateStr = currentDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      const timeStr = currentDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      });

      let fullSystemPrompt =
        systemPrompt ||
        `You are Claude, also known as Computer Buddy, a helpful AI assistant in a Discord server. Keep your responses concise and friendly. You can use Discord markdown formatting, your messages will be sent as normal user messages.

Current date and time: ${dateStr} at ${timeStr}

When users share images, you can see and analyze them. Describe what you see and answer any questions about them.

You're built with TypeScript, Discord.js, and the Anthropic SDK. Your source code is available at https://github.com/asktree/disclaude.

When users ask about current events, news, or information that might have changed after your training, use the web_search tool to find current information.
`;

      if (additionalContext) {
        fullSystemPrompt += additionalContext;
      }

      const tools = enableTools
        ? [
            {
              name: "web_search",
              description:
                "Search the web for current information. Use this when users ask about recent events, news, or any information that might need to be up-to-date.",
              input_schema: {
                type: "object" as const,
                properties: {
                  query: {
                    type: "string" as const,
                    description: "The search query",
                  },
                },
                required: ["query"],
              },
            },
          ]
        : undefined;

      // If streaming is enabled and we have a callback, use streaming
      if (config.bot.streamResponses && onToken) {
        const stream = await this.anthropic.messages.create({
          model: model || config.anthropic.model,
          max_tokens: 2000,
          system: fullSystemPrompt,
          tools,
          messages: messages.map((msg) => ({
            role:
              msg.role === "user" || msg.role === "assistant"
                ? msg.role
                : "user",
            content: msg.content,
          })) as Anthropic.MessageParam[],
          stream: true,
        });

        let fullText = "";
        const toolCalls: any[] = [];
        let currentToolCall: any = null;

        for await (const event of stream) {
          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              currentToolCall = {
                id: event.content_block.id,
                name: event.content_block.name,
                input: "",
              };
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              fullText += event.delta.text;
              onToken(event.delta.text);
            } else if (
              event.delta.type === "input_json_delta" &&
              currentToolCall
            ) {
              currentToolCall.input += event.delta.partial_json;
            }
          } else if (event.type === "content_block_stop") {
            if (currentToolCall) {
              try {
                currentToolCall.input = JSON.parse(currentToolCall.input);
                toolCalls.push(currentToolCall);
              } catch (e) {
                console.error("Failed to parse tool input:", e);
              }
              currentToolCall = null;
            }
          }
        }

        // If we collected tool calls, return them
        if (toolCalls.length > 0) {
          return { needsTools: true, toolCalls };
        }

        return fullText || "I couldn't generate a response.";
      } else {
        // Use non-streaming when streaming is disabled
        return this.generateResponse(
          messages,
          systemPrompt,
          additionalContext,
          model,
          enableTools
        );
      }
    } catch (error: any) {
      // Check if it's a retryable error (500, 502, 503, 529)
      const isRetryable = error?.status && [500, 502, 503, 529].includes(error.status);
      const isOverloaded = error?.message?.includes('Overloaded');
      const hasRetryHeader = error?.headers?.get?.('x-should-retry') === 'true';

      if ((isRetryable || isOverloaded || hasRetryHeader) && retryCount < 3) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Exponential backoff: 1s, 2s, 4s (max 10s)
        console.log(`⚠️ API error (${error?.status || 'unknown'}), retrying in ${delay}ms... (attempt ${retryCount + 1}/3)`);

        await new Promise(resolve => setTimeout(resolve, delay));

        // Retry the request
        return this.generateResponseWithStream(
          messages,
          systemPrompt,
          additionalContext,
          model,
          enableTools,
          onToken,
          retryCount + 1
        );
      }

      console.error("Error generating response:", error);

      // Provide more specific error messages
      if (error?.status === 500 || isOverloaded) {
        return "Sorry, Claude's servers are temporarily overloaded. Please try again in a moment.";
      } else if (error?.status === 429) {
        return "Sorry, we're hitting rate limits. Please wait a moment before trying again.";
      } else if (error?.status >= 500) {
        return "Sorry, there's a temporary issue with Claude's servers. Please try again later.";
      }

      return "Sorry, I encountered an error while processing your request.";
    }
  }

  async generateResponse(
    messages: Array<{
      role: string;
      content: string | Anthropic.MessageParam["content"];
    }>,
    systemPrompt?: string,
    additionalContext?: string,
    model?: string,
    enableTools: boolean = false,
    retryCount: number = 0
  ): Promise<string | { needsTools: true; toolCalls: any[] }> {
    try {
      console.log(
        `\n🧠 Claude is thinking... (model: ${
          model || config.anthropic.model
        }, tools: ${enableTools ? "enabled" : "disabled"})${
          retryCount > 0 ? ` [Retry ${retryCount}]` : ''
        }`
      );

      // Build the system prompt with additional context if provided
      const currentDate = new Date();
      const dateStr = currentDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      const timeStr = currentDate.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      });

      let fullSystemPrompt =
        systemPrompt ||
        `You are Claude, also known as Computer Buddy, a helpful AI assistant in a Discord server. Keep your responses concise and friendly. You can use Discord markdown formatting, your messages will be sent as normal user messages.

Current date and time: ${dateStr} at ${timeStr}

When users share images, you can see and analyze them. Describe what you see and answer any questions about them.

You're built with TypeScript, Discord.js, and the Anthropic SDK. Your source code is available at https://github.com/asktree/disclaude.

When users ask about current events, news, or information that might have changed after your training, use the web_search tool to find current information.
`;

      if (additionalContext) {
        fullSystemPrompt += additionalContext;
      }

      const tools = enableTools
        ? [
            {
              name: "web_search",
              description:
                "Search the web for current information. Use this when users ask about recent events, news, or any information that might need to be up-to-date.",
              input_schema: {
                type: "object" as const,
                properties: {
                  query: {
                    type: "string" as const,
                    description: "The search query",
                  },
                },
                required: ["query"],
              },
            },
          ]
        : undefined;

      const response = await this.anthropic.messages.create({
        model: model || config.anthropic.model,
        max_tokens: 2000,
        system: fullSystemPrompt,
        tools,
        messages: messages.map((msg) => ({
          role:
            msg.role === "user" ||
            msg.role === "assistant" ||
            msg.role === "tool"
              ? msg.role
              : "user",
          content: msg.content,
        })) as Anthropic.MessageParam[],
      });

      // Check if Claude wants to use tools
      const toolUseBlocks = response.content.filter(
        (block) => block.type === "tool_use"
      );
      if (toolUseBlocks.length > 0 && enableTools) {
        // Return tool calls for execution
        return {
          needsTools: true,
          toolCalls: toolUseBlocks,
        };
      }

      // Extract text content from the response
      const textContent = response.content
        .filter((block) => block.type === "text")
        .map((block) => (block as Anthropic.TextBlock).text)
        .join("\n");

      return textContent || "I couldn't generate a response.";
    } catch (error: any) {
      // Check if it's a retryable error (500, 502, 503, 529)
      const isRetryable = error?.status && [500, 502, 503, 529].includes(error.status);
      const isOverloaded = error?.message?.includes('Overloaded');
      const hasRetryHeader = error?.headers?.get?.('x-should-retry') === 'true';

      if ((isRetryable || isOverloaded || hasRetryHeader) && retryCount < 3) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Exponential backoff: 1s, 2s, 4s (max 10s)
        console.log(`⚠️ API error (${error?.status || 'unknown'}), retrying in ${delay}ms... (attempt ${retryCount + 1}/3)`);

        await new Promise(resolve => setTimeout(resolve, delay));

        // Retry the request
        return this.generateResponse(
          messages,
          systemPrompt,
          additionalContext,
          model,
          enableTools,
          retryCount + 1
        );
      }

      console.error("Error generating Claude response:", error);

      // Provide more specific error messages
      if (error?.status === 500 || isOverloaded) {
        return "Sorry, Claude's servers are temporarily overloaded. Please try again in a moment.";
      } else if (error?.status === 429) {
        return "Sorry, we're hitting rate limits. Please wait a moment before trying again.";
      } else if (error?.status >= 500) {
        return "Sorry, there's a temporary issue with Claude's servers. Please try again later.";
      }

      return "Sorry, I encountered an error while processing your request.";
    }
  }

  // Validate image format by checking file signature (magic bytes)
  private validateImageSignature(data: Uint8Array, mediaType: string): boolean {
    if (data.length < 4) return false;

    // Check magic bytes for each format
    switch (mediaType) {
      case 'image/jpeg':
        // JPEG files start with FF D8 FF
        return data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF;

      case 'image/png':
        // PNG files start with 89 50 4E 47 0D 0A 1A 0A
        return data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47;

      case 'image/gif':
        // GIF files start with GIF87a or GIF89a
        return data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 &&
               (data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61);

      case 'image/webp':
        // WebP files have RIFF....WEBP
        if (data.length < 12) return false;
        return data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
               data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50;

      default:
        // For unknown types, accept if it looks like it could be an image
        // (but this is less reliable)
        return true;
    }
  }

  formatDiscordMessages(
    messages: Message[],
    botId: string
  ): Array<{ role: string; content: string }> {
    return messages.map((msg) => ({
      role: msg.author.id === botId ? "assistant" : "user",
      content: msg.content, // Don't include username prefix
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
          text: msg.content, // Don't include username prefix
        });
      }

      // Add image attachments - only formats supported by Claude API
      const supportedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      const imageAttachments = Array.from(msg.attachments.values()).filter(
        (att) => {
          // Check content type first
          if (att.contentType && supportedImageTypes.includes(att.contentType)) {
            return true;
          }
          // Fallback to file extension check for supported formats only
          return att.name?.match(/\.(png|jpg|jpeg|gif|webp)$/i);
        }
      );

      // Log skipped unsupported images
      const allImageAttachments = Array.from(msg.attachments.values()).filter(
        (att) => att.contentType?.startsWith("image/") ||
                 att.name?.match(/\.(png|jpg|jpeg|gif|webp|avif|bmp|tiff)$/i)
      );

      const skippedAttachments = allImageAttachments.filter(
        att => !imageAttachments.includes(att)
      );

      for (const skipped of skippedAttachments) {
        console.log(
          `⚠️ Skipping unsupported image: ${skipped.name} (${skipped.contentType || 'unknown type'})`
        );
      }

      for (const attachment of imageAttachments) {
        try {
          console.log(
            `🖼️ Processing image: ${attachment.name} (${attachment.url})`
          );

          // Fetch the image data
          const response = await fetch(attachment.url);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: Failed to fetch image`);
          }

          const arrayBuffer = await response.arrayBuffer();

          // Check if the image is too large (Claude has a limit)
          const sizeMB = arrayBuffer.byteLength / (1024 * 1024);
          if (sizeMB > 10) {
            console.log(`⚠️ Skipping image ${attachment.name}: Too large (${sizeMB.toFixed(2)}MB > 10MB)`);
            content.push({
              type: "text",
              text: `[Image too large to process: ${attachment.name} (${sizeMB.toFixed(2)}MB)]`,
            });
            continue;
          }

          const base64 = Buffer.from(arrayBuffer).toString("base64");

          // Validate base64 is not empty
          if (!base64 || base64.length === 0) {
            throw new Error('Image data is empty after base64 encoding');
          }

          // Determine media type - must be a supported type
          let mediaType = attachment.contentType;

          // If no content type or unsupported, try to infer from extension
          if (!mediaType || !supportedImageTypes.includes(mediaType)) {
            const ext = attachment.name?.toLowerCase().split('.').pop();
            switch (ext) {
              case 'jpg':
              case 'jpeg':
                mediaType = 'image/jpeg';
                break;
              case 'png':
                mediaType = 'image/png';
                break;
              case 'gif':
                mediaType = 'image/gif';
                break;
              case 'webp':
                mediaType = 'image/webp';
                break;
              default:
                mediaType = 'image/jpeg'; // Default fallback
            }
          }

          // Validate the image by checking magic bytes (file signature)
          const uint8Array = new Uint8Array(arrayBuffer);
          const isValidImage = this.validateImageSignature(uint8Array, mediaType);

          if (!isValidImage) {
            console.log(`⚠️ Skipping image ${attachment.name}: Invalid or corrupted image data`);
            content.push({
              type: "text",
              text: `[Unable to process image: ${attachment.name} - may be corrupted]`,
            });
            continue;
          }

          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64,
            },
          });

          console.log(`✅ Successfully processed image: ${attachment.name} (${(sizeMB).toFixed(2)}MB, ${mediaType})`);

          // Add description of the image if no text content
          if (!msg.content) {
            content.unshift({
              type: "text",
              text: `[Image: ${attachment.name}]`,
            });
          }
        } catch (error) {
          console.error(`❌ Failed to process image ${attachment.name}:`, error);
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
          content:
            content.length === 1 && typeof content[0].text === "string"
              ? content[0].text
              : content,
        });
      }
    }

    return formattedMessages;
  }
}
