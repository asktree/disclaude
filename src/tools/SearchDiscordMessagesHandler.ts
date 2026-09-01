import { Message, TextChannel, Guild } from "discord.js";
import { ToolHandler, ToolInput, ToolContext, ToolResult, ToolSchema } from "../types/tool.types";
import { buildDiscordMessageRepresentation } from "../utils/messageFormatter";
import { findChannelByNameOrId, isSnowflake } from "../utils/discordNames";
import {
  DISCORD_SEARCH_DEFAULT_LIMIT,
  DISCORD_SEARCH_MAX_LIMIT,
  DISCORD_SEARCH_MAX_OFFSET,
  DISCORD_SEARCH_INDEX_RETRIES,
  DISCORD_SEARCH_INDEX_RETRY_MS,
} from "../constants";

const HAS_VALUES = ["link", "embed", "file", "image", "video", "sound", "sticker", "poll"];

interface SearchDiscordMessagesInput {
  query?: string;
  channel?: string;
  author_id?: string;
  has?: string;
  pinned?: boolean;
  sort_by?: "relevance" | "timestamp";
  limit?: number;
  offset?: number;
}

interface SearchApiResponse {
  messages?: unknown[];
  total_results?: number;
  doing_deep_historical_index?: boolean;
  retry_after?: number;
}

/**
 * Searches messages across a guild using Discord's search endpoint
 * (GET /guilds/{guild.id}/messages/search). This endpoint opened to bots in
 * August 2025 and is still marked "preview" by Discord, so the handler is
 * defensive about response shape and 202 "index not ready" responses.
 */
export class SearchDiscordMessagesHandler implements ToolHandler {
  name = "search_discord_messages";
  description =
    "Search messages across the whole Discord server by text, author, channel, or attachment type. Use this to find past conversations when you don't know which channel or when they are older than recent history. Results include message IDs you can pass to read_discord_messages (around_message_id) for surrounding context. Returns real messages only - never invent results.";
  input_schema: ToolSchema = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text to search for (max 1024 characters). Optional if other filters are set.",
      },
      channel: {
        type: "string",
        description:
          "Restrict the search to one channel, by name (e.g. 'general') or ID. Searches all channels if omitted.",
      },
      author_id: {
        type: "string",
        description:
          "Only return messages from this user ID. Use find_discord_user to look up an ID by name.",
      },
      has: {
        type: "string",
        enum: HAS_VALUES,
        description: "Only return messages containing this kind of content.",
      },
      pinned: {
        type: "boolean",
        description: "Only return pinned (true) or unpinned (false) messages.",
      },
      sort_by: {
        type: "string",
        enum: ["relevance", "timestamp"],
        description: "Sort order (default: relevance). Use timestamp for newest-first.",
      },
      limit: {
        type: "integer",
        description: `Number of results to return (default: ${DISCORD_SEARCH_DEFAULT_LIMIT}, max: ${DISCORD_SEARCH_MAX_LIMIT})`,
      },
      offset: {
        type: "integer",
        description: "Skip this many results for paging through more matches.",
      },
    },
    additionalProperties: false,
  };

  validateInput(input: ToolInput): boolean {
    const typed = input as SearchDiscordMessagesInput;

    const optionalStrings: (keyof SearchDiscordMessagesInput)[] = [
      "query",
      "channel",
      "author_id",
      "has",
      "sort_by",
    ];
    for (const field of optionalStrings) {
      if (typed[field] !== undefined && typeof typed[field] !== "string") return false;
    }
    if (typed.pinned !== undefined && typeof typed.pinned !== "boolean") return false;
    if (typed.limit !== undefined && typeof typed.limit !== "number") return false;
    if (typed.offset !== undefined && typeof typed.offset !== "number") return false;
    if (typed.has !== undefined && !HAS_VALUES.includes(typed.has)) return false;
    if (typed.sort_by !== undefined && !["relevance", "timestamp"].includes(typed.sort_by)) {
      return false;
    }
    if (typed.author_id !== undefined && !isSnowflake(typed.author_id)) return false;

    // Need at least one filter or the search is meaningless
    const hasFilter =
      (typed.query && typed.query.trim().length > 0) ||
      typed.author_id !== undefined ||
      typed.has !== undefined ||
      typed.pinned !== undefined;
    return Boolean(hasFilter);
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let statusMessage: Message | undefined;
    const originalMessage = context.message;

    try {
      const {
        query,
        channel,
        author_id,
        has,
        pinned,
        sort_by = "relevance",
        limit = DISCORD_SEARCH_DEFAULT_LIMIT,
        offset = 0,
      } = input as SearchDiscordMessagesInput;

      const guild = originalMessage?.guild;
      if (!guild) {
        throw new Error("Search only works inside a server, not in DMs");
      }

      // Resolve an optional channel name/ID filter
      let channelFilter: { id: string; name: string } | undefined;
      if (channel) {
        const found = findChannelByNameOrId(guild, channel);
        if (!found) {
          throw new Error(
            `Channel "${channel}" not found. Use list_discord_channels to see available channels.`,
          );
        }
        channelFilter = { id: found.id, name: found.name };
      }

      const description = this.describeSearch(query, channelFilter?.name, author_id, has);
      console.log(`   🔍 Searching Discord messages: ${description}`);

      if (originalMessage && "send" in originalMessage.channel) {
        statusMessage = await originalMessage.channel.send(`🔍 *Searching ${description}...*`);
      }

      const params = new URLSearchParams();
      if (query) params.set("content", query.slice(0, 1024));
      if (channelFilter) params.append("channel_id", channelFilter.id);
      if (author_id) params.append("author_id", author_id);
      if (has) params.append("has", has);
      if (pinned !== undefined) params.set("pinned", String(pinned));
      params.set("sort_by", sort_by);
      params.set("sort_order", "desc");
      params.set("limit", String(Math.max(1, Math.min(limit, DISCORD_SEARCH_MAX_LIMIT))));
      params.set("offset", String(Math.max(0, Math.min(offset, DISCORD_SEARCH_MAX_OFFSET))));

      const response = await this.fetchWithIndexRetry(guild, params);
      const rawMessages = this.flattenMessages(response.messages);
      const total = response.total_results ?? rawMessages.length;

      console.log(`   ✅ Search returned ${rawMessages.length} of ${total} matches`);

      // Hydrate raw API payloads into discord.js Message objects so we can reuse
      // the shared formatter (nicknames, attachments, reactions, etc.)
      const formattedResults: string[] = [];
      for (const raw of rawMessages) {
        const formatted = await this.formatRawMessage(guild, raw, context.botId);
        if (formatted) formattedResults.push(formatted);
      }

      let content = `=== Search results for ${description} ===\n`;
      content += `Showing ${formattedResults.length} of ${total} matches`;
      if (offset > 0) content += ` (offset ${offset})`;
      if (response.doing_deep_historical_index) {
        content += "\n(Discord is still indexing older history; results may be incomplete)";
      }
      content += "\n\n";

      if (formattedResults.length === 0) {
        content += "No messages matched.";
      } else {
        content += formattedResults.join("\n\n");
        if (total > offset + formattedResults.length) {
          content += `\n\nMore results available: call again with offset=${
            offset + formattedResults.length
          }.`;
        }
      }

      if (statusMessage) {
        await statusMessage.edit(
          `✅ *Found ${total} match${total === 1 ? "" : "es"} for ${description}*`,
        );
      }

      return { content };
    } catch (error) {
      console.error("   ❌ Error searching Discord messages:", error);
      const errorText = error instanceof Error ? error.message : String(error);

      if (statusMessage) {
        await statusMessage.edit(`⚠️ *Search failed: ${errorText}*`);
      } else if (originalMessage && "send" in originalMessage.channel) {
        await originalMessage.channel.send(`⚠️ *Search failed: ${errorText}*`);
      }

      return {
        content: `Error searching Discord messages: ${errorText}\n\n⚠️ IMPORTANT: The search did not return results. Do not make up or guess what messages exist.`,
        error: true,
      };
    }
  }

  private describeSearch(
    query?: string,
    channelName?: string,
    authorId?: string,
    has?: string,
  ): string {
    const parts: string[] = [];
    if (query) parts.push(`"${query}"`);
    if (has) parts.push(`messages with ${has}`);
    if (authorId) parts.push(`from <@${authorId}>`);
    parts.push(channelName ? `in #${channelName}` : "across the server");
    return parts.join(" ");
  }

  /**
   * Discord returns 202 with retry_after while the guild's search index is warming up.
   * Retry a couple of times before giving up.
   */
  private async fetchWithIndexRetry(
    guild: Guild,
    params: URLSearchParams,
  ): Promise<SearchApiResponse> {
    const rest = guild.client.rest;
    const route = `/guilds/${guild.id}/messages/search` as const;

    for (let attempt = 0; attempt <= DISCORD_SEARCH_INDEX_RETRIES; attempt++) {
      const result = (await rest.get(route, { query: params })) as SearchApiResponse | null;

      // A 202 body carries retry_after and no messages
      const indexing = !result || (result.retry_after !== undefined && !result.messages);
      if (!indexing) {
        return result as SearchApiResponse;
      }

      if (attempt === DISCORD_SEARCH_INDEX_RETRIES) break;
      const waitMs = Math.min(
        (result?.retry_after ?? DISCORD_SEARCH_INDEX_RETRY_MS / 1000) * 1000,
        DISCORD_SEARCH_INDEX_RETRY_MS,
      );
      console.log(`   ⏳ Search index not ready, retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    throw new Error(
      "Discord's search index for this server isn't ready yet. Try again in a minute.",
    );
  }

  /**
   * The preview endpoint has returned both a flat array of messages and an array of
   * single-element arrays (one hit per group). Accept either.
   */
  private flattenMessages(messages: unknown): any[] {
    if (!Array.isArray(messages)) return [];
    return messages.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
  }

  private async formatRawMessage(guild: Guild, raw: any, botId: string): Promise<string | null> {
    if (!raw || typeof raw.id !== "string" || typeof raw.channel_id !== "string") {
      return null;
    }

    const channel = guild.channels.cache.get(raw.channel_id) ?? null;
    const channelLabel = channel ? `#${channel.name}` : `channel ${raw.channel_id}`;
    const header = `[${channelLabel}] (message ID: ${raw.id}, channel ID: ${raw.channel_id})`;

    // Prefer a real Message object so formatting matches read_discord_messages.
    // MessageManager._add is discord.js's internal payload-to-Message constructor;
    // it is typed private, so we go through `any`. cache=false keeps the search
    // results out of the channel's message cache.
    if (channel && "messages" in channel) {
      try {
        const manager = (channel as TextChannel).messages as any;
        const message = manager._add(raw, false) as Message;
        const body = await buildDiscordMessageRepresentation(message, botId, true);
        return `${header}\n${body}`;
      } catch (error) {
        console.log(`   ⚠️ Could not hydrate message ${raw.id}, using raw payload: ${error}`);
      }
    }

    // Fallback: minimal formatting straight from the payload
    const author = raw.author?.global_name || raw.author?.username || "unknown";
    const timestamp = raw.timestamp ? new Date(raw.timestamp).toLocaleString() : "unknown time";
    const text = raw.content || "[No text content]";
    return `${header}\n[${timestamp}] ${author}: ${text}`;
  }
}
