import { Message, GuildMember } from "discord.js";
import { ToolHandler, ToolInput, ToolContext, ToolResult, ToolSchema } from "../types/tool.types";
import { isSnowflake } from "../utils/discordNames";
import { FIND_USER_MAX_RESULTS } from "../constants";

interface FindDiscordUserInput {
  name: string;
}

/**
 * Looks up server members by nickname, display name, or username so Claude can
 * turn "messages from Sam" into an author_id for search, or confirm who someone is.
 */
export class FindDiscordUserHandler implements ToolHandler {
  name = "find_discord_user";
  description =
    "Find a member of this Discord server by nickname, display name, username, or user ID. Returns their user ID (needed for search_discord_messages author_id), names, and roles. Use this before searching by author.";
  input_schema: ToolSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Nickname, display name, username, or user ID to look up. Partial names are fine.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  };

  validateInput(input: ToolInput): boolean {
    const typed = input as FindDiscordUserInput;
    return typeof typed.name === "string" && typed.name.trim().length > 0;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let statusMessage: Message | undefined;
    const originalMessage = context.message;

    try {
      const name = (input as FindDiscordUserInput).name.trim();
      const guild = originalMessage?.guild;
      if (!guild) {
        throw new Error("User lookup only works inside a server, not in DMs");
      }

      console.log(`   👤 Looking up user "${name}" in ${guild.name}`);

      if (originalMessage && "send" in originalMessage.channel) {
        statusMessage = await originalMessage.channel.send(`👤 *Looking up ${name}...*`);
      }

      let matches: GuildMember[] = [];

      if (isSnowflake(name)) {
        const member = await guild.members.fetch(name).catch(() => null);
        if (member) matches = [member];
      } else {
        // Discord's member search matches username and nickname prefixes server-side
        const cleaned = name.replace(/^@/, "");
        const fetched = await guild.members.fetch({ query: cleaned, limit: FIND_USER_MAX_RESULTS });
        matches = Array.from(fetched.values());

        // Also scan the cache for substring matches the prefix search misses
        if (matches.length < FIND_USER_MAX_RESULTS) {
          const lower = cleaned.toLowerCase();
          const seen = new Set(matches.map((m) => m.id));
          guild.members.cache.forEach((member) => {
            if (seen.has(member.id) || matches.length >= FIND_USER_MAX_RESULTS) return;
            const haystack = [member.displayName, member.user.displayName, member.user.username]
              .join(" ")
              .toLowerCase();
            if (haystack.includes(lower)) {
              matches.push(member);
              seen.add(member.id);
            }
          });
        }
      }

      if (matches.length === 0) {
        if (statusMessage) await statusMessage.edit(`🤷 *No member found matching "${name}"*`);
        return {
          content: `No server member matched "${name}". Check the spelling or try part of their name.`,
        };
      }

      let content = `=== Members matching "${name}" in ${guild.name} ===\n\n`;
      for (const member of matches) {
        content += `• ${member.displayName} (user ID: ${member.id})\n`;
        content += `  - Username: ${member.user.username}\n`;
        if (member.user.displayName !== member.user.username) {
          content += `  - Global display name: ${member.user.displayName}\n`;
        }
        if (member.nickname) content += `  - Server nickname: ${member.nickname}\n`;
        if (member.user.bot) content += `  - [BOT]\n`;
        const roles = member.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name);
        if (roles.length > 0) content += `  - Roles: ${roles.join(", ")}\n`;
        if (member.joinedAt) content += `  - Joined: ${member.joinedAt.toLocaleDateString()}\n`;
      }

      if (statusMessage) {
        await statusMessage.edit(
          `✅ *Found ${matches.length} member${matches.length === 1 ? "" : "s"} matching "${name}"*`,
        );
      }

      return { content };
    } catch (error) {
      console.error("   ❌ Error finding Discord user:", error);
      const errorText = error instanceof Error ? error.message : String(error);

      if (statusMessage) {
        await statusMessage.edit(`⚠️ *User lookup failed: ${errorText}*`);
      } else if (originalMessage && "send" in originalMessage.channel) {
        await originalMessage.channel.send(`⚠️ *User lookup failed: ${errorText}*`);
      }

      return { content: `Error finding Discord user: ${errorText}`, error: true };
    }
  }
}
