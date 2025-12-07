import { ToolHandler, ToolInput, ToolContext, ToolResult, ToolSchema } from "../types/tool.types";
import { config } from "../config";
import fs from "fs/promises";
import path from "path";

interface MemoryInput {
  command: "view" | "create" | "str_replace" | "insert" | "delete" | "rename";
  path?: string;
  content?: string;
  old_str?: string;
  new_str?: string;
  new_path?: string;
  view_range?: [number, number];
}

export class MemoryHandler implements ToolHandler {
  name = "memory";
  description = "Persistent memory storage for maintaining context across conversations";
  input_schema: ToolSchema = {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["view", "create", "str_replace", "insert", "delete", "rename"],
        description: "The memory operation to perform",
      },
      path: {
        type: "string",
        description: "Path to the memory file or directory",
      },
      content: {
        type: "string",
        description: "Content for create or insert operations",
      },
      old_str: {
        type: "string",
        description: "String to replace (for str_replace)",
      },
      new_str: {
        type: "string",
        description: "Replacement string (for str_replace)",
      },
      new_path: {
        type: "string",
        description: "New path (for rename)",
      },
      view_range: {
        type: "array",
        items: { type: "integer" },
        description: "Line range to view [start, end]",
      },
    },
    required: ["command"],
    additionalProperties: false,
  };

  validateInput(input: ToolInput): boolean {
    const typed = input as MemoryInput;
    return typeof typed.command === "string";
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    const {
      command,
      path: memPath,
      content,
      old_str,
      new_str,
      new_path,
      view_range,
    } = input as MemoryInput;

    // Ensure memory directory exists
    const baseDir = config.memory.dataDir;

    // Sanitize path to prevent directory traversal
    const safePath = memPath ? path.join(baseDir, memPath.replace(/^\/+/, "")) : baseDir;

    // Ensure the path stays within the memory directory
    if (!safePath.startsWith(path.resolve(baseDir))) {
      return {
        content: "Error: Invalid path - attempting to access files outside memory directory",
        error: true,
      };
    }

    console.log(`   🧠 Memory ${command}: ${safePath}`);

    try {
      switch (command) {
        case "view": {
          // Check if path is a directory or file
          const stats = await fs.stat(safePath).catch(() => null);

          if (!stats) {
            return { content: "Path does not exist" };
          }

          if (stats.isDirectory()) {
            // List directory contents
            const files = await fs.readdir(safePath);
            const details = await Promise.all(
              files.map(async (file) => {
                const filePath = path.join(safePath, file);
                const fileStat = await fs.stat(filePath);
                return `${file}${fileStat.isDirectory() ? "/" : ""}`;
              }),
            );
            return {
              content:
                details.length > 0
                  ? `Directory contents:\n${details.join("\n")}`
                  : "Directory is empty",
            };
          } else {
            // Read file contents
            const fileContent = await fs.readFile(safePath, "utf-8");

            // Handle view_range if specified
            if (view_range && Array.isArray(view_range) && view_range.length === 2) {
              const lines = fileContent.split("\n");
              const [start, end] = view_range;
              const selectedLines = lines.slice(start - 1, end).join("\n");
              return { content: selectedLines };
            }

            return { content: fileContent };
          }
        }

        case "create": {
          if (!memPath || !content) {
            return { content: "Error: path and content are required for create", error: true };
          }

          // Create directory if it doesn't exist
          await fs.mkdir(path.dirname(safePath), { recursive: true });

          // Check if file already exists
          const exists = await fs
            .access(safePath)
            .then(() => true)
            .catch(() => false);
          if (exists) {
            return {
              content: "Error: File already exists. Use str_replace or insert to modify.",
              error: true,
            };
          }

          await fs.writeFile(safePath, content, "utf-8");
          return { content: `Created: ${memPath}` };
        }

        case "str_replace": {
          if (!memPath || !old_str || new_str === undefined) {
            return {
              content: "Error: path, old_str, and new_str are required for str_replace",
              error: true,
            };
          }

          const fileContent = await fs.readFile(safePath, "utf-8");

          if (!fileContent.includes(old_str)) {
            return { content: "Error: old_str not found in file", error: true };
          }

          const newContent = fileContent.replace(old_str, new_str);
          await fs.writeFile(safePath, newContent, "utf-8");

          return { content: `Replaced in ${memPath}` };
        }

        case "insert": {
          if (!memPath || !content) {
            return { content: "Error: path and content are required for insert", error: true };
          }

          // Read existing content
          const existingContent = await fs.readFile(safePath, "utf-8").catch(() => "");

          // Append new content
          const newContent = existingContent + (existingContent ? "\n" : "") + content;
          await fs.writeFile(safePath, newContent, "utf-8");

          return { content: `Appended to ${memPath}` };
        }

        case "delete": {
          if (!memPath) {
            return { content: "Error: path is required for delete", error: true };
          }

          const stats = await fs.stat(safePath).catch(() => null);
          if (!stats) {
            return { content: "Error: Path does not exist", error: true };
          }

          if (stats.isDirectory()) {
            await fs.rmdir(safePath, { recursive: true });
          } else {
            await fs.unlink(safePath);
          }

          return { content: `Deleted: ${memPath}` };
        }

        case "rename": {
          if (!memPath || !new_path) {
            return { content: "Error: path and new_path are required for rename", error: true };
          }

          const safeNewPath = path.join(baseDir, new_path.replace(/^\/+/, ""));

          // Ensure new path is also within memory directory
          if (!safeNewPath.startsWith(path.resolve(baseDir))) {
            return { content: "Error: Invalid new_path", error: true };
          }

          await fs.rename(safePath, safeNewPath);

          return { content: `Renamed ${memPath} to ${new_path}` };
        }

        default:
          return { content: `Unknown command: ${command}`, error: true };
      }
    } catch (error) {
      console.error("   ❌ Memory operation error:", error);
      return {
        content: `Memory operation failed: ${error instanceof Error ? error.message : String(error)}`,
        error: true,
      };
    }
  }
}
