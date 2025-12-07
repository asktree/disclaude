import { Message } from "discord.js";
import { ToolHandler, ToolInput, ToolContext, ToolResult, ToolSchema } from "../types/tool.types";
import { UrlFetcher } from "../services/urlFetcher";

export class FetchUrlHandler implements ToolHandler {
  name = "fetch_url";
  description = "Fetch content from a URL (web page or image)";
  input_schema: ToolSchema = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch content from",
      },
    },
    required: ["url"],
    additionalProperties: false,
  };

  private urlFetcher: UrlFetcher;

  constructor(urlFetcher: UrlFetcher) {
    this.urlFetcher = urlFetcher;
  }

  validateInput(input: ToolInput): boolean {
    return typeof input.url === "string" && input.url.length > 0;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let statusMessage: Message | undefined;
    const originalMessage = context.message;

    try {
      const url = input.url;
      console.log(`   🔗 Fetching URL: ${url}`);

      // Send initial status message to Discord
      if (originalMessage && "send" in originalMessage.channel) {
        statusMessage = await originalMessage.channel.send(`🔗 *Fetching content from ${url}...*`);
      }

      // Fetch the URL content
      const fetchedUrls = await this.urlFetcher.fetchAllUrls([url]);
      let toolContent: any;

      if (fetchedUrls.length > 0 && fetchedUrls[0].content) {
        const fetched = fetchedUrls[0];

        // Check if it's an image
        if (fetched.isImage) {
          // For images, pass the content directly as it's already formatted for Claude
          toolContent = fetched.content;
          console.log(`   ✅ Successfully fetched image from ${url}`);

          // Edit the status message to show completion
          if (statusMessage) {
            await statusMessage.edit(`✅ *Fetched image from ${url}*`);
          }
        } else {
          // For text content, format it as before
          toolContent = `URL: ${fetched.url}\nTitle: ${
            fetched.title || "N/A"
          }\n\nContent:\n${fetched.content}`;
          console.log(`   ✅ Successfully fetched content from ${url}`);

          // Edit the status message to show completion
          if (statusMessage) {
            await statusMessage.edit(`✅ *Fetched content from ${url}*`);
          }
        }
      } else {
        toolContent = `Failed to fetch content from ${url}`;
        console.log(`   ❌ Failed to fetch content from ${url}`);

        // Edit status message to show failure
        if (statusMessage) {
          await statusMessage.edit(`⚠️ *Failed to fetch content from ${url}*`);
        }
      }

      return {
        content: toolContent,
      };
    } catch (error) {
      console.error(`   ❌ Error fetching URL:`, error);

      // Edit status message to show error
      if (statusMessage) {
        await statusMessage.edit(`⚠️ *Failed to fetch URL: ${error}*`);
      } else if (originalMessage && "send" in originalMessage.channel) {
        await originalMessage.channel.send(`⚠️ *Failed to fetch URL: ${error}*`);
      }

      return {
        content: `Error fetching URL: ${error}`,
        error: true,
      };
    }
  }
}
