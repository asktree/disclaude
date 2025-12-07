import { ToolHandler, ToolCall, ToolContext, ToolResult } from "../types/tool.types";
import { ToolDefinition } from "../types";

export class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  /**
   * Register a tool handler
   */
  register(handler: ToolHandler): void {
    if (this.handlers.has(handler.name)) {
      console.warn(`⚠️ Tool handler "${handler.name}" is already registered. Overwriting.`);
    }
    this.handlers.set(handler.name, handler);
    console.log(`✅ Registered tool handler: ${handler.name}`);
  }

  /**
   * Execute a tool call
   */
  async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    const handler = this.handlers.get(toolCall.name);

    if (!handler) {
      console.error(`❌ Unknown tool: ${toolCall.name}`);
      return {
        content: `Error: Unknown tool "${toolCall.name}"`,
        error: true,
      };
    }

    // Validate input
    if (!handler.validateInput(toolCall.input)) {
      console.error(`❌ Invalid input for tool: ${toolCall.name}`);
      return {
        content: `Error: Invalid input for tool "${toolCall.name}"`,
        error: true,
      };
    }

    try {
      console.log(`🔧 Executing tool: ${toolCall.name}`);
      const result = await handler.execute(toolCall.input, context);
      console.log(`✅ Tool execution completed: ${toolCall.name}`);
      return result;
    } catch (error) {
      console.error(`❌ Tool execution failed for ${toolCall.name}:`, error);
      return {
        content: `Error executing tool "${toolCall.name}": ${error instanceof Error ? error.message : String(error)}`,
        error: true,
      };
    }
  }

  /**
   * Get tool definitions for Claude API
   */
  getToolDefinitions(): ToolDefinition[] {
    return (
      Array.from(this.handlers.values())
        // Filter out memory since it's declared as a native Anthropic tool
        .filter((handler) => handler.name !== "memory")
        .map((handler) => ({
          name: handler.name,
          description: handler.description,
          input_schema: handler.input_schema,
        }))
    );
  }

  /**
   * Check if a tool exists
   */
  hasHandler(toolName: string): boolean {
    return this.handlers.has(toolName);
  }

  /**
   * Get all registered tool names
   */
  getRegisteredTools(): string[] {
    return Array.from(this.handlers.keys());
  }
}
