import { Message, Guild, GuildChannel, ChannelType, GuildBasedChannel } from "discord.js";
import { ToolHandler, ToolInput, ToolContext, ToolResult, ToolSchema } from "../types/tool.types";

interface ListDiscordChannelsInput {
  guild_id?: string;
  include_categories?: boolean;
}

export class ListDiscordChannelsHandler implements ToolHandler {
  name = "list_discord_channels";
  description = "List all channels in a Discord guild";
  input_schema: ToolSchema = {
    type: "object",
    properties: {
      guild_id: {
        type: "string",
        description: "The guild ID to list channels from. If not provided, uses the current guild",
      },
      include_categories: {
        type: "boolean",
        description: "Whether to include category channels (default: false)",
      },
    },
    additionalProperties: false,
  };

  validateInput(input: ToolInput): boolean {
    const typed = input as ListDiscordChannelsInput;

    // guild_id is optional (string if provided)
    if (typed.guild_id !== undefined && typeof typed.guild_id !== "string") {
      return false;
    }

    // include_categories is optional (boolean if provided)
    if (typed.include_categories !== undefined && typeof typed.include_categories !== "boolean") {
      return false;
    }

    return true;
  }

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let statusMessage: Message | undefined;
    const originalMessage = context.message;

    try {
      const { guild_id, include_categories = false } = input as ListDiscordChannelsInput;

      console.log(
        `   📋 Listing Discord channels${
          guild_id ? ` from guild ${guild_id}` : " from current guild"
        }`,
      );

      // Send initial status message to Discord
      if (originalMessage && "send" in originalMessage.channel) {
        statusMessage = await originalMessage.channel.send(`📋 *Listing available channels...*`);
      }

      // Get the Discord client and guild
      const client = originalMessage?.client;
      if (!client) {
        throw new Error("Discord client not available");
      }

      // Determine which guild to list channels from
      let targetGuild: Guild;
      if (guild_id) {
        const guild = client.guilds.cache.get(guild_id);
        if (!guild) {
          throw new Error(`Guild ${guild_id} not found`);
        }
        targetGuild = guild;
      } else if (originalMessage?.guild) {
        targetGuild = originalMessage.guild;
      } else {
        throw new Error("No guild specified and current message is not from a guild");
      }

      // Get all channels from the guild
      const channels = targetGuild.channels.cache;

      // Format channel list
      let channelList = `=== Channels in ${targetGuild.name} ===\n\n`;

      // Group channels by category
      const categories = new Map<string | null, GuildBasedChannel[]>();

      channels.forEach((channel) => {
        if (channel.type === ChannelType.GuildCategory && include_categories) {
          // Category channel
          if (!categories.has(channel.id)) {
            categories.set(channel.id, []);
          }
        } else if (channel.parent) {
          // Channel with a category
          const categoryId = channel.parent.id;
          if (!categories.has(categoryId)) {
            categories.set(categoryId, []);
          }
          categories.get(categoryId)!.push(channel);
        } else if (channel.type !== ChannelType.GuildCategory) {
          // Channel without category
          if (!categories.has(null)) {
            categories.set(null, []);
          }
          categories.get(null)!.push(channel);
        }
      });

      // Format output
      const channelTypeMap: { [key: number]: string } = {
        [ChannelType.GuildText]: "📝",
        [ChannelType.GuildVoice]: "🔊",
        [ChannelType.GuildCategory]: "📁",
        [ChannelType.GuildAnnouncement]: "📢",
        [ChannelType.GuildStageVoice]: "🎭",
        [ChannelType.GuildForum]: "💬",
      };

      // Show uncategorized channels first
      if (categories.has(null)) {
        channelList += "**Uncategorized Channels:**\n";
        const uncategorized = categories.get(null)!;
        uncategorized.sort((a, b) => a.name.localeCompare(b.name));
        uncategorized.forEach((channel) => {
          const emoji = channelTypeMap[channel.type] || "📌";
          channelList += `${emoji} #${channel.name} (ID: ${channel.id})\n`;
        });
        channelList += "\n";
      }

      // Show categorized channels
      channels.forEach((category) => {
        if (category.type === ChannelType.GuildCategory) {
          const categoryChannels = categories.get(category.id);
          if (categoryChannels && categoryChannels.length > 0) {
            channelList += `**📁 ${category.name}:**\n`;
            categoryChannels.sort((a, b) => {
              const aPos = "position" in a ? a.position : 0;
              const bPos = "position" in b ? b.position : 0;
              return aPos - bPos;
            });
            categoryChannels.forEach((channel) => {
              const emoji = channelTypeMap[channel.type] || "📌";
              channelList += `  ${emoji} #${channel.name} (ID: ${channel.id})\n`;
            });
            channelList += "\n";
          }
        }
      });

      // Add summary
      const totalChannels = Array.from(categories.values()).reduce(
        (sum, channels) => sum + channels.length,
        0,
      );
      channelList += `\n**Total: ${totalChannels} channels**`;

      // Edit the status message to show completion
      if (statusMessage) {
        await statusMessage.edit(`✅ *Listed ${totalChannels} channels from ${targetGuild.name}*`);
      }

      console.log(`   ✅ Listed ${totalChannels} channels from ${targetGuild.name}`);

      return {
        content: channelList,
      };
    } catch (error) {
      console.error("   ❌ Error listing Discord channels:", error);

      // Edit status message to show error
      if (statusMessage) {
        await statusMessage.edit(`⚠️ *Failed to list channels: ${error}*`);
      } else if (originalMessage && "send" in originalMessage.channel) {
        await originalMessage.channel.send(`⚠️ *Failed to list channels: ${error}*`);
      }

      return {
        content: `Error listing Discord channels: ${error}`,
        error: true,
      };
    }
  }
}
