/**
 * Type definitions for the Disclaude Discord bot
 */

import { Attachment } from 'discord.js';

// Claude API related types
export interface ClaudeMessage {
  role: string; // Allow any role string for flexibility
  content: string | ClaudeContent[] | any[]; // Allow broader content types
}

export type ClaudeContent =
  | ClaudeTextContent
  | ClaudeImageContent;

export interface ClaudeTextContent {
  type: 'text';
  text: string;
}

export interface ClaudeImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | string; // Allow specific types but also general string
    data: string;
  };
}

export interface ClaudeToolCall {
  id: string;
  name: string;
  input: Record<string, any>; // Use any for more flexibility with tool inputs
}

export interface ClaudeToolResult {
  tool_use_id: string;
  content: string | ClaudeContent | ClaudeContent[];
}

export type ClaudeResponse =
  | string
  | { needsTools: true; toolCalls: ClaudeToolCall[] }
  | { text: string; files: GeneratedFile[] };

export interface GeneratedFile {
  name: string;
  content: string;
  mimeType?: string;
}

// URL Fetcher types
export interface FetchedUrl {
  url: string;
  content: string | ClaudeContent;
  title?: string;
  isImage?: boolean;
}

export interface UrlCacheEntry {
  content: string | ClaudeContent;
  timestamp: number;
  isImage?: boolean;
}

// Tool execution types
export interface ToolContext {
  originalMessage?: any; // Discord.Message - avoiding circular dependency
  botId: string;
}

export interface ReadSourceCodeInput {
  files?: string[];
}

export interface FetchUrlInput {
  url: string;
}

export interface ReadDiscordMessagesInput {
  channel_id?: string;
  limit?: number;
  before_message_id?: string;
  after_message_id?: string;
  around_message_id?: string;
}

// GitHub API types
export interface GitHubRepoItem {
  name: string;
  path: string;
  type: string;
  content?: string;
  encoding?: string;
}

// Channel fetch result types
export interface ChannelFetchResult {
  channelName: string;
  channelId: string;
  content: string;
}

export interface ChannelFetchError {
  channelId: string;
  error: string;
}

// Claude content block types (from API responses)
export interface ClaudeTextBlock {
  type: 'text';
  text: string;
  citations?: Citation[];
}

export interface Citation {
  url: string;
  title?: string;
}

export interface ClaudeToolUseBlock {
  type: 'tool_use' | 'server_tool_use';
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

export interface ClaudeWebSearchResult {
  type: 'web_search_tool_result';
  content: WebSearchItem[];
}

export interface WebSearchItem {
  type: 'web_search_result';
  url?: string;
  title?: string;
  snippet?: string;
  content?: string;
}

export interface ClaudeCodeExecutionResult {
  type: 'text_editor_code_execution_tool_result' | 'bash_code_execution_tool_result';
  tool_use_id?: string;
  output?: string;
  error?: string;
  files?: GeneratedFile[];
}

// Discord attachment with proper types
export interface ProcessableAttachment extends Omit<Attachment, 'contentType'> {
  name: string;
  url: string;
  contentType?: string | null;
}