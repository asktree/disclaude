import { Message } from "discord.js";
import { getDisplayName, resolveMentions } from "./discordNames";

/**
 * Builds a rich text representation of a Discord message with all metadata
 * For assistant messages, returns only the content without metadata
 * For user messages, includes comprehensive metadata about all embedded content
 */
export async function buildDiscordMessageRepresentation(
  msg: Message,
  botId: string,
  includeContent: boolean = true,
): Promise<string> {
  // For assistant messages, just return the content without any metadata
  if (msg.author.id === botId) {
    return msg.content || "[No text content]";
  }

  // For user messages, include all metadata
  let content = "";

  // Add username and timestamp
  const timestamp = msg.createdAt.toLocaleString();

  // Server nickname > global display name > username
  const displayName = await getDisplayName(msg);

  content += `[${timestamp}] ${displayName}`;

  // Add bot indicator if it's a bot
  if (msg.author.bot && msg.author.id !== botId) {
    content += " [BOT]";
  }

  // Add message content if requested, with <@id>/<#id> mentions turned into names
  if (includeContent) {
    if (msg.content) {
      const readableContent = await resolveMentions(msg.content, msg.channel, msg);
      content += `: ${readableContent}`;
    } else if (msg.attachments.size === 0 && msg.embeds.length === 0 && msg.stickers.size === 0) {
      content += ": [No text content]";
    } else {
      content += ":"; // Just username for attachment-only messages
    }
  } else {
    content += ":";
  }

  // Add detailed attachment information including images
  if (msg.attachments.size > 0) {
    const attachments = Array.from(msg.attachments.values());
    content += "\n  📎 Attachments:";

    for (const attachment of attachments) {
      content += `\n    • ${attachment.name}`;
      content += `\n      - Type: ${attachment.contentType || "unknown"}`;
      content += `\n      - Size: ${(attachment.size / 1024).toFixed(2)}KB`;
      content += `\n      - URL: ${attachment.url}`;

      // Add image-specific metadata
      if (
        attachment.contentType?.startsWith("image/") ||
        attachment.name?.match(/\.(png|jpg|jpeg|gif|webp|avif|bmp|tiff)$/i)
      ) {
        if (attachment.width && attachment.height) {
          content += `\n      - Dimensions: ${attachment.width}x${attachment.height}`;
        }
        content += `\n      - [Image attachment]`;
      }

      // Add proxy URL if available (CDN cached version)
      if (attachment.proxyURL && attachment.proxyURL !== attachment.url) {
        content += `\n      - Proxy URL: ${attachment.proxyURL}`;
      }

      // Add description if available (alt text)
      if (attachment.description) {
        content += `\n      - Description: ${attachment.description}`;
      }

      // Add spoiler indicator
      if (attachment.spoiler) {
        content += `\n      - [SPOILER]`;
      }
    }
  }

  // Add embed information
  if (msg.embeds.length > 0) {
    content += `\n  🔗 Embeds (${msg.embeds.length}):`;
    for (const embed of msg.embeds) {
      if (embed.title) content += `\n    • Title: ${embed.title}`;
      if (embed.description) content += `\n      Description: ${embed.description}`;
      if (embed.url) content += `\n      URL: ${embed.url}`;
      if (embed.author?.name) content += `\n      Author: ${embed.author.name}`;
      if (embed.thumbnail?.url) content += `\n      Thumbnail: ${embed.thumbnail.url}`;
      if (embed.image?.url) content += `\n      Image: ${embed.image.url}`;
      if (embed.video?.url) content += `\n      Video: ${embed.video.url}`;
      if (embed.footer?.text) content += `\n      Footer: ${embed.footer.text}`;
      if (embed.fields.length > 0) {
        content += `\n      Fields (${embed.fields.length}):`;
        for (const field of embed.fields) {
          content += `\n        - ${field.name}: ${field.value.substring(
            0,
            50,
          )}${field.value.length > 50 ? "..." : ""}`;
        }
      }
    }
  }

  // Add sticker information
  if (msg.stickers.size > 0) {
    const stickers = Array.from(msg.stickers.values());
    content += `\n  🎨 Stickers: ${stickers.map((s) => s.name).join(", ")}`;
  }

  // Add reaction information
  if (msg.reactions.cache.size > 0) {
    const reactions = Array.from(msg.reactions.cache.values());
    content += `\n  👍 Reactions: ${reactions
      .map((r) => `${r.emoji.toString()} x${r.count}`)
      .join(", ")}`;
  }

  // Add reply information
  if (msg.reference && msg.reference.messageId) {
    content += `\n  ↩️ Replying to message ${msg.reference.messageId}`;
  }

  // Add thread information
  if (msg.thread) {
    content += `\n  🧵 Thread: ${msg.thread.name} (${msg.thread.messageCount} messages)`;
  }

  // Add poll information if available
  if ((msg as any).poll) {
    const poll = (msg as any).poll;
    content += `\n  📊 Poll: ${poll.question}`;
    if (poll.answers) {
      content += `\n    Options: ${poll.answers.map((a: any) => a.text).join(", ")}`;
    }
  }

  // Add component information (buttons, select menus, etc.)
  if (msg.components.length > 0) {
    content += `\n  🎛️ Interactive components: ${msg.components.length} row(s)`;
  }

  // Add edit indicator
  if (msg.editedAt) {
    content += `\n  ✏️ Edited at ${msg.editedAt.toLocaleString()}`;
  }

  // Add pinned indicator
  if (msg.pinned) {
    content += `\n  📌 Pinned message`;
  }

  // Add TTS indicator
  if (msg.tts) {
    content += `\n  🔊 Text-to-speech message`;
  }

  // Add message flags if any special flags are set
  if (msg.flags && msg.flags.bitfield > 0) {
    const flagNames = [];
    if (msg.flags.has("Crossposted")) flagNames.push("Crossposted");
    if (msg.flags.has("IsCrosspost")) flagNames.push("Is Crosspost");
    if (msg.flags.has("SuppressEmbeds")) flagNames.push("Embeds Suppressed");
    if (msg.flags.has("SourceMessageDeleted")) flagNames.push("Source Deleted");
    if (msg.flags.has("Urgent")) flagNames.push("Urgent");
    if (msg.flags.has("HasThread")) flagNames.push("Has Thread");
    if (msg.flags.has("Ephemeral")) flagNames.push("Ephemeral");
    if (msg.flags.has("Loading")) flagNames.push("Loading");

    if (flagNames.length > 0) {
      content += `\n  🚩 Flags: ${flagNames.join(", ")}`;
    }
  }

  return content;
}
