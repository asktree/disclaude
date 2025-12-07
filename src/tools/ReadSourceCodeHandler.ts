import { Message } from "discord.js";
import { ToolHandler, ToolInput, ToolContext, ToolResult, ToolSchema } from "../types/tool.types";
import { RepoReader } from "../services/repoReader";

export class ReadSourceCodeHandler implements ToolHandler {
  name = "read_source_code";
  description = "Read source code from the bot's GitHub repository";
  input_schema: ToolSchema = {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "string",
        },
        description: "List of file paths to read. If empty, returns the repository structure",
      },
    },
    additionalProperties: false,
  };

  private repoReader: RepoReader;

  constructor(repoReader: RepoReader) {
    this.repoReader = repoReader;
  }

  validateInput(input: ToolInput): boolean {
    // Files can be undefined, null, or an array
    if (input.files === undefined || input.files === null) {
      return true;
    }
    if (!Array.isArray(input.files)) {
      return false;
    }
    // Each file should be a string
    return input.files.every((file) => typeof file === "string");
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let statusMessage: Message | undefined;
    const originalMessage = context.message;

    try {
      const files = input.files || [];
      console.log(
        `   📖 Reading source code: ${
          files.length === 0 ? "repository structure" : files.join(", ")
        }`,
      );

      // Send initial status message to Discord
      if (originalMessage && "send" in originalMessage.channel) {
        if (files.length === 0) {
          statusMessage = await originalMessage.channel.send(
            `📂 *Getting repository structure...*`,
          );
        } else {
          statusMessage = await originalMessage.channel.send(
            `📖 *Reading ${files.length} source file${files.length !== 1 ? "s" : ""}...*`,
          );
        }
      }

      // Execute the file reading
      let sourceContent = "";
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

      // Edit the status message to show completion
      if (statusMessage) {
        if (files.length === 0) {
          await statusMessage.edit(`✅ *Repository structure loaded*`);
        } else {
          await statusMessage.edit(
            `✅ *Loaded ${files.length} file${files.length !== 1 ? "s" : ""}*`,
          );
        }
      }

      return {
        content: sourceContent,
      };
    } catch (error) {
      console.error("   ❌ Error reading source code:", error);

      // Edit status message to show error
      if (statusMessage) {
        await statusMessage.edit(`⚠️ *Failed to read source code: ${error}*`);
      } else if (originalMessage && "send" in originalMessage.channel) {
        await originalMessage.channel.send(`⚠️ *Failed to read source code: ${error}*`);
      }

      return {
        content: `Error reading source code: ${error}`,
        error: true,
      };
    }
  }
}
