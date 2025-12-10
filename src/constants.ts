/**
 * Application-wide constants
 * All magic numbers and configuration values should be defined here
 */

// Discord API Limits
export const DISCORD_MAX_MESSAGE_LENGTH = 2000;
export const DISCORD_MAX_EMBED_DESCRIPTION_LENGTH = 4096;
export const DISCORD_MAX_EMBED_FIELD_VALUE_LENGTH = 1024;

// Context Management
export const DEFAULT_MAX_CONTEXT_MESSAGES = 100;
export const DEFAULT_MAX_CONTEXT_TOKENS = 8000;
export const MIN_PRESERVED_MESSAGES = 10; // When trimming context

// Channel and Message Fetching
export const MAX_CHANNEL_FETCH_LIMIT = 20;
export const MAX_DISCORD_MESSAGES_LIMIT = 100;
export const DEFAULT_DISCORD_MESSAGES_LIMIT = 50;

// Image Processing
export const MAX_IMAGE_SIZE_MB = 5; // Claude API limit is 5MB for base64-encoded images
export const IMAGE_ESTIMATED_TOKENS = 1500; // Claude's approximate token count for images

// URL Fetching
export const URL_FETCH_TIMEOUT_MS = 10000;
export const MAX_URL_CONTENT_LENGTH = 5000;
export const MAX_RECENT_MESSAGES_FOR_URL_SEARCH = 5;
export const URL_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const URL_CACHE_MAX_SIZE_MB = 50;
export const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Tool Execution
export const MAX_TOOL_ROUNDS = 5;
export const TOOL_STATUS_MESSAGE_DELAY_MS = 1000;

// Git Integration
export const GIT_STARTUP_CHANNEL_NAME = "computer-buddy-zone";
export const GIT_DIFF_LINES_PER_FILE = 100;

// Token Counting
export const ASSISTANT_MESSAGE_PREFIX_TOKENS = 5;
export const TOOL_USE_OVERHEAD_TOKENS = 10;

// API Retry Configuration
export const ANTHROPIC_MAX_RETRIES = 3;
export const ANTHROPIC_RETRY_DELAY_MS = 1000;
export const ANTHROPIC_MAX_RETRY_DELAY_MS = 10000;

// Code Execution Output
export const MAX_CODE_OUTPUT_LENGTH = 1500;
