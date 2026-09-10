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

// Claude Models and Generation
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
export const COMMIT_SUMMARY_MODEL = "claude-haiku-4-5"; // Cheap model for startup commit summaries
export const CLAUDE_MAX_OUTPUT_TOKENS = 8192; // Caps thinking + visible reply together
export const CLAUDE_EFFORT = "medium" as const; // low | medium | high | xhigh | max

// API Retry Configuration
export const ANTHROPIC_MAX_RETRIES = 3;
export const ANTHROPIC_RETRY_DELAY_MS = 1000;
export const ANTHROPIC_MAX_RETRY_DELAY_MS = 10000;

// Code Execution Output
export const MAX_CODE_OUTPUT_LENGTH = 1500;

// Discord Message Search (preview endpoint, opened to bots August 2025)
export const DISCORD_SEARCH_DEFAULT_LIMIT = 10;
export const DISCORD_SEARCH_MAX_LIMIT = 25; // Discord API hard limit
export const DISCORD_SEARCH_MAX_OFFSET = 9975; // Discord API hard limit
export const DISCORD_SEARCH_INDEX_RETRIES = 2; // Retries when the index returns 202
export const DISCORD_SEARCH_INDEX_RETRY_MS = 3000;

// Member Lookup
export const FIND_USER_MAX_RESULTS = 10;

// Tweet Embeds (fxtwitter-style link expansion)
export const TWEET_API_BASE_URL = "https://api.fxtwitter.com";
export const TWEET_FETCH_TIMEOUT_MS = 10000;
export const TWEET_CACHE_TTL_MS = 10 * 60 * 1000; // Cache fetched posts (and coalesce in-flight fetches)
export const MAX_TWEETS_PER_MESSAGE = 3;
export const TWEET_USER_RATE_LIMIT = 5; // Expansions per user per window
export const TWEET_USER_RATE_WINDOW_MS = 60 * 1000;
export const TWEET_TEXT_MAX_LENGTH = 1800; // Leave headroom in the 4096-char embed description
export const TWEET_QUOTE_TEXT_MAX_LENGTH = 800; // Field values cap at 1024
export const TWEET_EMBED_COLOR = 0x1d9bf0; // Twitter/X blue
export const TWEET_MAX_GALLERY_IMAGES = 4; // Discord merges up to 4 same-URL embeds into a gallery
export const TWEET_MAX_VIDEO_LINKS = 2; // Raw mp4 links posted in message content
export const DISCORD_MAX_EMBEDS_PER_MESSAGE = 10;
export const DISCORD_MAX_TOTAL_EMBED_LENGTH = 6000; // Sum of all text across all embeds in one message
// Reacting with any of these on a bot tweet embed removes it (original poster or a mod only).
// Compared with variation selectors stripped, so 🗑 and 🗑️ both match.
export const TWEET_DELETE_EMOJIS = ["🗑️", "❌", "🚫", "🗑"];
// Shown under each embed so the poster knows how to remove it; also doubles as
// the marker that identifies our tweet embeds if tracking data is lost.
export const TWEET_REMOVAL_HINT = "react 🗑️ to remove this embed";
export const TWEET_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // How long to remember source -> embed links
