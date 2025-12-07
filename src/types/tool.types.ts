import { Message } from "discord.js";

export interface ToolContext {
  message: Message;
  botId: string;
}

export interface ToolResult {
  content: string;
  error?: boolean;
}

export interface ToolInput {
  [key: string]: any;
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolHandler {
  name: string;
  description: string;
  input_schema: ToolSchema;

  execute(input: ToolInput, context: ToolContext): Promise<ToolResult>;
  validateInput(input: ToolInput): boolean;
}

export interface ToolCall {
  id: string;
  type: "tool_use";
  name: string;
  input: ToolInput;
}
