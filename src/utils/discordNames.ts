import { Client, Guild, GuildBasedChannel, Message, TextBasedChannel } from "discord.js";

const SNOWFLAKE_REGEX = /^\d{17,20}$/;
const MENTION_REGEX = /<(?<type>@[!&]?|#)(?<id>\d{17,20})>/g;

/**
 * Returns true if the string looks like a Discord snowflake ID
 */
export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_REGEX.test(value);
}

/**
 * Get the best human-readable name for a message author:
 * server nickname > global display name > username
 */
export async function getDisplayName(msg: Message): Promise<string> {
  if (msg.guild) {
    if (msg.member?.displayName) {
      return msg.member.displayName;
    }
    const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
    if (member?.displayName) {
      return member.displayName;
    }
  }
  return msg.author.displayName || msg.author.username;
}

/**
 * Replace raw Discord mentions (<@id>, <@!id>, <@&id>, <#id>) in message text with
 * readable names (@nickname, @role, #channel). Falls back to the raw mention when a
 * name cannot be resolved so nothing is silently lost.
 */
export async function resolveMentions(
  content: string,
  channel: TextBasedChannel,
  message?: Message,
): Promise<string> {
  if (!content || !content.includes("<")) {
    return content;
  }

  const client = channel.client;
  const guild = "guild" in channel ? channel.guild : null;
  const matches = Array.from(content.matchAll(MENTION_REGEX));
  if (matches.length === 0) {
    return content;
  }

  // Resolve every unique mention once, then substitute
  const replacements = new Map<string, string>();
  for (const match of matches) {
    const raw = match[0];
    if (replacements.has(raw)) continue;
    const type = match.groups!.type;
    const id = match.groups!.id;

    let resolved: string | null = null;
    switch (type) {
      case "@":
      case "@!":
        resolved = await resolveUserName(client, guild, id, message);
        break;
      case "@&":
        resolved = guild?.roles.cache.get(id)?.name ?? null;
        break;
      case "#":
        resolved = resolveChannelName(client, id);
        break;
    }

    if (resolved) {
      const prefix = type === "#" ? "#" : "@";
      replacements.set(raw, `${prefix}${resolved}`);
    }
  }

  return content.replace(MENTION_REGEX, (raw) => replacements.get(raw) ?? raw);
}

async function resolveUserName(
  client: Client,
  guild: Guild | null,
  userId: string,
  message?: Message,
): Promise<string | null> {
  // Mentioned members ship with the message payload, so check those first
  const mentionedMember = message?.mentions.members?.get(userId);
  if (mentionedMember) return mentionedMember.displayName;

  if (guild) {
    const cached = guild.members.cache.get(userId);
    if (cached) return cached.displayName;
    const fetched = await guild.members.fetch(userId).catch(() => null);
    if (fetched) return fetched.displayName;
  }

  const mentionedUser = message?.mentions.users.get(userId);
  if (mentionedUser) return mentionedUser.displayName;

  const user = client.users.cache.get(userId);
  return user ? user.displayName : null;
}

function resolveChannelName(client: Client, channelId: string): string | null {
  const channel = client.channels.cache.get(channelId);
  if (channel && "name" in channel && channel.name) {
    return channel.name;
  }
  return null;
}

/**
 * Find a guild channel by ID or by name (case-insensitive, with or without leading #).
 * Returns null when nothing matches.
 */
export function findChannelByNameOrId(guild: Guild, nameOrId: string): GuildBasedChannel | null {
  const trimmed = nameOrId.trim();
  if (isSnowflake(trimmed)) {
    return guild.channels.cache.get(trimmed) ?? null;
  }

  const wanted = trimmed.replace(/^#/, "").toLowerCase();
  const exact = guild.channels.cache.find((c) => c.name.toLowerCase() === wanted);
  if (exact) return exact;

  // Allow loose matches like "general" -> "general-chat" if unambiguous
  const partial = guild.channels.cache.filter((c) => c.name.toLowerCase().includes(wanted));
  return partial.size === 1 ? partial.first()! : null;
}
