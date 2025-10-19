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
          retryCount > 0 ? ` [Retry ${retryCount}]` : ""
        }`
      );

      // Build the system prompt with additional context if provided
      const currentDate = new Date();
      const dateStr = currentDate.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const timeStr = currentDate.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
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

      // Use Anthropic's native web search tool if enabled
      const tools = enableTools
        ? [
            {
              type: "web_search_20250305" as const,
              name: "web_search" as const,
              max_uses: 5, // Allow up to 5 searches per request
            },
            {
              type: "custom" as const,
              name: "read_source_code",
              description:
                "Read your own source code files from the GitHub repository. Use this when users ask about how you work, your implementation, configuration, or any technical details about your code.",
              input_schema: {
                type: "object" as const,
                properties: {
                  files: {
                    type: "array" as const,
                    items: {
                      type: "string" as const,
                    },
                    description:
                      "Array of file paths to read (e.g., ['src/index.ts', 'src/services/claude.ts']). Leave empty to get repository structure.",
                  },
                },
                required: [],
              },
            },
            {
              type: "custom" as const,
              name: "fetch_url",
              description:
                "Fetch and read content from a URL. Use this when you need to access web content that was mentioned in the conversation or when you need to look up specific information from a website.",
              input_schema: {
                type: "object" as const,
                properties: {
                  url: {
                    type: "string" as const,
                    description: "The URL to fetch content from",
                  },
                },
                required: ["url"],
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
            msg.role === "user" || msg.role === "assistant" ? msg.role : "user",
          content: msg.content,
        })) as Anthropic.MessageParam[],
      });

      // Log all content blocks for debugging
      console.log(
        `📊 Response blocks: ${response.content.map((b) => b.type).join(", ")}`
      );

      // Log each text block individually
      const textBlocks = response.content.filter(
        (block) => block.type === "text"
      );
      if (textBlocks.length > 0) {
        console.log(`📝 Found ${textBlocks.length} text blocks:`);
        let totalCitations = 0;

        textBlocks.forEach((block, index) => {
          const textBlock = block as any;
          console.log(
            `\n  [Text Block ${index + 1}] (length: ${textBlock.text.length}):`
          );
          console.log(
            `  Preview: "${textBlock.text.substring(0, 100)}${
              textBlock.text.length > 100 ? "..." : ""
            }"`
          );

          // Check if this block has citations field
          if (textBlock.citations && Array.isArray(textBlock.citations)) {
            console.log(`  📎 Has ${textBlock.citations.length} citation(s):`);
            textBlock.citations.forEach((citation: any, i: number) => {
              console.log(
                `     ${i + 1}. "${citation.title || "No title"}" - ${
                  citation.url
                }`
              );
            });
            totalCitations += textBlock.citations.length;
          }
        });

        console.log(`\n📊 Total citations found: ${totalCitations}`);
      }

      // Log web search usage if present
      const webSearchResults = response.content.filter(
        (block: any) => block.type === "web_search_tool_result"
      );

      if (webSearchResults.length > 0) {
        let searchQuery = "";
        let resultCount = 0;
        const urls: string[] = [];

        // Extract search query from tool use blocks
        const toolUseBlocks = response.content.filter(
          (block: any) =>
            block.type === "server_tool_use" && block.name === "web_search"
        );
        if (toolUseBlocks.length > 0) {
          searchQuery =
            (toolUseBlocks[0] as any).input?.query || "unknown query";
        }

        // Count results and collect URLs
        for (const resultBlock of webSearchResults) {
          const results = (resultBlock as any).content || [];
          for (const result of results) {
            if (result.type === "web_search_result") {
              resultCount++;
              if (result.url) {
                urls.push(result.url);
              }
            }
          }
        }

        console.log(
          `🔍 Web search occurred: "${searchQuery}" - found ${resultCount} results`
        );
        console.log(
          `   URLs found: ${urls.slice(0, 3).join(", ")}${
            urls.length > 3 ? "..." : ""
          }`
        );

        // Log first result structure for debugging
        const firstResult = ((webSearchResults[0] as any).content || [])[0];
        if (firstResult) {
          console.log(`   Sample result structure:`, {
            type: firstResult.type,
            title: firstResult.title?.substring(0, 50),
            url: firstResult.url,
            hasSnippet: !!firstResult.snippet,
            hasContent: !!firstResult.content,
            hasEncryptedContent: !!firstResult.encrypted_content,
            otherFields: Object.keys(firstResult).filter(
              (k) =>
                ![
                  "type",
                  "title",
                  "url",
                  "snippet",
                  "content",
                  "encrypted_content",
                ].includes(k)
            ),
          });
        }
      }

      // Check if Claude wants to use custom tools (not web_search which was already executed)
      const toolUseBlocks = response.content.filter(
        (block) => block.type === "tool_use"
      );

      // Filter out web_search since it's already been handled
      const customToolBlocks = toolUseBlocks.filter(
        (block: any) => block.name !== "web_search"
      );

      if (customToolBlocks.length > 0 && enableTools) {
        // Return custom tool calls for execution
        return {
          needsTools: true,
          toolCalls: customToolBlocks,
        };
      }

      // Extract text content with inline citations
      let textContent = "";
      const urlToCitationNum = new Map<string, number>(); // Maps URL to citation number
      let citationCounter = 1;

      for (const block of response.content) {
        if (block.type === "text") {
          const textBlock = block as any;
          let blockText = textBlock.text;

          // If this block has citations, append them inline
          if (textBlock.citations && Array.isArray(textBlock.citations)) {
            // First, deduplicate citations by URL within this block
            const uniqueCitations = new Map<string, any>();
            for (const citation of textBlock.citations) {
              if (citation.url && !uniqueCitations.has(citation.url)) {
                uniqueCitations.set(citation.url, citation);
              }
            }

            // Build citation links
            const citationLinks: string[] = [];
            for (const citation of uniqueCitations.values()) {
              let citationNum: number;

              // Check if we've already seen this URL
              if (urlToCitationNum.has(citation.url)) {
                citationNum = urlToCitationNum.get(citation.url)!;
              } else {
                citationNum = citationCounter++;
                urlToCitationNum.set(citation.url, citationNum);
              }

              // Add citation link with <> to prevent embeds
              citationLinks.push(`[${citationNum}](${citation.url})`);
            }

            // Append all citations for this block grouped together
            if (citationLinks.length > 0) {
              blockText += ` (${citationLinks.join(", ")})`;
            }
          }

          textContent += (textContent ? " " : "") + blockText;
        }
      }

      return textContent || "I couldn't generate a response.";
    } catch (error: any) {
      // Check if it's a retryable error (500, 502, 503, 529)
      const isRetryable =
        error?.status && [500, 502, 503, 529].includes(error.status);
      const isOverloaded = error?.message?.includes("Overloaded");
      const hasRetryHeader = error?.headers?.get?.("x-should-retry") === "true";

      if ((isRetryable || isOverloaded || hasRetryHeader) && retryCount < 3) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Exponential backoff: 1s, 2s, 4s (max 10s)
        console.log(
          `⚠️ API error (${
            error?.status || "unknown"
          }), retrying in ${delay}ms... (attempt ${retryCount + 1}/3)`
        );

        await new Promise((resolve) => setTimeout(resolve, delay));

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
      case "image/jpeg":
        // JPEG files start with FF D8 FF
        return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;

      case "image/png":
        // PNG files start with 89 50 4E 47 0D 0A 1A 0A
        return (
          data[0] === 0x89 &&
          data[1] === 0x50 &&
          data[2] === 0x4e &&
          data[3] === 0x47
        );

      case "image/gif":
        // GIF files start with GIF87a or GIF89a
        return (
          data[0] === 0x47 &&
          data[1] === 0x49 &&
          data[2] === 0x46 &&
          data[3] === 0x38 &&
          (data[4] === 0x37 || data[4] === 0x39) &&
          data[5] === 0x61
        );

      case "image/webp":
        // WebP files have RIFF....WEBP
        if (data.length < 12) return false;
        return (
          data[0] === 0x52 &&
          data[1] === 0x49 &&
          data[2] === 0x46 &&
          data[3] === 0x46 &&
          data[8] === 0x57 &&
          data[9] === 0x45 &&
          data[10] === 0x42 &&
          data[11] === 0x50
        );

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
      const supportedImageTypes = [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
      ];
      const imageAttachments = Array.from(msg.attachments.values()).filter(
        (att) => {
          // Check content type first
          if (
            att.contentType &&
            supportedImageTypes.includes(att.contentType)
          ) {
            return true;
          }
          // Fallback to file extension check for supported formats only
          return att.name?.match(/\.(png|jpg|jpeg|gif|webp)$/i);
        }
      );

      // Log skipped unsupported images
      const allImageAttachments = Array.from(msg.attachments.values()).filter(
        (att) =>
          att.contentType?.startsWith("image/") ||
          att.name?.match(/\.(png|jpg|jpeg|gif|webp|avif|bmp|tiff)$/i)
      );

      const skippedAttachments = allImageAttachments.filter(
        (att) => !imageAttachments.includes(att)
      );

      for (const skipped of skippedAttachments) {
        console.log(
          `⚠️ Skipping unsupported image: ${skipped.name} (${
            skipped.contentType || "unknown type"
          })`
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
            console.log(
              `⚠️ Skipping image ${
                attachment.name
              }: Too large (${sizeMB.toFixed(2)}MB > 10MB)`
            );
            content.push({
              type: "text",
              text: `[Image too large to process: ${
                attachment.name
              } (${sizeMB.toFixed(2)}MB)]`,
            });
            continue;
          }

          const base64 = Buffer.from(arrayBuffer).toString("base64");

          // Validate base64 is not empty
          if (!base64 || base64.length === 0) {
            throw new Error("Image data is empty after base64 encoding");
          }

          // Determine media type - must be a supported type
          let mediaType = attachment.contentType;

          // If no content type or unsupported, try to infer from extension
          if (!mediaType || !supportedImageTypes.includes(mediaType)) {
            const ext = attachment.name?.toLowerCase().split(".").pop();
            switch (ext) {
              case "jpg":
              case "jpeg":
                mediaType = "image/jpeg";
                break;
              case "png":
                mediaType = "image/png";
                break;
              case "gif":
                mediaType = "image/gif";
                break;
              case "webp":
                mediaType = "image/webp";
                break;
              default:
                mediaType = "image/jpeg"; // Default fallback
            }
          }

          // Validate the image by checking magic bytes (file signature)
          const uint8Array = new Uint8Array(arrayBuffer);
          const isValidImage = this.validateImageSignature(
            uint8Array,
            mediaType
          );

          if (!isValidImage) {
            console.log(
              `⚠️ Skipping image ${attachment.name}: Invalid or corrupted image data`
            );
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

          console.log(
            `✅ Successfully processed image: ${
              attachment.name
            } (${sizeMB.toFixed(2)}MB, ${mediaType})`
          );

          // Add description of the image if no text content
          if (!msg.content) {
            content.unshift({
              type: "text",
              text: `[Image: ${attachment.name}]`,
            });
          }
        } catch (error) {
          console.error(
            `❌ Failed to process image ${attachment.name}:`,
            error
          );
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
